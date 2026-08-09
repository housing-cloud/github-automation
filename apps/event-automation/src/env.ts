import { z } from 'zod';

const envSchema = z.object({
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY: z.string().min(1),
  GITHUB_APP_INSTALLATION_ID: z.string().min(1),
  GITHUB_ORG: z.string().min(1),
  GITHUB_ALLOWED_REPOS: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  DOKPLOY_BASE_URL: z.string().url(),
  DOKPLOY_API_KEY: z.string().min(1),
  DOKPLOY_WEBHOOK_TOKEN: z.string().min(1),
  DOKPLOY_REPO_APPLICATION_MAP: z.string().min(1),
  DOKPLOY_APPLICATION_REPO_MAP: z.string().optional(),
  PREVIEW_POLL_INTERVAL_MS: z.string().optional(),
  PREVIEW_TIMEOUT_MS: z.string().optional(),
  SLACK_WEBHOOK_URL: z.url().optional(),
  EVENT_LOG_LIMIT: z.string().optional(),
  EVENT_LOG_TOKEN: z.string().optional(),
  PORT: z.string().optional(),
});

/** A Dokploy application this service tracks previews for. */
export interface DokployApplicationRef {
  /** `applicationId` from Dokploy (the nanoid in the dashboard URL). */
  applicationId: string;
  /** Display name used in the check-run name and the PR comment. */
  name: string;
}

export interface AppEnv {
  githubAppId: string;
  githubAppPrivateKey: string;
  githubAppInstallationId: number;
  githubOrg: string;
  githubAllowedRepos: ReadonlySet<string>;
  githubWebhookSecret: string;
  /** Dokploy instance base URL, e.g. `https://dokploy.hou.example`. */
  dokployBaseUrl: string;
  /** Dokploy API key, sent as `x-api-key`. */
  dokployApiKey: string;
  /** Shared secret Dokploy sends back in the `x-webhook-token` header. */
  dokployWebhookToken: string;
  /** repo name -> the Dokploy application whose previews mirror its PRs. */
  repoApplications: ReadonlyMap<string, DokployApplicationRef>;
  /** `project/application` (or bare application) -> repo, for Dokploy events. */
  dokployApplicationRepoMap: ReadonlyMap<string, string>;
  /** How often the tracker re-reads a preview's status. Defaults to 30s. */
  previewPollIntervalMs: number;
  /** How long the tracker waits before failing the check. Defaults to 30m. */
  previewTimeoutMs: number;
  slackWebhookUrl?: string;
  /** Max rows retained by the in-memory event log (LRU). Defaults to 500. */
  eventLogLimit: number;
  /**
   * Optional bearer token gating the `/events` log page + JSON. When unset, the
   * log is publicly reachable.
   */
  eventLogToken?: string;
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

  const repoApplications = parseRepoApplicationMap(
    parsed.DOKPLOY_REPO_APPLICATION_MAP,
  );
  for (const repo of repoApplications.keys()) {
    if (!githubAllowedRepos.has(repo)) {
      throw new Error(
        `DOKPLOY_REPO_APPLICATION_MAP names repo "${repo}", which is not in GITHUB_ALLOWED_REPOS`,
      );
    }
  }

  return {
    githubAppId: parsed.GITHUB_APP_ID,
    githubAppPrivateKey: parsed.GITHUB_APP_PRIVATE_KEY.replaceAll('\\n', '\n'),
    githubAppInstallationId,
    githubOrg: parsed.GITHUB_ORG,
    githubAllowedRepos,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    dokployBaseUrl: parsed.DOKPLOY_BASE_URL.replace(/\/$/, ''),
    dokployApiKey: parsed.DOKPLOY_API_KEY,
    dokployWebhookToken: parsed.DOKPLOY_WEBHOOK_TOKEN,
    repoApplications,
    dokployApplicationRepoMap: parseApplicationRepoMap(
      parsed.DOKPLOY_APPLICATION_REPO_MAP,
    ),
    previewPollIntervalMs: parseDuration(
      parsed.PREVIEW_POLL_INTERVAL_MS,
      30_000,
      'PREVIEW_POLL_INTERVAL_MS',
    ),
    previewTimeoutMs: parseDuration(
      parsed.PREVIEW_TIMEOUT_MS,
      30 * 60_000,
      'PREVIEW_TIMEOUT_MS',
    ),
    slackWebhookUrl: parsed.SLACK_WEBHOOK_URL,
    eventLogLimit: parseEventLogLimit(parsed.EVENT_LOG_LIMIT),
    eventLogToken: parsed.EVENT_LOG_TOKEN,
    port: parsePort(parsed.PORT),
  };
}

function parseEventLogLimit(value: string | undefined): number {
  if (!value) return 500;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('EVENT_LOG_LIMIT must be a positive integer');
  }
  return limit;
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

/**
 * `repo:applicationId[:displayName]` entries, comma-separated. The display name
 * defaults to the repo name, which is what the check run is titled with.
 *
 *   DOKPLOY_REPO_APPLICATION_MAP="web:AbC123:web-app,api:XyZ789"
 */
function parseRepoApplicationMap(
  value: string,
): ReadonlyMap<string, DokployApplicationRef> {
  const map = new Map<string, DokployApplicationRef>();
  for (const entry of value.split(',')) {
    if (!entry.trim()) continue;
    const [repo, applicationId, name, ...extra] = entry
      .split(':')
      .map((part) => part.trim());
    if (!repo || !applicationId || extra.length > 0) {
      throw new Error(
        'DOKPLOY_REPO_APPLICATION_MAP entries must use repo:applicationId[:displayName] format',
      );
    }
    map.set(repo, { applicationId, name: name || repo });
  }
  if (map.size === 0) {
    throw new Error(
      'DOKPLOY_REPO_APPLICATION_MAP must include at least one entry',
    );
  }
  return map;
}

/**
 * `project/application:repo` (or `application:repo`) entries, comma-separated.
 * Dokploy notification payloads never name a git repo, so this trusted mapping
 * is the only way a Dokploy-sourced event gets one.
 */
function parseApplicationRepoMap(
  value: string | undefined,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const entry of value?.split(',') ?? []) {
    if (!entry.trim()) continue;
    const [application, repoName, ...extra] = entry
      .split(':')
      .map((part) => part.trim());
    if (!application || !repoName || extra.length > 0) {
      throw new Error(
        'DOKPLOY_APPLICATION_REPO_MAP entries must use application:repoName format',
      );
    }
    map.set(application, repoName);
  }
  return map;
}

function parsePort(value: string | undefined): number {
  if (!value) return 8080;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}
