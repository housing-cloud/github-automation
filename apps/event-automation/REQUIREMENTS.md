# event-automation — configuration requirements

Everything the service needs before it can run, and where each value comes from.
Items marked **REQUIRED** are validated at startup: the process refuses to boot
without them.

---

## 1. GitHub App

You said you would provide the bot details. These are the fields needed, plus
the permissions they must be granted — the app both **creates/updates check
runs** and **writes PR comments**, which is more than a read-only bot.

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
| **Checks** | Read & write | create + update the preview check run |
| **Pull requests** | Read & write | post and edit the deployment comment |
| **Issues** | Read & write | PR comments are issue comments in the REST API |
| **Contents** | Read-only | resolve the PR head commit |
| **Metadata** | Read-only | mandatory baseline |

### Required webhook subscription

Subscribe the App's webhook to **Pull requests** only. Point it at:

```
https://<service-host>/webhooks/github
```

---

## 2. Dokploy

| Env var | REQUIRED | Where it comes from |
| --- | --- | --- |
| `DOKPLOY_BASE_URL` | ✅ | Your instance root, e.g. `https://dokploy.housing.cloud`. No trailing slash needed. |
| `DOKPLOY_API_KEY` | ✅ | Dokploy → `/settings/profile` → **API/CLI** → *Generate token*. Sent as `x-api-key`. |
| `DOKPLOY_WEBHOOK_TOKEN` | ✅ | **A secret you invent.** See "Dokploy webhook" below — Dokploy does not generate one. |
| `DOKPLOY_REPO_APPLICATION_MAP` | ✅ | `repo:applicationId[:displayName]`, comma-separated. See below. |
| `DOKPLOY_APPLICATION_REPO_MAP` | optional | `project/application:repo` (or `application:repo`). Only needed if you want Dokploy-sourced events attributed to a repo. |

### `DOKPLOY_REPO_APPLICATION_MAP`

This is the one mapping you must fill in by hand. It tells the service *which
Dokploy application holds the preview deployments for a given GitHub repo*.

```
DOKPLOY_REPO_APPLICATION_MAP="web:kZ8sq2Lm-abc:web-app,api:Tq91xNb-def"
```

- `web` — the GitHub repo name (must also appear in `GITHUB_ALLOWED_REPOS`;
  startup fails otherwise).
- `kZ8sq2Lm-abc` — the Dokploy `applicationId`. Read it off the dashboard URL of
  the application: `…/services/application/<applicationId>`.
- `web-app` — optional display name shown in the check-run title
  (`dokploy/web-app (preview)`). Defaults to the repo name.

### Dokploy webhook (the shared secret)

Dokploy's Custom/Webhook notifications are **unsigned**, so a header secret is
the fix. In Dokploy → **Notifications → Webhook**:

- **URL**: `https://<service-host>/webhooks/dokploy`
- **Custom header**: `x-webhook-token: <the same value as DOKPLOY_WEBHOOK_TOKEN>`

Generate the value with e.g. `openssl rand -hex 32`.

> This webhook is **not** what drives the PR check — it only feeds the event log
> and the optional Slack alert. Dokploy's notification payloads carry no PR
> identity, which is exactly why the check run is driven by polling instead.

### Preview deployments must be enabled

For each application you map, in Dokploy turn on **Preview Deployments**
(`isPreviewDeploymentsActive`) and connect it to the GitHub provider. Dokploy's
own GitHub App/webhook is what *creates* the preview; this service only reports
on it. Both can point at the same repo — they serve different roles.

---

## 3. Tuning (all optional)

| Env var | Default | Meaning |
| --- | --- | --- |
| `PREVIEW_POLL_INTERVAL_MS` | `30000` | How often the tracker re-reads a preview's status. Must be ≥ 1000. |
| `PREVIEW_TIMEOUT_MS` | `1800000` (30m) | How long before an unreported preview fails the check as `timed_out`. |
| `SLACK_WEBHOOK_URL` | — | When set, Dokploy build failures also post to Slack. |
| `EVENT_LOG_LIMIT` | `500` | Rows retained by the in-memory webhook log. |
| `EVENT_LOG_TOKEN` | — | Bearer token gating `/events` and `/dashboard`. **Set this** if the service is publicly reachable. |
| `PORT` | `8080` | Listen port. |

---

## 4. Checklist

- [ ] GitHub App created, with the five permissions above.
- [ ] App installed on the org, scoped to the repos in `GITHUB_ALLOWED_REPOS`.
- [ ] App webhook subscribed to **Pull requests**, pointed at `/webhooks/github`,
      with `GITHUB_WEBHOOK_SECRET` set on both sides.
- [ ] Dokploy API token generated → `DOKPLOY_API_KEY`.
- [ ] Dokploy Notifications → Webhook created, pointed at `/webhooks/dokploy`,
      with the `x-webhook-token` custom header → `DOKPLOY_WEBHOOK_TOKEN`.
- [ ] Preview deployments enabled on each Dokploy application.
- [ ] `DOKPLOY_REPO_APPLICATION_MAP` filled in with each repo's `applicationId`.
- [ ] `EVENT_LOG_TOKEN` set if the service is internet-facing.

### Smoke test

1. `GET /health` → `{"status":"ok"}`.
2. `GET /` → the route index lists `/webhooks/github` and `/webhooks/dokploy`.
3. Open a PR on a mapped repo. Within a second the PR shows a
   `dokploy/<app> (preview)` check in progress plus a comment.
4. `GET /previews` → the PR appears in `tracking`.
5. Within `PREVIEW_TIMEOUT_MS` the check settles green or red and the comment
   shows the preview URL.
