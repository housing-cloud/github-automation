import { createHmac } from 'node:crypto';
import { noopLogger } from '@samyx/github-automation-suite';
import { describe, expect, it, vi } from 'vitest';
import { createEventAutomation } from './app';
import type { AppEnv } from './env';
import type { TrackerOctokit } from './github/checks';
import { PreviewTracker } from './preview/tracker';
import type { DokployClient, DokployPreviewDeployment } from './dokploy/client';

const DOKPLOY_BASE_URL = 'https://dokploy.test';

/** Hono's `fetch` may answer synchronously; tests only ever await it. */
type HonoLike = { fetch: (request: Request) => Response | Promise<Response> };

function env(overrides: Partial<AppEnv> = {}): AppEnv {
  return {
    githubAppId: '1',
    githubAppPrivateKey: 'key',
    githubAppInstallationId: 1,
    githubOrg: 'housing-cloud',
    githubAllowedRepos: new Set(['repo-a']),
    githubWebhookSecret: 'github-secret',
    dokployBaseUrl: DOKPLOY_BASE_URL,
    dokployApiKey: 'dokploy-api-key',
    dokployWebhookToken: 'dokploy-webhook-token',
    repoApplications: new Map([
      ['repo-a', { applicationId: 'app-1', name: 'repo-a' }],
    ]),
    dokployApplicationRepoMap: new Map([['hou/repo-a', 'repo-a']]),
    previewPollIntervalMs: 30_000,
    previewTimeoutMs: 30 * 60_000,
    eventLogLimit: 500,
    port: 8080,
    ...overrides,
  };
}

/** A mock Octokit recording the check-run and comment calls the tracker makes. */
function mockOctokit(): TrackerOctokit & {
  checkRuns: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
} {
  const checkRuns: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
  let nextId = 100;
  return {
    checkRuns,
    comments,
    rest: {
      checks: {
        create: vi.fn(async (params) => {
          checkRuns.push({ op: 'create', ...params });
          return { data: { id: nextId++ } };
        }),
        update: vi.fn(async (params) => {
          checkRuns.push({ op: 'update', ...params });
          return {};
        }),
        listForRef: vi.fn(async () => ({ data: { check_runs: [] } })),
      },
      actions: { createWorkflowDispatch: vi.fn(async () => ({})) },
      repos: { createDispatchEvent: vi.fn(async () => ({})) },
      issues: {
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
        createComment: vi.fn(async (params) => {
          comments.push({ op: 'create', ...params });
          return { data: { id: nextId++ } };
        }),
        updateComment: vi.fn(async (params) => {
          comments.push({ op: 'update', ...params });
          return {};
        }),
        listComments: vi.fn(async () => ({ data: [] })),
      },
    },
  };
}

/** A Dokploy client returning a scripted sequence of preview statuses. */
function stubDokploy(
  sequence: Array<DokployPreviewDeployment[] | Error>,
): DokployClient {
  let index = 0;
  return {
    listPreviewDeployments: vi.fn(async () => {
      const next = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next ?? [];
    }),
    redeployPreview: vi.fn(async () => {}),
    applicationUrl: vi.fn(
      async (applicationId: string) =>
        `${DOKPLOY_BASE_URL}/dashboard/project/proj-1/environment/env-1/services/application/${applicationId}?tab=previewDeployments`,
    ),
  } as unknown as DokployClient;
}

function preview(
  previewStatus: DokployPreviewDeployment['previewStatus'],
  overrides: Partial<DokployPreviewDeployment> = {},
): DokployPreviewDeployment {
  return {
    previewDeploymentId: 'prev-1',
    applicationId: 'app-1',
    appName: 'preview-abc123',
    branch: 'feature',
    pullRequestId: '9001',
    pullRequestNumber: '3',
    pullRequestURL: 'https://github.com/housing-cloud/repo-a/pull/3',
    pullRequestTitle: 'Add a thing',
    previewStatus,
    createdAt: '2026-08-09T00:00:00.000Z',
    domain: { host: 'preview-abc123.hou.test', https: true },
    ...overrides,
  };
}

/** A tracker whose polls resolve immediately, so tests do not wait 30s. */
function fastTracker(
  octokit: TrackerOctokit,
  dokploy: DokployClient,
  overrides: Partial<ConstructorParameters<typeof PreviewTracker>[0]> = {},
): PreviewTracker {
  return new PreviewTracker({
    dokploy,
    octokit,
    dokployBaseUrl: DOKPLOY_BASE_URL,
    logger: noopLogger,
    pollIntervalMs: 30_000,
    timeoutMs: 30 * 60_000,
    sleep: async () => {},
    ...overrides,
  });
}

function githubSig(raw: string): string {
  return `sha256=${createHmac('sha256', 'github-secret').update(raw).digest('hex')}`;
}

