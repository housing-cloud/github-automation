# event-automation

A Bun + Hono webhook service that mirrors **preview-stacks (pstack)** preview
deployments onto GitHub pull requests, and lets reviewers drive them back with
`@cloudybot` commands. The engine — webhook intake, signature verification,
normalization, authorization, matcher/handler dispatch — lives in the published,
framework-agnostic **`@samyx/github-automation-suite`**; this app supplies HOU's
config, rules and the pstack reporter.

```
src/
├── index.ts                 # Bun entry: loadEnv -> createEventAutomation -> { port, fetch }
├── app.ts                   # wires the github + preview-stacks plugins + rules -> Hono
├── rules.ts                 # pstack events -> the reporter; @cloudybot -> commands
├── env.ts                   # Zod-validated environment -> AppEnv
├── flow-runs/sqlite.ts      # persistent FlowRunStore for coordinator + dashboard
├── github/checks.ts         # check-run + PR-comment upserts (create-or-update)
├── github/octokit.ts        # the shared installation client
├── pstack/reporter.ts       # pstack events -> 3 check runs + a tracked PR comment
├── pstack/client.ts         # @samyx/preview-stacks-client: live URLs, readiness, verify
├── pstack/commands.ts       # @cloudybot recheck / restart / redeploy
├── pstack/help.ts           # the one-time usage comment
├── pstack/ingress.ts        # pstack webhook ingress, verified by the client
└── pstack/stack.ts          # stack-name -> PR number, container-name -> service
```

## What it does

For a preview stack named `pr-<number>`, the PR gets three check runs and two
comments:

| Check run | Passes when | Fails when |
| --- | --- | --- |
| `pstack/stack` | `stack.ready` — every container reached ready | `stack.failed` / `stack.timedout`, or the `up` job failed, leaked or was cancelled |
| `pstack/db-seed` | the `db-seed` container reports ready (for a one-shot container that means **exited 0**) | `container.start-failed`, or the stack settled without it becoming ready |
| `pstack/web` | the `web` container reports ready | `container.start-failed`, or it is still in `pendingContainers` when the stack times out |

The watched services come from `PSTACK_SERVICES` (default `db-seed,web`). Once
the stack check settles, a single **"Preview stack" comment** carries the status,
the container counts, the failing/pending container names and the per-service
preview URLs. It is edited in place, never re-posted.

Alongside it, a **"Preview stack bot" comment** is posted once when the checks
first open — which is when a reviewer first sees three pending checks and wonders
what they are — explaining the checks and the commands. It is never edited, so it
stays a stable reference while the status comment churns.

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

## The control-plane API (optional)

Setting `PSTACK_API_URL` gives the service a **pull** direction, through
`@samyx/preview-stacks-client`. Without it everything above still works; the
service is simply push-only and can ask pstack nothing.

**Real preview URLs.** The comment's links come from the stack's live Traefik
routing table rather than the `<service>-<stack>.<domain>` pattern. That pattern
is only pstack's *default* router rule, so a spec with its own rule, port or
domain would otherwise get an authoritative-looking 404. Routed services outside
`PSTACK_SERVICES` are listed too. The table is read just before each comment is
written, because routers appear as containers come up. `PSTACK_PREVIEW_DOMAIN`
remains the fallback.

**`@cloudybot` commands.** `recheck`, `restart` and `redeploy` — in escalating
order of disruption — given as a PR comment or as a `cloudy-*` label. Four
properties shape the implementation:

1. **The work outlives the webhook.** A redeploy takes minutes and a delivery
   gets seconds, so a command is accepted synchronously — the checks reopening
   *is* the acknowledgement — and runs detached. `dispose()` drains them.
2. **The verdict is expressed as pstack events.** A settled `Readiness` is
   projected onto the same `container.*` + `stack.*` signals the webhooks carry,
   so the reducer has one way to settle a check rather than two. That is what
   lets `recheck` repair a check left pending by a missed delivery.
3. **One command per stack at a time.** pstack rejects a second job on a busy
   stack with a 409, and two waits racing over the same checks would fight.
4. **Still converging is not a verdict.** When the wait expires with the stack
   mid-flight the checks stay pending for pstack's own delivery to settle,
   rather than reporting a false failure on a slow stack.

The rules are registered only when the API is configured: a bot that
acknowledges `@cloudybot redeploy` and cannot redeploy anything is worse than
one that stays quiet. Bot-authored comments are ignored, so the help comment's
own table cannot trigger it.

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
  log, handler log, persisted flow runs, and config. Same token guard as `/events`.

## Flow-run persistence

The suite does not publish a SQLite adapter, so this app implements its
`FlowRunStore` interface with Bun's built-in `bun:sqlite`. The same store is
passed to `RxjsCoordinator` and the dashboard's `flowRuns` option. History is
retained across restarts and bounded by `FLOW_RUN_LIMIT`. As in the suite's
in-memory store, a key's display sequence resets after all of its retained runs
have been evicted.

The coordinator itself remains in-memory. A flow that was still active when its
owning process stops cannot resume, so the SQLite adapter marks it `expired`
during graceful shutdown. Process leases also expire abandoned rows after a
crash without incorrectly expiring rows owned by an overlapping replacement.

The production image writes `/data/flow-runs.sqlite`. Mount a persistent
Dokploy volume at `/data`; the container entrypoint fixes the mounted directory's
ownership before dropping to the `bun` user. Without that volume, history
survives process restarts inside one container but not container replacement.
Run one steady-state replica: pstack reporter state and the RxJS coordinator
are process-local. The SQLite leases only prevent active history rows from being
expired during a short rolling-deployment overlap.

## Security

Every pstack delivery carries
`x-pstack-signature: sha256=HMAC(secret, timestamp + "." + rawBody)`, verified
over the raw bytes with the timestamp inside the signed material, so the replay
window genuinely bounds replays. Only a **`webhook`-type** notifier sends that
envelope — `slack`/`discord` notifiers send unsigned prose and are rejected.

That check is the client's own `verifyWebhook`, wrapped in `pstack/ingress.ts`.
The suite's plugin ships an equivalent HMAC check, but its `verify` returns a
bare boolean, which discards two things the receiver half of the contract
reports: **why** a delivery was rejected (a stale timestamp is a clock skew, not
an attack) and **`x-pstack-redelivery`**, the header pstack sets when an operator
replays a past delivery — legitimate traffic worth logging as such. The plugin's
`parseEventType`/`normalize` are kept, so rules read the same event data as
before.

GitHub deliveries are verified as `x-hub-signature-256`, and events are further
restricted to `GITHUB_ALLOWED_REPOS`.

The checks cleanup webhook accepts its dedicated bearer secret in the
`Authorization` header only. It never accepts the secret in the URL.

## Configuration

See [`REQUIREMENTS.md`](./REQUIREMENTS.md) for the full list of secrets and
config values, where each one comes from, and the GitHub App permissions the
check runs and PR comments need.
