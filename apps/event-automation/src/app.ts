import { timingSafeEqual } from 'node:crypto';
import { dashboardRoutes, type EventLogLike } from '@samyx/gha-ui';
import type { FlowRunStore, Logger } from '@samyx/github-automation-suite';
import { createEngine, noopLogger } from '@samyx/github-automation-suite';
import { RxjsCoordinator } from '@samyx/github-automation-suite/coordinator/rxjs';
import { mountDiscovery } from '@samyx/github-automation-suite/discovery';
import { toHono } from '@samyx/github-automation-suite/hono';
import { githubPlugin } from '@samyx/github-automation-suite/plugins/github';
import { eventLogPlugin } from '@samyx/github-automation-suite/plugins/event-log';
import { eventLogRoutes } from '@samyx/github-automation-suite/plugins/event-log/hono';
import { Hono, type MiddlewareHandler } from 'hono';
import type { AppEnv } from './env';
import { type AppOctokit, clearPstackChecks } from './github/checks';
import {
  MAX_PRS_PER_REQUEST,
  parseApprovalRequest,
} from './github/approval-request';
import { approvePullRequests, resolveStack } from './github/approvals';
import { createOctokit } from './github/octokit';
import { createPstackClient, readServiceUrls } from './pstack/client';
import { PstackCommands } from './pstack/commands';
import { previewStacksIngress } from './pstack/ingress';
import { PstackReporter } from './pstack/reporter';
import { parseStackIdentity } from './pstack/stack';
import { createRules } from './rules';

export interface CreateEventAutomationOptions {
  env: AppEnv;
  logger?: Logger;
  /**
   * Inject an Octokit client (used by tests). When omitted, the GitHub plugin
   * builds an installation client from the GitHub App credentials in `env`.
   * Widened past the suite's `OctokitLike` because the reporter also updates
   * check runs and PR comments (see `github/checks.ts`).
   */
  octokit?: AppOctokit;
  fetch?: typeof fetch;
  /** Override the pstack reporter (tests inject a recording Octokit). */
  pstack?: PstackReporter;
  /** Override persistent flow-run history (tests may inject an in-memory store). */
  flowRuns?: FlowRunStore;
}

export interface EventAutomationApp {
  app: Hono;
  pstack: PstackReporter;
  /** Present only when the pstack control-plane API is configured. */
  commands?: PstackCommands;
  flowRuns: FlowRunStore;
  dispose(): Promise<void>;
}