function githubPrBody(
  action: 'opened' | 'synchronize' | 'closed',
  options: { fork?: boolean; repo?: string } = {},
): string {
  const fork = options.fork ?? false;
  const repo = options.repo ?? 'repo-a';
  return JSON.stringify({
    action,
    number: 3,
    pull_request: {
      head: {
        sha: 'abc1234567890',
        ref: 'feature',
        repo: {
          full_name: fork ? `someone/${repo}` : `housing-cloud/${repo}`,
          name: repo,
          owner: { login: fork ? 'someone' : 'housing-cloud' },
        },
      },
      base: { ref: 'main' },
      labels: [],
    },
    repository: {
      name: repo,
      full_name: `housing-cloud/${repo}`,
      owner: { login: 'housing-cloud' },
    },
  });
}

function postGithub(
  app: HonoLike,
  body: string,
  delivery: string,
  event = 'pull_request',
) {
  return app.fetch(
    new Request('http://local/webhooks/github', {
      method: 'POST',
      headers: {
        'x-github-event': event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': githubSig(body),
      },
      body,
    }),
  );
}

function dokployBody(status: 'success' | 'error' = 'success'): string {
  return JSON.stringify({
    title: status === 'success' ? 'Build Success' : 'Build Failed',
    message: 'Build completed',
    projectName: 'hou',
    applicationName: 'repo-a',
    applicationType: 'application',
    buildLink: `${DOKPLOY_BASE_URL}/dashboard/application/app-1`,
    timestamp: '2026-08-09T00:00:00.000Z',
    domains: 'repo-a.hou.test',
    status,
    type: 'build',
    ...(status === 'error' ? { errorMessage: 'boom' } : {}),
  });
}

function postDokploy(
  app: HonoLike,
  body: string,
  token = 'dokploy-webhook-token',
) {
  return app.fetch(
    new Request('http://local/webhooks/dokploy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-token': token,
      },
      body,
    }),
  );
}

async function buildApp(
  overrides: {
    envOverrides?: Partial<AppEnv>;
    octokit?: ReturnType<typeof mockOctokit>;
    dokploy?: DokployClient;
    fetch?: typeof fetch;
  } = {},
) {
  const octokit = overrides.octokit ?? mockOctokit();
  const dokploy = overrides.dokploy ?? stubDokploy([[preview('done')]]);
  const tracker = fastTracker(octokit, dokploy);
  const built = await createEventAutomation({
    env: env(overrides.envOverrides),
    octokit,
    logger: noopLogger,
    fetch: overrides.fetch,
    tracker,
  });
  return { ...built, octokit, dokploy };
}

