import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

function raw(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN----\\nkey\\n-----END----',
    GITHUB_APP_INSTALLATION_ID: '42',
    GITHUB_ORG: 'housing-cloud',
    GITHUB_ALLOWED_REPOS: 'web, api',
    GITHUB_WEBHOOK_SECRET: 'gh-secret',
    DOKPLOY_BASE_URL: 'https://dokploy.test/',
    DOKPLOY_API_KEY: 'dokploy-key',
    DOKPLOY_WEBHOOK_TOKEN: 'dokploy-token',
    DOKPLOY_REPO_APPLICATION_MAP: 'web:app-1:web-app,api:app-2',
    PSTACK_WEBHOOK_SECRET: 'whsec_pstack',
    PSTACK_REPO: 'web',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('loadEnv', () => {
  it('parses a complete environment', () => {
    const env = loadEnv(raw());
    expect(env.githubOrg).toBe('housing-cloud');
    expect([...env.githubAllowedRepos]).toEqual(['web', 'api']);
    expect(env.githubAppInstallationId).toBe(42);
    // Trailing slash trimmed so URLs never double up.
    expect(env.dokployBaseUrl).toBe('https://dokploy.test');
    expect(env.previewPollIntervalMs).toBe(30_000);
    expect(env.previewTimeoutMs).toBe(30 * 60_000);
    expect(env.port).toBe(8080);
  });

  it('decodes escaped newlines in the private key', () => {
    expect(loadEnv(raw()).githubAppPrivateKey).toContain('\n');
  });

  it('parses the repo → application map, defaulting the display name', () => {
    const env = loadEnv(raw());
    expect(env.repoApplications.get('web')).toEqual({
      applicationId: 'app-1',
      name: 'web-app',
    });
    expect(env.repoApplications.get('api')).toEqual({
      applicationId: 'app-2',
      name: 'api',
    });
  });

  it('rejects a mapped repo that is not allowed', () => {
    expect(() =>
      loadEnv(raw({ DOKPLOY_REPO_APPLICATION_MAP: 'other:app-9' })),
    ).toThrow(/not in GITHUB_ALLOWED_REPOS/);
  });

  it('rejects a malformed repo → application entry', () => {
    expect(() => loadEnv(raw({ DOKPLOY_REPO_APPLICATION_MAP: 'web' }))).toThrow(
      /repo:applicationId/,
    );
  });

  it('requires the Dokploy webhook token', () => {
    expect(() => loadEnv(raw({ DOKPLOY_WEBHOOK_TOKEN: undefined }))).toThrow();
  });

  it('requires a valid Dokploy base URL', () => {
    expect(() => loadEnv(raw({ DOKPLOY_BASE_URL: 'not-a-url' }))).toThrow();
  });

  it('rejects a non-positive installation id', () => {
    expect(() => loadEnv(raw({ GITHUB_APP_INSTALLATION_ID: '0' }))).toThrow(
      /positive integer/,
    );
  });

  it('rejects a sub-second poll interval', () => {
    expect(() => loadEnv(raw({ PREVIEW_POLL_INTERVAL_MS: '500' }))).toThrow(
      /PREVIEW_POLL_INTERVAL_MS/,
    );
  });

  it('accepts tuning overrides', () => {
    const env = loadEnv(
      raw({
        PREVIEW_POLL_INTERVAL_MS: '15000',
        PREVIEW_TIMEOUT_MS: '60000',
        PORT: '9090',
        EVENT_LOG_TOKEN: 'tok',
      }),
    );
    expect(env.previewPollIntervalMs).toBe(15_000);
    expect(env.previewTimeoutMs).toBe(60_000);
    expect(env.port).toBe(9090);
    expect(env.eventLogToken).toBe('tok');
  });

  it('parses the optional application → repo map', () => {
    const env = loadEnv(
      raw({ DOKPLOY_APPLICATION_REPO_MAP: 'hou/web:web,api:api' }),
    );
    expect(env.dokployApplicationRepoMap.get('hou/web')).toBe('web');
    expect(env.dokployApplicationRepoMap.get('api')).toBe('api');
  });
});
