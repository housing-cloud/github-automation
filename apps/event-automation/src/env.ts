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
  PSTACK_API_URL: z.url().optional(),
  PSTACK_API_TOKEN: z.string().optional(),
  PSTACK_PREVIEW_DOMAIN: z.string().optional(),
  PSTACK_TOLERANCE_MS: z.string().optional(),
  PSTACK_COMMAND_TIMEOUT_MS: z.string().optional(),
  PR_OPENED_COMMENT: z.string().optional(),
  APPROVALS_WEBHOOK_SECRET: z.string().optional(),
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
  /**
   * pstack control-plane API base URL (`https://api.<domain>`). Enables the
   * live preview URLs and the `@cloudybot` commands; without it this service
   * only reports what pstack pushes.
   */
  pstackApiUrl?: string;
  /** `PSTACK_TOKEN` or a `pstack_pat_…`. Required for the write commands. */
  pstackApiToken?: string;
  /** Preview domain, used to build `<service>-<stack>.<domain>` URLs. */
  pstackPreviewDomain?: string;
  /** Replay window for pstack deliveries. Defaults to the plugin's 5 minutes. */
  pstackToleranceMs?: number;
  /** How long a `@cloudybot` command waits for readiness. Defaults to 10m. */
  pstackCommandTimeoutMs: number;
  /**
   * Post the preview-labels explainer on every newly opened PR. Off by default:
   * it writes to PRs that may have no preview stack at all, so switching it on
   * is a deliberate choice per deployment.
   */
  prOpenedComment: boolean;
  /**
   * Shared key for the bulk-approval webhook. **Unset disables the route**
   * entirely rather than leaving it open: approving PRs is a write against
   * review state, so there is no safe default.
   */
  approvalsWebhookSecret?: string;
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

  // A token with nowhere to send it means the operator expected the commands to
  // work and they silently would not — the API URL is what switches them on.
  if (parsed.PSTACK_API_TOKEN && !parsed.PSTACK_API_URL) {
    throw new Error('PSTACK_API_TOKEN is set but PSTACK_API_URL is not');
  }

  // This one key is the whole authorization story for a route that approves
  // pull requests, and it is accepted in a query string, so a short one is
  // both guessable and easy to leak. 32 hex chars is what `openssl rand -hex
  // 16` produces; the docs suggest twice that.
  const approvalsSecret = parsed.APPROVALS_WEBHOOK_SECRET?.trim();
  if (approvalsSecret !== undefined && approvalsSecret.length < 32) {
    throw new Error(
      'APPROVALS_WEBHOOK_SECRET must be at least 32 characters — it is the only ' +
        'guard on a route that approves pull requests',
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
    pstackApiUrl: parsed.PSTACK_API_URL?.replace(/\/$/, ''),
    pstackApiToken: parsed.PSTACK_API_TOKEN,
    pstackPreviewDomain: parsed.PSTACK_PREVIEW_DOMAIN,
    pstackToleranceMs:
      parsed.PSTACK_TOLERANCE_MS === undefined
        ? undefined
        : parseDuration(
            parsed.PSTACK_TOLERANCE_MS,
            5 * 60_000,
            'PSTACK_TOLERANCE_MS',
          ),
    pstackCommandTimeoutMs: parseDuration(
      parsed.PSTACK_COMMAND_TIMEOUT_MS,
      10 * 60_000,
      'PSTACK_COMMAND_TIMEOUT_MS',
    ),
    prOpenedComment: parseBoolean(
      parsed.PR_OPENED_COMMENT,
      false,
      'PR_OPENED_COMMENT',
    ),
    approvalsWebhookSecret: approvalsSecret,
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

/**
 * A feature switch.
 *
 * Deliberately strict rather than truthy: `PR_OPENED_COMMENT=false` read as
 * "on" because the string is non-empty is the classic way a flag silently
 * means its opposite, and this one writes to every opened PR.
 */
function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(
    `${name} must be a boolean (true/false, 1/0, yes/no, on/off)`,
  );
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