/** Let the fire-and-forget tracker loop drain before asserting. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('event-automation app (GitHub + Dokploy)', () => {
  it('opens an in-progress check and a PR comment when a PR is opened', async () => {
    const { app, octokit } = await buildApp({
      dokploy: stubDokploy([[preview('running')], [preview('done')]]),
    });

    const res = await postGithub(app, githubPrBody('opened'), 'd-open');
    expect(res.status).toBe(200);
    await drain();

    const created = octokit.checkRuns.find((call) => call.op === 'create');
    expect(created).toMatchObject({
      owner: 'housing-cloud',
      repo: 'repo-a',
      name: 'dokploy/repo-a (preview)',
      head_sha: 'abc1234567890',
      status: 'in_progress',
    });

    const comment = octokit.comments.find((call) => call.op === 'create');
    expect(comment).toMatchObject({ issue_number: 3 });
    expect(String(comment?.body)).toContain('Dokploy preview deployment');
  });

  it('marks the check successful when the preview reaches done', async () => {
    const { app, octokit } = await buildApp({
      dokploy: stubDokploy([[preview('done')]]),
    });

    await postGithub(app, githubPrBody('opened'), 'd-done');
    await drain();

    const completed = octokit.checkRuns.find(
      (call) => call.status === 'completed',
    );
    expect(completed).toMatchObject({
      status: 'completed',
      conclusion: 'success',
    });
  });

  it('marks the check failed when the preview errors', async () => {
    const { app, octokit } = await buildApp({
      dokploy: stubDokploy([[preview('error')]]),
    });

    await postGithub(app, githubPrBody('opened'), 'd-error');
    await drain();

    const completed = octokit.checkRuns.find(
      (call) => call.status === 'completed',
    );
    expect(completed).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
    });
  });

  it('posts the preview URL and instance details in the PR comment', async () => {
    const { app, octokit } = await buildApp({
      dokploy: stubDokploy([[preview('done')]]),
    });

    await postGithub(app, githubPrBody('opened'), 'd-url');
    await drain();

    const bodies = octokit.comments.map((call) => String(call.body));
    const settled = bodies.find((body) => body.includes('Ready'));
    expect(settled).toBeDefined();
    expect(settled).toContain('https://preview-abc123.hou.test');
    expect(settled).toContain(DOKPLOY_BASE_URL);
    expect(settled).toContain('preview-abc123');
  });

  it('edits the same comment instead of posting a new one on each poll', async () => {
    const { app, octokit } = await buildApp({
      dokploy: stubDokploy([[preview('running')], [preview('done')]]),
    });

    await postGithub(app, githubPrBody('opened'), 'd-edit');
    await drain();

    const creates = octokit.comments.filter((call) => call.op === 'create');
    const updates = octokit.comments.filter((call) => call.op === 'update');
    expect(creates).toHaveLength(1);
    expect(updates.length).toBeGreaterThan(0);
  });

  it('keeps polling through a transient Dokploy failure', async () => {
    const { app, octokit } = await buildApp({
      dokploy: stubDokploy([new Error('dokploy 502'), [preview('done')]]),
    });

    await postGithub(app, githubPrBody('opened'), 'd-flaky');
    await drain();

    expect(
      octokit.checkRuns.find((call) => call.conclusion === 'success'),
    ).toBeDefined();
  });

  it('ignores a repo with no Dokploy application mapped', async () => {
    const { app, octokit } = await buildApp({
      envOverrides: {
        githubAllowedRepos: new Set(['repo-a', 'repo-b']),
        repoApplications: new Map([
          ['repo-a', { applicationId: 'app-1', name: 'repo-a' }],
        ]),
      },
    });

    const res = await postGithub(
      app,
      githubPrBody('opened', { repo: 'repo-b' }),
      'd-unmapped',
    );
    expect(res.status).toBe(200);
    await drain();
    expect(octokit.checkRuns).toHaveLength(0);
  });

  it('ignores fork PRs', async () => {
    const { app, octokit } = await buildApp();
    const res = await postGithub(
      app,
      githubPrBody('opened', { fork: true }),
      'd-fork',
    );
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe('fork-pr');
    await drain();
    expect(octokit.checkRuns).toHaveLength(0);
  });

  it('does not track a closed PR', async () => {
    const { app, octokit } = await buildApp();
    await postGithub(app, githubPrBody('closed'), 'd-closed');
    await drain();
    expect(octokit.checkRuns).toHaveLength(0);
  });

  it('accepts a Dokploy webhook carrying the shared token', async () => {
    const { app } = await buildApp();
    const res = await postDokploy(app, dokployBody('success'));
    expect(res.status).toBe(200);
  });

  it('rejects a Dokploy webhook with a bad token', async () => {
    const { app } = await buildApp();
    const res = await postDokploy(app, dokployBody('success'), 'wrong');
    expect(res.status).toBe(401);
  });

  it('posts to Slack on a Dokploy failure when configured', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const { app } = await buildApp({
      envOverrides: { slackWebhookUrl: 'https://hooks.test/slack' },
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await postDokploy(app, dokployBody('error'));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('serves /health and /previews', async () => {
    const { app } = await buildApp();
    expect((await app.fetch(new Request('http://local/health'))).status).toBe(
      200,
    );
    const previews = await app.fetch(new Request('http://local/previews'));
    expect(previews.status).toBe(200);
    expect(await previews.json()).toMatchObject({ count: 0 });
  });

  it('logs received webhooks at /events and /events/json', async () => {
    const { app } = await buildApp();
    await postDokploy(app, dokployBody('success'));

    const page = await app.fetch(new Request('http://local/events'));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');

    const json = await app.fetch(new Request('http://local/events/json'));
    const payload = (await json.json()) as {
      count: number;
      events: Array<{ source: string; type: string }>;
    };
    expect(payload.count).toBe(1);
    expect(payload.events[0]).toMatchObject({
      source: 'dokploy',
      type: 'build.success',
    });
  });

  it('serves a discovery index at / and /discovery.json', async () => {
    const { app } = await buildApp();

    const index = await app.fetch(new Request('http://local/'));
    expect(index.status).toBe(200);

    const json = await app.fetch(new Request('http://local/discovery.json'));
    const doc = (await json.json()) as {
      routes: Array<{ method: string; path: string }>;
    };
    const paths = doc.routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'POST /webhooks/github',
        'POST /webhooks/dokploy',
        'GET /health',
        'GET /previews',
        'GET /events',
        'GET /events/json',
      ]),
    );
  });

  it('gates /events behind a token when EVENT_LOG_TOKEN is set', async () => {
    const { app } = await buildApp({
      envOverrides: { eventLogToken: 's3cr3t' },
    });

    expect((await app.fetch(new Request('http://local/events'))).status).toBe(
      401,
    );
    const withHeader = await app.fetch(
      new Request('http://local/events', {
        headers: { authorization: 'Bearer s3cr3t' },
      }),
    );
    expect(withHeader.status).toBe(200);

    const withQuery = await app.fetch(
      new Request('http://local/events/json?token=s3cr3t'),
    );
    expect(withQuery.status).toBe(200);
  });
});
