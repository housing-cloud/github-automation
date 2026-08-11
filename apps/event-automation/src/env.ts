import { z } from 'zod';

/**
 * Every variable the service reads. Exported so `.env.example` can be checked
 * against it: a hand-maintained list silently misses new variables, and a
 * missing one surfaces as a production startup crash.
 */
export const envSchema = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_APP_INSTALLATION_ID: z.string().min(1),
  GITHUB_ORG: z.string().min(1),
  GITHUB_ALLOWED_REPOS: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  PSTACK_WEBHOOK_SECRET: z.string().min(1),
  PSTACK_CHECKS_WEBHOOK_SECRET: z.string().min(1),
  PSTACK_REPO: z.string().min(1),
  PSTACK_SERVICES: z.string().optional(),
  PSTACK_BASE_URL: z.url().optional(),
  PSTACK_PREVIEW_DOMAIN: z.string().optional(),
  PSTACK_TOLERANCE_MS: z.string().optional(),
  EVENT_LOG_LIMIT: z.string().optional(),
  EVENT_LOG_TOKEN: z.string().optional(),
  FLOW_RUN_DB_PATH: z.string().min(1).optional(),
  FLOW_RUN_LIMIT: z.string().optional(),
  PORT: z.string().optional(),
});

export interface AppEnv {
  githubAppId: string;
  githubAppPrivateKey: string;
  githubAppInstallationId: number;
  githubOrg: string;
  githubAllowedRepos: ReadonlySet<string>;
  githubWebhookSecret: string;
  /** HMAC secret from the pstack `webhook`-type notifier. */
  pstackWebhookSecret: string;
  /** Bearer secret protecting the operator-only pstack checks cleanup webhook. */
  pstackChecksWebhookSecret: string;
  /**
   * The repo pstack stacks belong to. pstack payloads name a stack (`pr-16828`)
   * and never a repository, so this is the only way an event gets one.
   */
  pstackRepo: string;
  /** Compose services that get their own check run. Defaults to `db-seed,web`. */
  pstackServices: readonly string[];
  /** pstack dashboard URL, linked from the checks and comment. */
  pstackBaseUrl?: string;
  /** Preview domain, used to build `<service>-<stack>.<domain>` URLs. */
  pstackPreviewDomain?: string;
  /** Replay window for pstack deliveries. Defaults to the plugin's 5 minutes. */
  pstackToleranceMs?: number;
  /** Max rows retained by the in-memory event log (LRU). Defaults to 500. */
  eventLogLimit: number;
  /**
   * Optional bearer token gating the `/events` log page + JSON. When unset, the
   * log is publicly reachable.
   */
  eventLogToken?: string;
  /** SQLite file used for durable dashboard flow-run history. */
  flowRunDbPath: string;
  /** Maximum flow runs retained in SQLite. Defaults to 200. */
  flowRunLimit: number;
  port: number;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.parse(source);
  const githubAllowedRepos = parseCsvSet(parsed.GITHUB_ALLOWED_REPOS);

  if (githubAllowedRepos.size === 0) {
    throw new Error('GITHUB_ALLOWED_REPOS must include at least one repo name');
  }

  const githubAppInstallationId = Number(parsed.GITHUB_APP_INSTALLATION_ID);
  if (
    !Number.isInteger(githubAppInstallationId) ||
    githubAppInstallationId <= 0
  ) {
    throw new Error('GITHUB_APP_INSTALLATION_ID must be a positive integer');
  }

  // pstack checks are written to this repo, so an unlisted one would mean the
  // GitHub App is asked to write somewhere the operator never allowed.
  const pstackRepo = parsed.PSTACK_REPO.trim();
  if (!githubAllowedRepos.has(pstackRepo)) {
    throw new Error(
      `PSTACK_REPO is "${pstackRepo}", which is not in GITHUB_ALLOWED_REPOS`,
    );
  }

  return {
    githubAppId: parsed.GITHUB_APP_ID,
    githubAppPrivateKey: parsed.GITHUB_APP_PRIVATE_KEY.replaceAll('\\n', '\n'),
    githubAppInstallationId,
    githubOrg: parsed.GITHUB_ORG,
    githubAllowedRepos,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    pstackWebhookSecret: parsed.PSTACK_WEBHOOK_SECRET,
    pstackChecksWebhookSecret: parsed.PSTACK_CHECKS_WEBHOOK_SECRET,
    pstackRepo,
    pstackServices: parsePstackServices(parsed.PSTACK_SERVICES),
    pstackBaseUrl: parsed.PSTACK_BASE_URL?.replace(/\/$/, ''),
    pstackPreviewDomain: parsed.PSTACK_PREVIEW_DOMAIN,
    pstackToleranceMs:
      parsed.PSTACK_TOLERANCE_MS === undefined
        ? undefined
        : parseDuration(
            parsed.PSTACK_TOLERANCE_MS,
            5 * 60_000,
            'PSTACK_TOLERANCE_MS',
          ),
    eventLogLimit: parseEventLogLimit(parsed.EVENT_LOG_LIMIT),
    eventLogToken: parsed.EVENT_LOG_TOKEN,
    flowRunDbPath: parsed.FLOW_RUN_DB_PATH ?? './data/flow-runs.sqlite',
    flowRunLimit: parsePositiveInteger(
      parsed.FLOW_RUN_LIMIT,
      200,
      'FLOW_RUN_LIMIT',
    ),
    port: parsePort(parsed.PORT),
  };
}

function parseEventLogLimit(value: string | undefined): number {
  return parsePositiveInteger(value, 500, 'EVENT_LOG_LIMIT');
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseDuration(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value) return fallback;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1000) {
    throw new Error(`${name} must be an integer >= 1000 (milliseconds)`);
  }
  return ms;
}

function parseCsvSet(value: string): ReadonlySet<string> {
  return new Set(
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/** Comma-separated compose service names. Defaults to the two HOU cares about. */
function parsePstackServices(value: string | undefined): readonly string[] {
  const services = (value ?? 'db-seed,web')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (services.length === 0) {
    throw new Error('PSTACK_SERVICES must name at least one compose service');
  }
  return services;
}

function parsePort(value: string | undefined): number {
  if (!value) return 8080;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}
