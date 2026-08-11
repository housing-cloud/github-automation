# event-automation — configuration requirements

Everything the service needs before it can run, and where each value comes from.
Items marked **REQUIRED** are validated at startup: the process refuses to boot
without them.

---

## 1. GitHub App

The fields needed, plus the permissions they must be granted — the app both
**creates/updates check runs** and **writes PR comments**, which is more than a
read-only bot.

| Env var | REQUIRED | Where it comes from |
| --- | --- | --- |
| `GITHUB_APP_ID` | ✅ | GitHub App settings → *App ID* |
| `GITHUB_APP_PRIVATE_KEY` | ✅ | GitHub App settings → *Generate a private key* (PEM). `\n` escapes are decoded, so it can be stored on one line. |
| `GITHUB_APP_INSTALLATION_ID` | ✅ | The numeric id in the installation URL: `github.com/organizations/<org>/settings/installations/<INSTALLATION_ID>` |
| `GITHUB_ORG` | ✅ | The org the repos live under, e.g. `housing-cloud` |
| `GITHUB_ALLOWED_REPOS` | ✅ | Comma-separated repo names the service may act on, e.g. `web,api`. Anything else is ignored. |
| `GITHUB_WEBHOOK_SECRET` | ✅ | The secret you set on the App's webhook. Verified as `x-hub-signature-256`. |

### Required GitHub App permissions

| Permission | Level | Why |
| --- | --- | --- |
| **Checks** | Read & write | create + update the three preview check runs |
| **Pull requests** | Read & write | read the PR head commit, and post/edit the comment |
| **Issues** | Read & write | PR comments are issue comments in the REST API |
| **Contents** | Read-only | resolve the PR head commit |
| **Metadata** | Read-only | mandatory baseline |

### Required webhook subscription

Subscribe the App's webhook to **Pull requests** only. Point it at:

```
https://<service-host>/webhooks/github
```

`pull_request.closed` is acted on to release the closed PR's in-memory state.
Everything else about a preview arrives from pstack, not from GitHub.

With the control-plane API configured (§3), two more subscriptions are needed,
because that is how a `@cloudybot` command reaches the service:

| Event | Why |
| --- | --- |
| **Issue comments** | `@cloudybot <command>` in a PR comment. GitHub delivers a PR's conversation comments as `issue_comment`. |
| **Pull requests** | already subscribed; `pull_request.labeled` carries the `cloudy-*` label triggers. |

---

## 2. preview-stacks (pstack)

This is what drives the three new check runs and the "Preview stack" PR comment.

| Env var | REQUIRED | Where it comes from |
| --- | --- | --- |
| `PSTACK_WEBHOOK_SECRET` | ✅ | Shown **once** when you create the notifier (below). pstack keeps no way to show it again. |
| `PSTACK_CHECKS_WEBHOOK_SECRET` | ✅ | A random bearer secret for the operator-only checks cleanup webhook. Generate with `openssl rand -hex 32`. |
| `PSTACK_REPO` | ✅ | The repo whose PRs these stacks belong to, e.g. `web`. Must also be in `GITHUB_ALLOWED_REPOS`. |
| `PSTACK_SERVICES` | optional | Compose services that each get a check run. Defaults to `db-seed,web`. |
| `PSTACK_BASE_URL` | optional | pstack dashboard URL, linked from the checks and the comment. |
| `PSTACK_PREVIEW_DOMAIN` | optional | Preview domain, used to build `<service>-<stack>.<domain>` URLs in the comment. |
| `PSTACK_TOLERANCE_MS` | optional | Replay window. Defaults to `300000` (5 minutes). |
| `PSTACK_API_URL` | optional | pstack API base URL. Enables live preview URLs and the `@cloudybot` commands — see §3. |
| `PSTACK_API_TOKEN` | optional | pstack PAT for that API. Rejected at startup without `PSTACK_API_URL`. |

### The notifier

In pstack → **Notifiers → New**, create one of **type `webhook`** (a
`slack`/`discord` notifier sends unsigned prose and will *not* work):

- **URL**: `https://<service-host>/webhooks/preview-stacks`
- **Events**: at minimum

  ```
  job.started, job.succeeded, job.failed, job.leaked, job.cancelled,
  stack.ready, stack.failed, stack.timedout,
  container.ready, container.start-failed, container.stopped
  ```

  Subscribing to `*` also works; the extra events are ignored.

Copy the `whsec_…` secret it shows into `PSTACK_WEBHOOK_SECRET`. Deliveries are
verified as `sha256=HMAC(secret, timestamp + "." + rawBody)`, and anything older
than the tolerance is rejected as a replay.

### Clear stale pstack checks

GitHub does not expose an API to delete check suites or check runs. This service
therefore clears stale `pstack/*` runs by completing them with the `skipped`
conclusion, which removes a stale pending/failing verdict without reporting a
successful deployment.

