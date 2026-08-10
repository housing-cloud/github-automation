# event-automation

A Bun + Hono webhook service that mirrors **preview deployments** onto GitHub
pull requests, from two sources: **Dokploy** applications and
**preview-stacks (pstack)** compose stacks. The engine — webhook intake,
signature verification, normalization, authorization, matcher/handler dispatch —
lives in the published, framework-agnostic
**`@samyx/github-automation-suite`**; this app supplies HOU's config, rules, the
Dokploy tracker and the pstack reporter.

```
src/
├── index.ts                 # Bun entry: loadEnv -> createEventAutomationApp -> { port, fetch }
├── app.ts                   # wires github + dokploy + pstack plugins + rules -> Hono
├── rules.ts                 # PR events -> Dokploy tracker; pstack events -> pstack reporter
├── env.ts                   # Zod-validated environment -> AppEnv
├── dokploy/client.ts        # Dokploy tRPC-over-REST client (preview status, deep links)
├── github/checks.ts         # check-run + PR-comment upserts (create-or-update)
├── github/octokit.ts        # the shared installation client
├── preview/tracker.ts       # the 30s polling loop: Dokploy status -> check run + comment
├── pstack/reporter.ts       # pstack events -> 3 check runs + a tracked PR comment
└── pstack/stack.ts          # stack-name -> PR number, container-name -> service
```

## The two sources

| | Dokploy | pstack |
| --- | --- | --- |
| Ingress | `POST /webhooks/dokploy` (unsigned; shared header token) | `POST /webhooks/preview-stacks` (HMAC-signed) |
| Trigger | the GitHub `pull_request` webhook | pstack's own event stream |
| Truth | polled from `previewDeployment.all` every 30s | pushed, event by event |
| PR link | the PR webhook that started the loop | parsed from the stack name `pr-<N>` |
| Output | `dokploy/<app> (preview)` check + a comment | `pstack/stack`, `pstack/db-seed`, `pstack/web` checks + a comment |

## What it does

1. **A PR is opened** (or synchronized / reopened). Dokploy's own GitHub
   receiver queues a preview deployment; this service posts an **`in_progress`
   check run** on the PR head commit right away.
2. **A PR comment** carries the preview URL and the deployment details (Dokploy
   instance, application, branch, commit, preview app name, expiry). It is
   *edited in place* on every change, never re-posted.
3. **The check settles**: a preview that reaches `done` marks the check
   **success**, one that reaches `error` marks it **failure**. A preview that
   never reports within `PREVIEW_TIMEOUT_MS` marks it **timed_out**.

## The pstack path

pstack pushes a rich event stream, so no polling is needed — but three details
shape the implementation, and each is enforced by a test built on real captured
payloads:

1. **The stack name is the only PR link.** For `job.*`, `stack.*` and the
   readiness `container.*` events the payload carries `stack` and nothing else —
   no deployment id, no repo, no commit. (The plugin's own `prNumber` comes from
   `data.id`, which only `deployment.*` and operator-driven `container.*` events
   have.) So the PR number is parsed from `pr-<N>` in the stack name and the head
   SHA is fetched from the GitHub API.
2. **A green job is not a running app.** `job.succeeded` for an `up` means the
   commands ran; `compose up -d` returns once containers are *created*. Only the
   readiness watch decides, ending in exactly one of `stack.ready`,
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

## Why the Dokploy path polls

Dokploy's `Notifications → Custom/Webhook` channel only emits org-wide
`build.success` / `build.error` events. Those name a project and an application
— **never a pull request** — so a webhook can say *something* finished, not
*which PR's preview* did. The authoritative per-PR state lives in Dokploy's
`previewDeployment.all` endpoint, so the tracker reads it back every 30 seconds
(`PREVIEW_POLL_INTERVAL_MS`) until the preview settles or times out.

This is exactly the "compensate for webhook deficiencies by polling" pattern:
the GitHub `pull_request` webhook is the *trigger*, the Dokploy REST API is the
*source of truth*. Because the service is a long-running container, the loop
simply lives in-process; it is keyed per `(repo, PR, head SHA)`, so a new push
supersedes the previous loop rather than racing it. Nothing is durable across a
restart — a restarted service re-tracks on the next PR webhook.

## Routes

- `GET /` — service index (auto-introspected route list, HTML);
  `GET /discovery.json` is the same list as JSON.
- `POST /webhooks/github` — GitHub App webhook ingress.
- `POST /webhooks/dokploy` — Dokploy notification ingress (see security below).
- `POST /webhooks/preview-stacks` — pstack ingress, HMAC-verified with a replay
  window (`PSTACK_TOLERANCE_MS`, default 5 minutes).
- `GET /health` — liveness probe.
- `GET /previews` — the Dokploy previews currently being polled, plus the pstack
  stacks currently mirrored onto checks.
- `GET /events` (HTML table of received webhooks) and `GET /events/json`. The
  event log is an in-memory LRU (size `EVENT_LOG_LIMIT`, default 500); set
  `EVENT_LOG_TOKEN` to gate it behind `Authorization: Bearer <token>` or
  `?token=<token>` (unset = public).
- `GET /dashboard` — Vue dashboard (`@samyx/gha-ui`): rules→handlers flow, event
  log, handler log, and config. Same token guard as `/events`.

## Security note: pstack signs, Dokploy does not

Dokploy's Custom/Webhook channel POSTs plain JSON with **no signature**, but it
does let you add custom headers. `DOKPLOY_WEBHOOK_TOKEN` is therefore compared
in constant time against the `x-webhook-token` header, which must be configured
on the Dokploy notification. Without it, anyone who learned the URL could post
events.

## Configuration

See [`REQUIREMENTS.md`](./REQUIREMENTS.md) for the full list of secrets and
config values, where each one comes from, and the GitHub App permissions the
check runs and PR comments need.
