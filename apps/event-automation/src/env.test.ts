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
    PSTACK_CHECKS_WEBHOOK_SECRET: 'checks-secret',
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
    expect(env.pstackChecksWebhookSecret).toBe('checks-secret');
    expect(env.flowRunDbPath).toBe('./data/flow-runs.sqlite');
    expect(env.flowRunLimit).toBe(200);
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

  it('requires the pstack checks cleanup webhook secret', () => {
    expect(() =>
      loadEnv(raw({ PSTACK_CHECKS_WEBHOOK_SECRET: undefined })),
    ).toThrow();
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
        FLOW_RUN_DB_PATH: '/data/custom.sqlite',
        FLOW_RUN_LIMIT: '75',
      }),
    );
    expect(env.pstackToleranceMs).toBe(120_000);
    expect(env.pstackPreviewDomain).toBe('preview.hou.test');
    expect(env.port).toBe(9090);
    expect(env.eventLogToken).toBe('tok');
    expect(env.eventLogLimit).toBe(25);
    expect(env.flowRunDbPath).toBe('/data/custom.sqlite');
    expect(env.flowRunLimit).toBe(75);
  });

  it('rejects a non-positive event log limit', () => {
    expect(() => loadEnv(raw({ EVENT_LOG_LIMIT: '0' }))).toThrow(
      /EVENT_LOG_LIMIT/,
    );
  });

  it('rejects a non-positive flow run limit', () => {
    expect(() => loadEnv(raw({ FLOW_RUN_LIMIT: '0' }))).toThrow(
      /FLOW_RUN_LIMIT/,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadEnv(raw({ PORT: '70000' }))).toThrow(/PORT/);
  });
});

describe('loadEnv — the pstack control-plane API', () => {
  it('leaves the API unconfigured by default', () => {
    const env = loadEnv(raw());
    expect(env.pstackApiUrl).toBeUndefined();
    expect(env.pstackApiToken).toBeUndefined();
  });

  it('accepts a URL and a token', () => {
    const env = loadEnv(
      raw({
        PSTACK_API_URL: 'https://api.preview.housing.cloud',
        PSTACK_API_TOKEN: 'pstack_pat_x',
      }),
    );
    expect(env.pstackApiUrl).toBe('https://api.preview.housing.cloud');
    expect(env.pstackApiToken).toBe('pstack_pat_x');
  });

  /** The client joins paths onto this, so a trailing slash would double up. */
  it('normalises a trailing slash', () => {
    expect(
      loadEnv(raw({ PSTACK_API_URL: 'https://api.preview.housing.cloud/' }))
        .pstackApiUrl,
    ).toBe('https://api.preview.housing.cloud');
  });

  it('rejects a URL that is not one', () => {
    expect(() => loadEnv(raw({ PSTACK_API_URL: 'api.preview' }))).toThrow();
  });

  /**
   * A token without a URL means someone configured the API and mistyped the
   * variable name. Silently ignoring it would leave the commands off with no
   * sign of why.
   */
  it('rejects a token with no URL', () => {
    expect(() => loadEnv(raw({ PSTACK_API_TOKEN: 'pstack_pat_x' }))).toThrow(
      /PSTACK_API_URL/,
    );
  });

  it('allows an unauthenticated API, which pstack permits', () => {
    expect(
      loadEnv(raw({ PSTACK_API_URL: 'https://api.preview.housing.cloud' }))
        .pstackApiToken,
    ).toBeUndefined();
  });

  it('defaults the command timeout to ten minutes', () => {
    expect(loadEnv(raw()).pstackCommandTimeoutMs).toBe(600_000);
  });

  it('parses an explicit command timeout', () => {
    expect(
      loadEnv(raw({ PSTACK_COMMAND_TIMEOUT_MS: '90000' }))
        .pstackCommandTimeoutMs,
    ).toBe(90_000);
  });

  it('rejects a command timeout that is not a positive number', () => {
    for (const value of ['0', '-1', 'soon']) {
      expect(() => loadEnv(raw({ PSTACK_COMMAND_TIMEOUT_MS: value }))).toThrow(
        /PSTACK_COMMAND_TIMEOUT_MS/,
      );
    }
  });
});

describe('loadEnv — PR_OPENED_COMMENT', () => {
  it('is off unless asked for', () => {
    expect(loadEnv(raw()).prOpenedComment).toBe(false);
  });

  it('accepts the usual ways of writing yes', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on', ' true ']) {
      expect(loadEnv(raw({ PR_OPENED_COMMENT: value })).prOpenedComment).toBe(
        true,
      );
    }
  });

  /**
   * The failure this rules out: a truthy check would read `false` as "on",
   * because it is a non-empty string. This flag writes to every opened PR, so
   * silently meaning its opposite is the expensive direction.
   */
  it('reads every spelling of no as off', () => {
    for (const value of ['false', 'FALSE', '0', 'no', 'off', '']) {
      expect(loadEnv(raw({ PR_OPENED_COMMENT: value })).prOpenedComment).toBe(
        false,
      );
    }
  });

  it('rejects a value that is neither', () => {
    expect(() => loadEnv(raw({ PR_OPENED_COMMENT: 'maybe' }))).toThrow(
      /PR_OPENED_COMMENT/,
    );
  });
});

describe('loadEnv — APPROVALS_WEBHOOK_SECRET', () => {
  const Key = 'a'.repeat(32);

  /** Unset disables the route; there is no safe default for approving PRs. */
  it('is unset by default', () => {
    expect(loadEnv(raw()).approvalsWebhookSecret).toBeUndefined();
  });

  it('accepts a long enough key', () => {
    expect(
      loadEnv(raw({ APPROVALS_WEBHOOK_SECRET: Key })).approvalsWebhookSecret,
    ).toBe(Key);
  });

  /**
   * This key is the entire authorization story for a route that approves pull
   * requests, and it is accepted in a query string. A short one is both
   * guessable and easy to leak, so it is refused at startup rather than in
   * review.
   */
  it('rejects a key short enough to guess', () => {
    for (const value of ['x', 'hunter2', 'a'.repeat(31)]) {
      expect(() => loadEnv(raw({ APPROVALS_WEBHOOK_SECRET: value }))).toThrow(
        /APPROVALS_WEBHOOK_SECRET/,
      );
    }
  });

  it('does not let surrounding whitespace pad a short key', () => {
    expect(() =>
      loadEnv(raw({ APPROVALS_WEBHOOK_SECRET: `  ${'a'.repeat(20)}  ` })),
    ).toThrow(/APPROVALS_WEBHOOK_SECRET/);
  });
});