/** Build the Hono app and its owned runtime resources. Call `dispose` on exit. */
export async function createEventAutomation(
  options: CreateEventAutomationOptions,
): Promise<EventAutomationApp> {
  const { env } = options;
  const logger = options.logger ?? noopLogger;

  // One installation client, shared by the GitHub plugin's handlers and the
  // reporter's check-run / comment upserts.
  const octokit =
    options.octokit ??
    (await createOctokit({
      appId: env.githubAppId,
      privateKey: env.githubAppPrivateKey,
      installationId: env.githubAppInstallationId,
    }));

  // Records every received webhook into an in-memory LRU, served at `/events`.
  const eventLog = eventLogPlugin({ limit: env.eventLogLimit });
  const flowRuns =
    options.flowRuns ??
    new (await import('./flow-runs/sqlite')).SqliteFlowRunStore({
      path: env.flowRunDbPath,
      limit: env.flowRunLimit,
    });
  const coordinator = new RxjsCoordinator({ logger, runs: flowRuns });

  // The control-plane client is optional: without `PSTACK_API_URL` the service
  // is purely push-driven — it reports what pstack sends and cannot ask it
  // anything. With it, the comment carries the live routing table's URLs and
  // the `@cloudybot` commands are registered.
  const client = env.pstackApiUrl
    ? createPstackClient({
        baseUrl: env.pstackApiUrl,
        token: env.pstackApiToken,
        fetch: options.fetch,
      })
    : undefined;

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
      commandsEnabled: client !== undefined,
      resolveUrls: client
        ? (stack, prNumber) => readServiceUrls(client, stack, prNumber, logger)
        : undefined,
    });

  const commands = client
    ? new PstackCommands({
        client,
        reporter: pstack,
        octokit,
        repo: { owner: env.githubOrg, name: env.pstackRepo },
        logger,
        readyTimeoutMs: env.pstackCommandTimeoutMs,
      })
    : undefined;

  const engine = await createEngine({
    logger: options.logger,
    fetch: options.fetch,
    coordinator,
    plugins: [
      eventLog,
      githubPlugin({
        webhookSecret: env.githubWebhookSecret,
        org: env.githubOrg,
        allowedRepos: env.githubAllowedRepos,
        octokit,
      }),
      // pstack signs its envelope (HMAC over `timestamp + "." + rawBody`), so
      // this ingress is genuinely authenticated rather than token-gated. The
      // check itself is the client package's `verifyWebhook` — see
      // `pstack/ingress.ts` for why.
      previewStacksIngress({
        secret: env.pstackWebhookSecret,
        toleranceMs: env.pstackToleranceMs,
        logger,
      }),
    ],
    rules: createRules({ env, pstack, commands, octokit }),
  });

  const app = toHono(engine);
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // The preview stacks currently mirrored onto GitHub checks.
  app.get('/previews', (c) =>
    c.json({ count: pstack.active.length, stacks: pstack.active }),
  );

  const checkCleanup = new Hono();
  checkCleanup.use('*', bearerGuard(env.pstackChecksWebhookSecret));
  checkCleanup.post('/', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'body must be valid JSON' }, 400);
    }
    const target = parseClearTarget(body);
    if (!target) {
      return c.json(
        { error: 'body must be {"stack":"pr-123"} or {"all":true}' },
        400,
      );
    }

    try {
      const specific = 'prNumber' in target;
      const repo = { owner: env.githubOrg, name: env.pstackRepo };
      const cleared = specific
        ? await pstack.clearStack(target.stack, (headSha) =>
            clearPstackChecks(octokit, repo, {
              prNumber: target.prNumber,
              headSha,
            }),
          )
        : await pstack.clearAll(() => clearPstackChecks(octokit, repo, target));
      return c.json({
        ...cleared.result,
        ...(specific ? { stack: target.stack } : {}),
        forgotten: cleared.forgotten,
      });
    } catch (error) {
      logger.error(
        { target, error: String(error) },
        'pstack: clearing GitHub checks failed',
      );
      return c.json({ error: 'clearing GitHub checks failed' }, 502);
    }
  });
  app.route('/webhooks/pstack/checks/clear', checkCleanup);

  // Bulk PR approval. Registered only when a key is configured — a route that
  // approves pull requests must not exist by default.
  if (env.approvalsWebhookSecret) {
    const approvals = new Hono();
    approvals.use('*', apiKeyGuard(env.approvalsWebhookSecret));
    approvals.post('/', async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'body must be valid JSON' }, 400);
      }

      const request = parseApprovalRequest(raw);
      if ('error' in request) return c.json({ error: request.error }, 400);

      const repo = { owner: env.githubOrg, name: env.pstackRepo };
      let prs: number[];
      let stack: number | undefined;

      if (request.kind === 'stack') {
        const resolved = await resolveStack(
          octokit,
          repo,
          request.stack,
          logger,
        );
        if (!resolved) {
          return c.json(
            {
              error: `no stack ${request.stack} in ${repo.owner}/${repo.name}`,
            },
            404,
          );
        }
        stack = resolved.number;
        // Merged layers are the normal state of a stack being landed bottom-up,
        // so they are filtered here rather than reported as skips on every call.
        prs = resolved.pullRequests
          .filter((pull) => !pull.merged && (pull.state ?? 'open') === 'open')
          .map((pull) => pull.number);
        if (prs.length === 0) {
          return c.json({
            stack: resolved.number,
            approved: 0,
            results: [],
            note: 'every pull request in this stack is already merged or closed',
          });
        }
        if (prs.length > MAX_PRS_PER_REQUEST) {
          return c.json(
            {
              error: `stack ${stack} has more than ${MAX_PRS_PER_REQUEST} open pull requests`,
            },
            422,
          );
        }
      } else {
        prs = request.prs;
      }

      const results = await approvePullRequests(prs, {
        octokit,
        repo,
        logger,
        body: request.body,
        includeDrafts: request.drafts,
      });

      const counts = {
        approved: results.filter((r) => r.status === 'approved').length,
        alreadyApproved: results.filter((r) => r.status === 'already-approved')
          .length,
        skipped: results.filter((r) => r.status === 'skipped').length,
        failed: results.filter((r) => r.status === 'failed').length,
      };
      logger.info(
        { repo: repo.name, stack, ...counts },
        'approvals: bulk approval finished',
      );

      // 207 when the outcome is mixed: a caller that only checks the status
      // code should not read a partial failure as a clean success.
      const status =
        counts.failed === 0
          ? 200
          : counts.failed === results.length
            ? 502
            : 207;
      return c.json(
        { ...(stack ? { stack } : {}), ...counts, results },
        status,
      );
    });
    app.route('/webhooks/approvals', approvals);
  }

  // `/events` — HTML table of received webhooks; `/events/json` — the same as
  // JSON. Mounted through a wrapper so the optional token guard (registered
  // before the routes) applies to the whole subtree.
  const events = new Hono();
  if (env.eventLogToken) events.use('*', bearerGuard(env.eventLogToken, true));
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
  if (env.eventLogToken)
    dashboard.use('*', bearerGuard(env.eventLogToken, true));
  dashboard.route(
    '/',
    dashboardRoutes(engine, {
      title: 'HOU event automation',
      // The store's records are structurally what the dashboard reads; the cast
      // bridges the separately-declared EventLogLike (index-signature) type.
      eventLog: eventLog.store as unknown as EventLogLike,
      flowRuns,
      config: {
        org: env.githubOrg,
        allowedRepos: [...env.githubAllowedRepos],
        pstackRepo: env.pstackRepo,
        pstackServices: [...env.pstackServices],
        pstackBaseUrl: env.pstackBaseUrl,
        previewDomain: env.pstackPreviewDomain,
        eventLogLimit: env.eventLogLimit,
        flowRunLimit: env.flowRunLimit,
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
      'GET /previews': 'Preview stacks currently mirrored onto GitHub checks',
      'POST /webhooks/github': 'GitHub App webhook ingress',
      'POST /webhooks/preview-stacks':
        'pstack (preview-stacks) signed webhook ingress',
      'POST /webhooks/pstack/checks/clear':
        'Clear pstack checks for one stack or every open PR',
      'POST /webhooks/approvals':
        'Approve a list of pull requests, or every open PR in a gh-stack',
      'GET /events': 'Received-webhooks log (HTML table)',
      'GET /events/json': 'Received-webhooks log (JSON)',
      'GET /dashboard':
        'Dashboard: rules→handlers flow, event log, handler log, config',
    },
  });

  return {
    app,
    pstack,
    commands,
    flowRuns,
    async dispose() {
      try {
        // Let an accepted command finish writing its verdict onto the checks;
        // abandoning it would leave them pending with nothing to settle them.
        await commands?.drain();
        await engine.dispose();
      } finally {
        if ('close' in flowRuns && typeof flowRuns.close === 'function')
          flowRuns.close();
      }
    },
  };
}

