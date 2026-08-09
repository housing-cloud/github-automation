# event-automation

A Bun + Hono webhook service that mirrors **Dokploy preview deployments** onto
GitHub pull requests. The engine — webhook intake, signature verification,
normalization, authorization, matcher/handler dispatch — lives in the published,
framework-agnostic **`@samyx/github-automation-suite`**; this app supplies HOU's
config, rules and the preview tracker.

```
src/
├── index.ts                 # Bun entry: loadEnv -> createEventAutomationApp -> { port, fetch }
├── app.ts                   # wires github + dokploy plugins + rules + tracker -> Hono
├── rules.ts                 # PR opened/sync/reopened -> track the preview; dokploy failure -> Slack
├── env.ts                   # Zod-validated environment -> AppEnv
├── dokploy/client.ts        # Dokploy tRPC-over-REST client (preview status, deep links)
├── github/checks.ts         # check-run + PR-comment upserts (create-or-update)
├── github/octokit.ts        # the shared installation client
└── preview/tracker.ts       # the 30s polling loop: Dokploy status -> check run + comment
```

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

## Why it polls

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
- `GET /health` — liveness probe.
- `GET /previews` — the preview deployments currently being polled.
- `GET /events` (HTML table of received webhooks) and `GET /events/json`. The
  event log is an in-memory LRU (size `EVENT_LOG_LIMIT`, default 500); set
  `EVENT_LOG_TOKEN` to gate it behind `Authorization: Bearer <token>` or
  `?token=<token>` (unset = public).
- `GET /dashboard` — Vue dashboard (`@samyx/gha-ui`): rules→handlers flow, event
  log, handler log, and config. Same token guard as `/events`.

## Security note: Dokploy webhooks are unsigned

Dokploy's Custom/Webhook channel POSTs plain JSON with **no signature**, but it
does let you add custom headers. `DOKPLOY_WEBHOOK_TOKEN` is therefore compared
in constant time against the `x-webhook-token` header, which must be configured
on the Dokploy notification. Without it, anyone who learned the URL could post
events.

## Configuration

See [`REQUIREMENTS.md`](./REQUIREMENTS.md) for the full list of secrets and
config values, where each one comes from, and the GitHub App permissions the
check runs and PR comments need.