```bash
# One stack
curl -X POST https://<service-host>/webhooks/pstack/checks/clear \
  -H "Authorization: Bearer $PSTACK_CHECKS_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"stack":"pr-16828"}'

# Every open PR in PSTACK_REPO
curl -X POST https://<service-host>/webhooks/pstack/checks/clear \
  -H "Authorization: Bearer $PSTACK_CHECKS_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"all":true}'
```

The secret is accepted only in the `Authorization` header. A successful call
also clears matching in-memory reporter state, so a later pstack event can open
fresh checks. Specific cleanup accepts only `pr-<number>`; prefixed deployments
cannot be isolated inside GitHub's App-and-commit-scoped check suite, so use the
explicit `{"all":true}` operation for those.

### What each check means

| Check run | Passes when | Fails when |
| --- | --- | --- |
| `pstack/stack` | `stack.ready` — every container reached ready | `stack.failed` / `stack.timedout`, or the `up` job failed, leaked or was cancelled |
| `pstack/db-seed` | the `db-seed` container reports ready (for a one-shot container that means **exited 0**) | `container.start-failed`, or the stack settled without it becoming ready |
| `pstack/web` | the `web` container reports ready | `container.start-failed`, or it is still in `pendingContainers` when the stack times out |

Two behaviours worth knowing, both taken from pstack's own semantics:

- **`job.succeeded` does not pass `pstack/stack`.** For an `up`, it means the
  commands ran — `compose up -d` returns once containers are *created*. The event
  updates the pending check to “Deployment completed; checking readiness”; the
  readiness watch that follows is what decides, and it always ends in exactly one
  of `stack.ready` / `stack.failed` / `stack.timedout`.
- **The stack name is the PR link.** pstack's payloads for `job.*`, `stack.*` and
  the readiness `container.*` events carry only `stack` (e.g. `pr-16828`) — no
  deployment id, no repo, no commit SHA. So the PR number is parsed from the
  stack name, and the head commit is looked up through the GitHub API. Name your
  deployments `pr-<number>` (or `<prefix>-pr-<number>`); any other shape is
  ignored, by design.

### The comments

A PR gets **two** comments, and they are deliberately separate:

| Comment | Written | Contents |
| --- | --- | --- |
| **Preview stack** | rewritten on every pstack event | current status, container counts, per-service rows, preview URLs |
| **Preview stack bot** | posted once, never edited | what the checks mean, and the commands available |

The help comment is posted when the checks first open — which is when a reviewer
first sees three pending checks and wonders what they are. It is never edited,
so it stays a stable reference; the status comment is the one that churns.

---

## 3. The pstack control-plane API (optional)

Without it, the service is purely push-driven: it reports what pstack sends and
can ask it nothing. Setting `PSTACK_API_URL` turns on two things.

```
PSTACK_API_URL=https://api.preview.housing.cloud
PSTACK_API_TOKEN=pstack_pat_…
```

The token is a pstack PAT (**pstack → Tokens**). pstack allows an unauthenticated
API, so the token is optional — but `PSTACK_API_TOKEN` without `PSTACK_API_URL`
is rejected at startup, since it almost always means a mistyped variable name.

### Real preview URLs

The comment's URLs are read from the stack's **live Traefik routing table**
(`GET /api/deployments/:id/runtime`) rather than rebuilt from
`PSTACK_PREVIEW_DOMAIN`. That pattern is only pstack's *default* router rule: a
spec that sets its own rule, port or domain makes the reconstructed link an
authoritative-looking 404. A service that is routed but not in `PSTACK_SERVICES`
is listed too, since its URL is still what a reviewer wants to open.

`PSTACK_PREVIEW_DOMAIN` remains the fallback for when the API is not configured
or cannot be reached.

### `@cloudybot` commands

Each command can be given as a **PR comment** or as a **label**; they do the same
thing. A label is removed once handled, so it can be applied again to re-run.

| Comment | Label | What it does |
| --- | --- | --- |
| `@cloudybot recheck` | `cloudy-recheck` | Re-read the stack's state from pstack and update the checks. Deploys nothing. |
| `@cloudybot restart` | `cloudy-restart` | Restart the stack's containers, wait for readiness, update the checks. |
| `@cloudybot redeploy` | `cloudy-redeploy` | Re-run the deploy (`up`), wait for readiness, update the checks. |

Listed in escalating order of disruption, so the cheapest fix is read first.
`recheck` is the one that repairs checks left pending by a delivery that never
arrived.

How they behave:

- **The checks are the reply.** They reopen as in progress immediately (that is
  the acknowledgement, since a deploy takes minutes and a webhook delivery gets
  seconds), then settle when the stack does. Failures are reported onto the
  checks, including pstack's own refusals.
- **One command per stack at a time.** pstack rejects a second job on a busy
  stack with a 409 — a `down` deleting what an `up` just created is the
  corruption that interlock prevents — and the service will not race two waits
  over the same checks.
