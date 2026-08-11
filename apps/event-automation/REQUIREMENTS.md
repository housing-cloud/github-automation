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

Only `pull_request.closed` is acted on, to release the closed PR's in-memory
state. Everything else about a preview arrives from pstack, not from GitHub.

---

## 2. preview-stacks (pstack)

This is what drives the three new check runs and the "Preview stack" PR comment.

| Env var | REQUIRED | Where it comes from |
| --- | --- | --- |
| `PSTACK_WEBHOOK_SECRET` | ✅ | Shown **once** when you create the notifier (below). pstack keeps no way to show it again. |
| `PSTACK_REPO` | ✅ | The repo whose PRs these stacks belong to, e.g. `web`. Must also be in `GITHUB_ALLOWED_REPOS`. |
| `PSTACK_SERVICES` | optional | Compose services that each get a check run. Defaults to `db-seed,web`. |
| `PSTACK_BASE_URL` | optional | pstack dashboard URL, linked from the checks and the comment. |
| `PSTACK_PREVIEW_DOMAIN` | optional | Preview domain, used to build `<service>-<stack>.<domain>` URLs in the comment. |
| `PSTACK_TOLERANCE_MS` | optional | Replay window. Defaults to `300000` (5 minutes). |

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

---

## 3. Tuning (all optional)

| Env var | Default | Meaning |
| --- | --- | --- |
| `PSTACK_SERVICES` | `db-seed,web` | Compose services that each get their own check run. |
| `PSTACK_BASE_URL` | — | pstack dashboard URL, linked from the checks and the comment. |
| `PSTACK_PREVIEW_DOMAIN` | — | Preview domain, used to build `<service>-<stack>.<domain>` URLs in the comment. |
| `PSTACK_TOLERANCE_MS` | `300000` (5m) | Replay window for pstack deliveries. Must be ≥ 1000. |
| `EVENT_LOG_LIMIT` | `500` | Rows retained by the in-memory webhook log. |
| `EVENT_LOG_TOKEN` | — | Bearer token gating `/events` and `/dashboard`. **Set this** if the service is publicly reachable. |
| `PORT` | `8080` | Listen port. |

---

## 4. Checklist

- [ ] GitHub App created, with the five permissions above.
- [ ] App installed on the org, scoped to the repos in `GITHUB_ALLOWED_REPOS`.
- [ ] App webhook subscribed to **Pull requests**, pointed at `/webhooks/github`,
      with `GITHUB_WEBHOOK_SECRET` set on both sides.
- [ ] `EVENT_LOG_TOKEN` set if the service is internet-facing.
- [ ] pstack notifier created (**type `webhook`**), pointed at
      `/webhooks/preview-stacks`, subscribed to the events above, with its
      `whsec_…` secret → `PSTACK_WEBHOOK_SECRET`.
- [ ] `PSTACK_REPO` set to the repo whose PRs the stacks belong to.
- [ ] pstack deployments named `pr-<number>` so they can be linked to a PR.

### Smoke test

1. `GET /health` → `{"status":"ok"}`.
2. `GET /` → the route index lists `/webhooks/github` and
   `/webhooks/preview-stacks`.
3. Deploy a pstack stack named `pr-<number>` for an open PR. The PR gains
   `pstack/stack`, `pstack/db-seed` and `pstack/web` checks in progress.
4. `GET /previews` → the stack appears in `stacks`.
5. As the containers report, the checks settle green or red and a
   "Preview stack" comment appears with the status and the preview URLs.
6. Close the PR → `GET /previews` drops it (the state is released).
7. pstack → the notifier's **Test** button is deliberately a no-op here: test
   deliveries reuse the `job.succeeded` event name and are excluded.
