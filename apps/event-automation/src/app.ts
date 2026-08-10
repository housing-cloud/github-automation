import { dashboardRoutes, type EventLogLike } from '@samyx/gha-ui';
import type { Logger } from '@samyx/github-automation-suite';
import { createEngine, noopLogger } from '@samyx/github-automation-suite';
import { mountDiscovery } from '@samyx/github-automation-suite/discovery';
import { toHono } from '@samyx/github-automation-suite/hono';
import { githubPlugin } from '@samyx/github-automation-suite/plugins/github';
import { eventLogPlugin } from '@samyx/github-automation-suite/plugins/event-log';
import { eventLogRoutes } from '@samyx/github-automation-suite/plugins/event-log/hono';
import { dokployPlugin } from '@samyx/gha-plugin-dokploy';
import { previewStacksPlugin } from '@samyx/gha-plugin-preview-stacks';
import { Hono, type MiddlewareHandler } from 'hono';
import { DokployClient } from './dokploy/client';
import type { AppEnv } from './env';
import type { TrackerOctokit } from './github/checks';
import { createOctokit } from './github/octokit';
import { PreviewTracker } from './preview/tracker';
import { PstackReporter } from './pstack/reporter';
import { createRules } from './rules';

export interface CreateEventAutomationAppOptions {
  env: AppEnv;
  logger?: Logger;
  /**
   * Inject an Octokit client (used by tests). When omitted, the GitHub plugin
   * builds an installation client from the GitHub App credentials in `env`.
   * Widened past the suite's `OctokitLike` because the preview tracker also
   * updates check runs and PR comments (see `github/checks.ts`).
   */
  octokit?: TrackerOctokit;
  fetch?: typeof fetch;
  /** Override the tracker (tests inject a fake clock / fake sleep). */
  tracker?: PreviewTracker;
  /** Override the pstack reporter (tests inject a recording Octokit). */
  pstack?: PstackReporter;
}

export interface EventAutomationApp {
  app: Hono;
  tracker: PreviewTracker;
  pstack: PstackReporter;
}

/**
 * Build the event-automation Hono app on top of
 * `@samyx/github-automation-suite`: the GitHub + Dokploy source plugins plus
 * the HOU rules, exposed as `POST /webhooks/{github,dokploy}` and `GET /health`.
 */
export async function createEventAutomationApp(
  options: CreateEventAutomationAppOptions,
): Promise<Hono> {
  return (await createEventAutomation(options)).app;
}