- **Bot comments are ignored.** The help comment lists the commands in a table,
  and a quoted reply starts with `>`; neither fires.
- **Still converging at the deadline is not a verdict.** The checks stay pending
  and pstack's own `stack.*` delivery settles them, rather than reporting a false
  failure on a slow stack. `PSTACK_COMMAND_TIMEOUT_MS` bounds that wait.

Without `PSTACK_API_URL` the command rules are not registered at all: a bot that
acknowledges `@cloudybot redeploy` and then cannot redeploy anything is worse
than one that stays quiet, and the help comment says so.

---

## 4. Tuning (all optional)

| Env var | Default | Meaning |
| --- | --- | --- |
| `PSTACK_SERVICES` | `db-seed,web` | Compose services that each get their own check run. |
| `PSTACK_BASE_URL` | — | pstack dashboard URL, linked from the checks and the comment. |
| `PSTACK_PREVIEW_DOMAIN` | — | Preview domain, used to build `<service>-<stack>.<domain>` URLs in the comment. |
| `PSTACK_TOLERANCE_MS` | `300000` (5m) | Replay window for pstack deliveries. Must be ≥ 1000. |
| `PSTACK_API_URL` | — | pstack API base URL. Enables live preview URLs and the `@cloudybot` commands. |
| `PSTACK_API_TOKEN` | — | pstack PAT for that API. Requires `PSTACK_API_URL`. |
| `PSTACK_COMMAND_TIMEOUT_MS` | `600000` (10m) | How long a command waits for readiness before leaving the checks pending. |
| `EVENT_LOG_LIMIT` | `500` | Rows retained by the in-memory webhook log. |
| `EVENT_LOG_TOKEN` | — | Bearer token gating `/events` and `/dashboard`. **Set this** if the service is publicly reachable. |
| `FLOW_RUN_DB_PATH` | `./data/flow-runs.sqlite` (`/data/flow-runs.sqlite` in the container) | SQLite file for dashboard flow-run history. |
| `FLOW_RUN_LIMIT` | `200` | Maximum flow runs retained in SQLite. |
| `PORT` | `8080` | Listen port. |

---

## 5. Checklist

- [ ] GitHub App created, with the five permissions above.
- [ ] App installed on the org, scoped to the repos in `GITHUB_ALLOWED_REPOS`.
- [ ] App webhook subscribed to **Pull requests**, pointed at `/webhooks/github`,
      with `GITHUB_WEBHOOK_SECRET` set on both sides.
- [ ] `EVENT_LOG_TOKEN` set if the service is internet-facing.
- [ ] Dokploy persistent volume mounted at `/data` so flow-run history survives
      container replacement. The container entrypoint fixes its ownership before
      dropping to the `bun` user.
- [ ] Service scaled to one steady-state replica; the pstack reporter and RxJS
      coordinator are process-local. SQLite leases prevent active history rows
      from being expired during a short rolling-deployment overlap.
- [ ] pstack notifier created (**type `webhook`**), pointed at
      `/webhooks/preview-stacks`, subscribed to the events above, with its
      `whsec_…` secret → `PSTACK_WEBHOOK_SECRET`.
- [ ] `PSTACK_CHECKS_WEBHOOK_SECRET` generated and stored for operators that may
      call `/webhooks/pstack/checks/clear`.
- [ ] `PSTACK_REPO` set to the repo whose PRs the stacks belong to.
- [ ] pstack deployments named `pr-<number>` so they can be linked to a PR.
- [ ] For the `@cloudybot` commands and live preview URLs: `PSTACK_API_URL` set,
      `PSTACK_API_TOKEN` issued from **pstack → Tokens**, and the GitHub App
      subscribed to **Issue comments** as well as **Pull requests**.

### Smoke test

1. `GET /health` → `{"status":"ok"}`.
2. `GET /` → the route index lists `/webhooks/github` and
   `/webhooks/preview-stacks`.
3. Deploy a pstack stack named `pr-<number>` for an open PR. The PR gains
   `pstack/stack`, `pstack/db-seed` and `pstack/web` checks in progress.
4. A one-time **Preview stack bot** comment appears explaining the checks.
5. `GET /previews` → the stack appears in `stacks`.
6. As the containers report, the checks settle green or red and a
   "Preview stack" comment appears with the status and the preview URLs.
7. With `PSTACK_API_URL` set: comment `@cloudybot recheck` on that PR. The checks
   reopen within seconds and settle again, and no deploy runs. Then apply the
   `cloudy-recheck` label: the same happens and the label removes itself.
8. Close the PR → `GET /previews` drops it (the state is released).
9. pstack → the notifier's **Test** button is deliberately a no-op here: test
   deliveries reuse the `job.succeeded` event name and are excluded.
10. `GET /dashboard/api/flow-runs` → `enabled: true`; after composed flows run,
    their history remains visible after restarting the container.