/**
 * Gate a route subtree on a shared bearer token, accepted either as
 * `Authorization: Bearer <token>` or a `?token=<token>` query param (so the log
 * page opens in a browser). Returns 401 otherwise.
 */
function bearerGuard(token: string, allowQuery = false): MiddlewareHandler {
  const expected = `Bearer ${token}`;
  return async (c, next) => {
    if (c.req.header('authorization') === expected) return next();
    if (allowQuery && c.req.query('token') === token) return next();
    return c.json({ error: 'unauthorized' }, 401);
  };
}

/**
 * Gate a route on a shared key, accepted as `X-Api-Key`, as
 * `Authorization: Bearer <key>`, or as `?key=` / `?token=`.
 *
 * The query forms exist because this is called from places that cannot set
 * headers easily — a CI `curl`, a chat-ops button, a webhook field that only
 * takes a URL. They are also the leakier forms, since URLs land in logs and
 * shell history, which is why the key has a minimum length (see `env.ts`) and
 * this route is off unless one is configured.
 *
 * Compared in constant time: a naive `===` on a secret leaks its prefix to a
 * patient caller through timing, and unlike the pstack ingress there is no
 * signature here to fall back on.
 */
function apiKeyGuard(key: string): MiddlewareHandler {
  return async (c, next) => {
    const presented =
      c.req.header('x-api-key') ??
      c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ??
      c.req.query('key') ??
      c.req.query('token');
    if (presented !== undefined && timingSafeEquals(presented, key)) {
      return next();
    }
    return c.json({ error: 'unauthorized' }, 401);
  };
}

/** Constant-time string comparison over the UTF-8 bytes. */
function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // timing signal, so the lengths are folded into the result instead.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function parseClearTarget(
  body: unknown,
): { stack: string; prNumber: number } | { all: true } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return undefined;
  const value = body as Record<string, unknown>;
  const hasStack = 'stack' in value;
  const stack = typeof value.stack === 'string' ? value.stack.trim() : '';
  const identity = parseStackIdentity(stack);
  const isAll = value.all === true;
  if (hasStack === isAll || (hasStack && identity?.prefix !== ''))
    return undefined;
  return identity ? { stack, prNumber: identity.prNumber } : { all: true };
}
