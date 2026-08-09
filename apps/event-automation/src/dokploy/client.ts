/**
 * Minimal REST client for the Dokploy instance.
 *
 * Dokploy exposes its tRPC routers over REST at `<base>/api/<router>.<action>`
 * (docs.dokploy.com/docs/api), authenticated with the `x-api-key` header.
 * Queries are `GET` with the input as query params; mutations are `POST` with a
 * JSON body. Only the slice this service needs is modelled here — the deploy /
 * redeploy mutations come from `@samyx/gha-plugin-dokploy`'s handlers.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Dokploy's `applicationStatus` enum (`packages/server/src/db/schema/shared.ts`).
 * A preview deployment starts `idle`, flips to `running` when its queue job is
 * picked up, then settles on `done` or `error`.
 */
export type DokployStatus = 'idle' | 'running' | 'done' | 'error';

/** One row of `previewDeployments`, as `previewDeployment.all` returns it. */
export interface DokployPreviewDeployment {
  previewDeploymentId: string;
  applicationId: string;
  appName: string;
  branch: string;
  pullRequestId: string;
  pullRequestNumber: string;
  pullRequestURL: string;
  pullRequestTitle: string;
  previewStatus: DokployStatus;
  createdAt: string;
  expiresAt?: string | null;
  domain?: { host?: string | null; https?: boolean | null } | null;
}

export interface DokployClientOptions {
  /** Instance base URL, e.g. `https://dokploy.hou.example`. */
  baseUrl: string;
  /** API key, sent as `x-api-key`. */
  apiKey: string;
  fetch?: typeof fetch;
}

export class DokployClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly applicationUrls = new Map<string, string>();

  constructor(options: DokployClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Preview deployments of one application. This is the polling source of
   * truth: Dokploy emits no webhook when a *preview* build starts or settles
   * (only the org-wide build notifications, which never name a PR), so the
   * status has to be read back.
   */
  async listPreviewDeployments(
    applicationId: string,
  ): Promise<DokployPreviewDeployment[]> {
    const rows = await this.query('previewDeployment.all', { applicationId });
    return Array.isArray(rows) ? (rows as DokployPreviewDeployment[]) : [];
  }

  /** Redeploy one preview deployment (`previewDeployment.redeploy`). */
  async redeployPreview(previewDeploymentId: string): Promise<void> {
    await this.mutate('previewDeployment.redeploy', { previewDeploymentId });
  }

  /**
   * The dashboard URL of an application, memoized.
   *
   * Dokploy's own deep link is
   * `/dashboard/project/<projectId>/environment/<environmentId>/services/application/<applicationId>`
   * (see `buildLink` in `packages/server/src/services/application.ts`), so the
   * project + environment ids have to be read off `application.one` first. They
   * never change for a given application, hence the cache — the 30s poll must
   * not re-fetch them on every tick.
   */
  async applicationUrl(applicationId: string): Promise<string> {
    const cached = this.applicationUrls.get(applicationId);
    if (cached) return cached;

    const fallback = `${this.baseUrl}/dashboard`;
    try {
      const application = (await this.query('application.one', {
        applicationId,
      })) as
        | {
            environmentId?: string;
            environment?: { projectId?: string };
          }
        | undefined;
      const environmentId = application?.environmentId;
      const projectId = application?.environment?.projectId;
      if (!environmentId || !projectId) return fallback;

      const url = `${this.baseUrl}/dashboard/project/${projectId}/environment/${environmentId}/services/application/${applicationId}?tab=previewDeployments`;
      this.applicationUrls.set(applicationId, url);
      return url;
    } catch {
      // The link is cosmetic — never fail a deployment report over it.
      return fallback;
    }
  }

  private async query(
    action: string,
    input: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/api/${action}`);
    for (const [key, value] of Object.entries(input)) {
      url.searchParams.set(key, value);
    }
    return this.request(action, url.toString(), { method: 'GET' });
  }

  private async mutate(
    action: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(action, `${this.baseUrl}/api/${action}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  private async request(
    action: string,
    url: string,
    init: RequestInit,
  ): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': this.apiKey,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `dokploy ${action} failed with ${response.status}${
          detail ? `: ${detail.slice(0, 200)}` : ''
        }`,
      );
    }
    return response.json().catch(() => undefined);
  }
}

/** The public URL of a preview deployment, or undefined before its domain exists. */
export function previewUrl(
  preview: DokployPreviewDeployment,
): string | undefined {
  const host = preview.domain?.host;
  if (!host) return undefined;
  return `${preview.domain?.https ? 'https' : 'http'}://${host}`;
}
