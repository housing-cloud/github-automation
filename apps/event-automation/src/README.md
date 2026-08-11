# event-automation

A Bun + Hono webhook service that mirrors **preview-stacks (pstack)** preview
deployments onto GitHub pull requests. The engine — webhook intake, signature
verification, normalization, authorization, matcher/handler dispatch — lives in
the published, framework-agnostic **`@samyx/github-automation-suite`**; this app
supplies HOU's config, rules and the pstack reporter.

```
src/
├── index.ts                 # Bun entry: loadEnv -> createEventAutomationApp -> { port, fetch }
├── app.ts                   # wires the github + preview-stacks plugins + rules -> Hono
├── rules.ts                 # pstack events -> the reporter; PR closed -> release state
├── env.ts                   # Zod-validated environment -> AppEnv
├── github/checks.ts         # check-run + PR-comment upserts (create-or-update)
├── github/octokit.ts        # the shared installation client
├── pstack/reporter.ts       # pstack events -> 3 check runs + a tracked PR comment
└── pstack/stack.ts          # stack-name -> PR number, container-name -> service
```

## What it does

For a preview stack named `pr-<number>`, the PR gets three check runs and one
comment:

| Check run | Passes when | Fails when |
| --- | --- | --- |
| `pstack/stack` | `stack.ready` — every container reached ready | `stack.failed` / `stack.timedout`, or the `up` job failed, leaked or was cancelled |
| `pstack/db-seed` | the `db-seed` container reports ready (for a one-shot container that means **exited 0**) | `container.start-failed`, or the stack settled without it becoming ready |
| `pstack/web` | the `web` container reports ready | `container.start-failed`, or it is still in `pendingContainers` when the stack times out |

The watched services come from `PSTACK_SERVICES` (default `db-seed,web`). Once
the stack check settles, a single **"Preview stack" comment** carries the status,
the container counts, the failing/pending container names and the per-service
preview URLs. It is edited in place, never re-posted.

## Three details that shape the implementation

Each is enforced by a test built on real captured payloads:

1. **The stack name is the only PR link.** For `job.*`, `stack.*` and the
   readiness `container.*` events the payload carries `stack` and nothing else —
   no deployment id, no repo, no commit. (The plugin's own `prNumber` comes from
   `data.id`, which only `deployment.*` and operator-driven `container.*` events
   have.) So the PR number is parsed from `pr-<N>` in the stack name and the head
   SHA is fetched from the GitHub API, because a check run must hang off a commit.
2. **A green job is not a running app.** `job.succeeded` for an `up` means the
   commands ran; `compose up -d` returns once containers are *created*. It moves
   the check to “Deployment completed; checking readiness” but keeps it pending.
   Only the readiness watch decides, ending in exactly one of `stack.ready`,
   `stack.failed` or `stack.timedout`.
3. **A container that never starts may emit no event of its own.** In a real
   `stack.timedout` the only trace of the failure was
   `pendingContainers: ["pr-16828-web-1"]`. The terminal `stack.*` event
   therefore also settles any service check still pending — otherwise the `web`
   check would spin forever and block the PR.

All three checks are opened `in_progress` on the first event for a stack: a check
that only appears once it passes is indistinguishable from no check at all. The
reporter holds per-stack state, serializes its GitHub writes, and skips any check
whose rendered content has not changed.

The state is in-memory, which is the right shape here — the checks and the
comment live on GitHub, which is the durable store, and a restart simply re-opens
them on the next event. `pull_request.closed` releases a PR's state so a
long-running instance does not accumulate one entry per PR it ever saw.

## Routes

- `GET /` — service index (auto-introspected route list, HTML);
  `GET /discovery.json` is the same list as JSON.
- `POST /webhooks/github` — GitHub App webhook ingress.
- `POST /webhooks/preview-stacks` — pstack ingress, HMAC-verified with a replay
  window (`PSTACK_TOLERANCE_MS`, default 5 minutes).
- `POST /webhooks/pstack/checks/clear` — operator-only cleanup webhook. Authenticate
  with `Authorization: Bearer $PSTACK_CHECKS_WEBHOOK_SECRET`; send
  `{"stack":"pr-16828"}` for one stack or `{"all":true}` for every open PR. GitHub has
  no delete-check-suite API, so clearing completes every `pstack/*` run as
  `skipped` and drops matching in-memory reporter state. Specific cleanup accepts
  only the canonical `pr-<number>` name because a GitHub check suite is scoped to
  the App and commit, not to a prefixed pstack deployment.
- `GET /health` — liveness probe.
- `GET /previews` — the preview stacks currently mirrored onto checks.
- `GET /events` (HTML table of received webhooks) and `GET /events/json`. The
  event log is an in-memory LRU (size `EVENT_LOG_LIMIT`, default 500); set
  `EVENT_LOG_TOKEN` to gate it behind `Authorization: Bearer <token>` or
  `?token=<token>` (unset = public).
- `GET /dashboard` — Vue dashboard (`@samyx/gha-ui`): rules→handlers flow, event
  log, handler log, and config. Same token guard as `/events`.

## Security

Every pstack delivery carries
`x-pstack-signature: sha256=HMAC(secret, timestamp + "." + rawBody)`, verified
over the raw bytes with the timestamp inside the signed material, so the replay
window genuinely bounds replays. Only a **`webhook`-type** notifier sends that
envelope — `slack`/`discord` notifiers send unsigned prose and are rejected.

GitHub deliveries are verified as `x-hub-signature-256`, and events are further
restricted to `GITHUB_ALLOWED_REPOS`.

The checks cleanup webhook accepts its dedicated bearer secret in the
`Authorization` header only. It never accepts the secret in the URL.

## Configuration

See [`REQUIREMENTS.md`](./REQUIREMENTS.md) for the full list of secrets and
config values, where each one comes from, and the GitHub App permissions the
check runs and PR comments need.
