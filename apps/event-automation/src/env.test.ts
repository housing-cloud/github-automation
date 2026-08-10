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
    expect(env.pstackRepo).toBe('web');
    expect(env.port).toBe(8080);
  });

  it('decodes escaped newlines in the private key', () => {
    expect(loadEnv(raw()).githubAppPrivateKey).toContain('\n');
  });

  it('defaults the watched services to db-seed and web', () => {
    expect([...loadEnv(raw()).pstackServices]).toEqual(['db-seed', 'web']);
  });

  it('parses an explicit service list', () => {
    const env = loadEnv(raw({ PSTACK_SERVICES: 'web, worker ,db-seed' }));
    expect([...env.pstackServices]).toEqual(['web', 'worker', 'db-seed']);
  });

  it('rejects an empty service list', () => {
    expect(() => loadEnv(raw({ PSTACK_SERVICES: ' , ' }))).toThrow(
      /PSTACK_SERVICES/,
    );
  });

  it('requires the pstack webhook secret', () => {
    expect(() => loadEnv(raw({ PSTACK_WEBHOOK_SECRET: undefined }))).toThrow();
  });

  it('rejects a pstack repo that is not allowed', () => {
    // The App would otherwise be asked to write checks to a repo the operator
    // never listed.
    expect(() => loadEnv(raw({ PSTACK_REPO: 'other' }))).toThrow(
      /not in GITHUB_ALLOWED_REPOS/,
    );
  });

  it('trims a trailing slash off the pstack base URL', () => {
    const env = loadEnv(raw({ PSTACK_BASE_URL: 'https://pstack.test/' }));
    expect(env.pstackBaseUrl).toBe('https://pstack.test');
  });

  it('rejects an invalid pstack base URL', () => {
    expect(() => loadEnv(raw({ PSTACK_BASE_URL: 'not-a-url' }))).toThrow();
  });

  it('leaves the tolerance unset so the plugin default applies', () => {
    expect(loadEnv(raw()).pstackToleranceMs).toBeUndefined();
  });

  it('rejects a sub-second replay tolerance', () => {
    expect(() => loadEnv(raw({ PSTACK_TOLERANCE_MS: '500' }))).toThrow(
      /PSTACK_TOLERANCE_MS/,
    );
  });

  it('rejects a non-positive installation id', () => {
    expect(() => loadEnv(raw({ GITHUB_APP_INSTALLATION_ID: '0' }))).toThrow(
      /positive integer/,
    );
  });

  it('accepts tuning overrides', () => {
    const env = loadEnv(
      raw({
        PSTACK_TOLERANCE_MS: '120000',
        PSTACK_PREVIEW_DOMAIN: 'preview.hou.test',
        PORT: '9090',
        EVENT_LOG_TOKEN: 'tok',
        EVENT_LOG_LIMIT: '25',
      }),
    );
    expect(env.pstackToleranceMs).toBe(120_000);
    expect(env.pstackPreviewDomain).toBe('preview.hou.test');
    expect(env.port).toBe(9090);
    expect(env.eventLogToken).toBe('tok');
    expect(env.eventLogLimit).toBe(25);
  });

  it('rejects a non-positive event log limit', () => {
    expect(() => loadEnv(raw({ EVENT_LOG_LIMIT: '0' }))).toThrow(
      /EVENT_LOG_LIMIT/,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadEnv(raw({ PORT: '70000' }))).toThrow(/PORT/);
  });
});