/** Same as {@link createEventAutomationApp}, also returning the tracker. */
export async function createEventAutomation(
  options: CreateEventAutomationAppOptions,
): Promise<EventAutomationApp> {
  const { env } = options;
  const logger = options.logger ?? noopLogger;

  // One installation client, shared by the GitHub plugin's handlers and the
  // tracker's check-run / comment upserts.
  const octokit =
    options.octokit ??
    (await createOctokit({
      appId: env.githubAppId,
      privateKey: env.githubAppPrivateKey,
      installationId: env.githubAppInstallationId,
    }));

  // Records every received webhook into an in-memory LRU, served at `/events`.
  const eventLog = eventLogPlugin({ limit: env.eventLogLimit });

  const tracker =
    options.tracker ??
    new PreviewTracker({
      dokploy: new DokployClient({
        baseUrl: env.dokployBaseUrl,
        apiKey: env.dokployApiKey,
        fetch: options.fetch,
      }),
      // The tracker needs check-run *updates*, which the suite's plugin does
      // not expose, so it holds the client directly.
      octokit,
      dokployBaseUrl: env.dokployBaseUrl,
      logger,
      pollIntervalMs: env.previewPollIntervalMs,
      timeoutMs: env.previewTimeoutMs,
    });

  // pstack reports on one repo's preview stacks: its payloads name a stack
  // (`pr-16828`) and never a repository, so the repo comes from config.
  const pstack =
    options.pstack ??
    new PstackReporter({
      octokit,
      repo: { owner: env.githubOrg, name: env.pstackRepo },
      logger,
      services: env.pstackServices,
      previewDomain: env.pstackPreviewDomain,
      pstackBaseUrl: env.pstackBaseUrl,
    });

  const engine = await createEngine({
    logger: options.logger,
    fetch: options.fetch,
    plugins: [
      eventLog,
      githubPlugin({
        webhookSecret: env.githubWebhookSecret,
        org: env.githubOrg,
        allowedRepos: env.githubAllowedRepos,
        octokit,
      }),
      // Dokploy webhooks are unsigned; the shared token goes in a custom
      // `x-webhook-token` header configured on the Dokploy notification.
      dokployPlugin({
        token: env.dokployWebhookToken,
        baseUrl: env.dokployBaseUrl,
        apiKey: env.dokployApiKey,
        org: env.githubOrg,
        allowedRepos: env.githubAllowedRepos,
        applicationRepoMap: env.dokployApplicationRepoMap,
        fetch: options.fetch,
      }),
      // pstack signs its envelope (HMAC over `timestamp + "." + rawBody`), so
      // unlike Dokploy this ingress is genuinely authenticated.
      previewStacksPlugin({
        secret: env.pstackWebhookSecret,
        toleranceMs: env.pstackToleranceMs,
      }),
    ],
    rules: createRules({ env, tracker, pstack }),
  });

  const app = toHono(engine);
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Live preview trackers — the poll loops currently watching a PR, and the
  // pstack stacks currently mirrored onto checks.
  app.get('/previews', (c) =>
    c.json({
      count: tracker.active.length,
      tracking: tracker.active,
      pstackStacks: pstack.active,
    }),
  );

  // `/events` — HTML table of received webhooks; `/events/json` — the same as
  // JSON. Mounted through a wrapper so the optional token guard (registered
  // before the routes) applies to the whole subtree.
  const events = new Hono();
  if (env.eventLogToken) events.use('*', bearerGuard(env.eventLogToken));
  events.route(
    '/',
    eventLogRoutes(eventLog.store, {
      title: 'HOU event automation — received webhooks',
    }),
  );
  app.route('/events', events);

  // `/dashboard` — bundled Vue dashboard (flow of rules -> handlers, event log,
  // handler log, config). Same optional token guard as `/events`.
  const dashboard = new Hono();
  if (env.eventLogToken) dashboard.use('*', bearerGuard(env.eventLogToken));
  dashboard.route(
    '/',
    dashboardRoutes(engine, {
      title: 'HOU event automation',
      // The store's records are structurally what the dashboard reads; the cast
      // bridges the separately-declared EventLogLike (index-signature) type.
      eventLog: eventLog.store as unknown as EventLogLike,
      config: {
        org: env.githubOrg,
        allowedRepos: [...env.githubAllowedRepos],
        dokployBaseUrl: env.dokployBaseUrl,
        trackedRepos: [...env.repoApplications.keys()],
        pstackRepo: env.pstackRepo,
        pstackServices: [...env.pstackServices],
        previewPollIntervalMs: env.previewPollIntervalMs,
        eventLogLimit: env.eventLogLimit,
      },
    }),
  );
  app.route('/dashboard', dashboard);

  // Self-describing route index: `GET /` (HTML) + `GET /discovery.json`.
  // Called last so it introspects the full route table (webhooks, health,
  // events, dashboard) from the live Hono app.
  mountDiscovery(app, {
    title: 'HOU event automation',
    descriptions: {
      'GET /health': 'Liveness / readiness probe',
      'GET /previews': 'Preview deployments currently being polled',
      'POST /webhooks/github': 'GitHub App webhook ingress',
      'POST /webhooks/dokploy': 'Dokploy notification webhook ingress',
      'POST /webhooks/preview-stacks':
        'pstack (preview-stacks) signed webhook ingress',
      'GET /events': 'Received-webhooks log (HTML table)',
      'GET /events/json': 'Received-webhooks log (JSON)',
      'GET /dashboard':
        'Dashboard: rules→handlers flow, event log, handler log, config',
    },
  });

  return { app, tracker, pstack };
}

/**
 * Gate a route subtree on a shared bearer token, accepted either as
 * `Authorization: Bearer <token>` or a `?token=<token>` query param (so the log
 * page opens in a browser). Returns 401 otherwise.
 */
function bearerGuard(token: string): MiddlewareHandler {
  const expected = `Bearer ${token}`;
  return async (c, next) => {
    if (c.req.header('authorization') === expected) return next();
    if (c.req.query('token') === token) return next();
    return c.json({ error: 'unauthorized' }, 401);
  };
}
