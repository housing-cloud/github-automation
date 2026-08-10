import { createHmac } from 'node:crypto';
import { noopLogger } from '@samyx/github-automation-suite';
import { describe, expect, it, vi } from 'vitest';
import { createEventAutomation } from './app';
import type { AppEnv } from './env';
import type { AppOctokit } from './github/checks';

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
    pstackWebhookSecret: 'pstack-secret',
    pstackRepo: 'repo-a',
    pstackServices: ['db-seed', 'web'],
    pstackBaseUrl: 'https://pstack.test',
    pstackPreviewDomain: 'preview.hou.test',
    eventLogLimit: 500,
    port: 8080,
    ...overrides,
  };
}

/** A mock Octokit recording the check-run and comment calls the app makes. */
function mockOctokit(): AppOctokit & {
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
      pulls: {
        get: vi.fn(async () => ({ data: { head: { sha: 'head-sha' } } })),
      },
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

function githubSig(raw: string): string {
  return `sha256=${createHmac('sha256', 'github-secret').update(raw).digest('hex')}`;
}

function githubPrBody(
  action: 'opened' | 'synchronize' | 'closed',
  options: { fork?: boolean; repo?: string; number?: number } = {},
): string {
  const fork = options.fork ?? false;
  const repo = options.repo ?? 'repo-a';
  const number = options.number ?? 16828;
  return JSON.stringify({
    action,
    number,
    pull_request: {
      number,
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

async function buildApp(
  overrides: {
    envOverrides?: Partial<AppEnv>;
    octokit?: ReturnType<typeof mockOctokit>;
    fetch?: typeof fetch;
  } = {},
) {
  const octokit = overrides.octokit ?? mockOctokit();
  const built = await createEventAutomation({
    env: env(overrides.envOverrides),
    octokit,
    logger: noopLogger,
    fetch: overrides.fetch,
  });
  return { ...built, octokit };
}

/** Let any queued async handler work drain before asserting. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Post a pstack envelope, signed exactly as pstack signs it. */
async function postPstack(
  app: HonoLike,
  envelope: { id: string; event: string; at: number; data: unknown },
  secret = 'pstack-secret',
): Promise<Response> {
  const body = JSON.stringify(envelope);
  const signature = `sha256=${createHmac('sha256', secret)
    .update(`${envelope.at}.${body}`)
    .digest('hex')}`;
  return await app.fetch(
    new Request('http://local/webhooks/preview-stacks', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pstack-event': envelope.event,
        'x-pstack-delivery': envelope.id,
        'x-pstack-timestamp': String(envelope.at),
        'x-pstack-signature': signature,
      },
      body,
    }),
  );
}

describe('event-automation app (pstack preview stacks)', () => {
  /**
   * The full requirement 1–4 path over real HTTP: a signed pstack delivery
   * lands, the signature is verified by the plugin, the rule matches, and the
   * checks + comment are written.
   */
  it('opens the three checks from a signed job.started delivery', async () => {
    const { app, octokit } = await buildApp();

    const res = await postPstack(app, {
      id: 'evt_msnflk07_2_i9xr14',
      event: 'job.started',
      at: Date.now(),
      data: {
        jobId: 'up-pr-16828-1-j5cfw8',
        stack: 'pr-16828',
        action: 'up',
        startedAt: 1786378437511,
      },
    });
    expect(res.status).toBe(200);
    await drain();

    const created = octokit.checkRuns.filter((c) => c.op === 'create');
    expect(created.map((c) => c.name)).toEqual([
      'pstack/stack',
      'pstack/db-seed',
      'pstack/web',
    ]);
    expect(created.every((c) => c.status === 'in_progress')).toBe(true);
  });

  it('rejects a pstack delivery with a bad signature', async () => {
    const { app, octokit } = await buildApp();

    const res = await postPstack(
      app,
      {
        id: 'evt_bad',
        event: 'stack.ready',
        at: Date.now(),
        data: { stack: 'pr-16828', containers: 1, ready: 1 },
      },
      'wrong-secret',
    );

    expect(res.status).toBe(401);
    await drain();
    expect(octokit.checkRuns).toHaveLength(0);
  });

  it('rejects a replayed pstack delivery outside the tolerance window', async () => {
    const { app, octokit } = await buildApp();

    const res = await postPstack(app, {
      id: 'evt_old',
      event: 'stack.ready',
      at: Date.now() - 60 * 60_000,
      data: { stack: 'pr-16828', containers: 1, ready: 1 },
    });

    expect(res.status).toBe(401);
    await drain();
    expect(octokit.checkRuns).toHaveLength(0);
  });

  it('drives the whole sequence to a failed web check and a PR comment', async () => {
    const { app, octokit } = await buildApp();
    const at = Date.now();

    await postPstack(app, {
      id: 'evt_msnflk07_2_i9xr14',
      event: 'job.started',
      at,
      data: { jobId: 'up-pr-16828-1', stack: 'pr-16828', action: 'up' },
    });
    await drain();
    await postPstack(app, {
      id: 'evt_seed_ready',
      event: 'container.ready',
      at,
      data: {
        stack: 'pr-16828',
        container: 'pr-16828-db-seed-1',
        service: 'db-seed',
        state: 'exited',
        health: null,
        hasHealthcheck: false,
      },
    });
    await drain();
    // The real timeout payload: `web` shows up only in pendingContainers.
    await postPstack(app, {
      id: 'evt_msnhilf4_a_vuiop4',
      event: 'stack.timedout',
      at,
      data: {
        stack: 'pr-16828',
        state: 'timedout',
        containers: 4,
        ready: 3,
        failedContainers: [],
        pendingContainers: ['pr-16828-web-1'],
        durationMs: 181738,
        reachable: true,
      },
    });
    await drain();

    // db-seed passed, web failed, stack failed — and nothing left pending.
    const summaries = octokit.checkRuns
      .filter((c) => c.op === 'update')
      .map((c) => (c.output as { title: string } | undefined)?.title ?? '');
    expect(summaries).toContain('db-seed ready');
    expect(summaries).toContain('web did not become ready');
    expect(summaries).toContain('Preview stack did not come up');

    const comment = octokit.comments.at(-1);
    expect(comment?.issue_number).toBe(16828);
    expect(String(comment?.body)).toContain('pr-16828-web-1');
  });

  it('ignores a pstack Test-button delivery', async () => {
    const { app, octokit } = await buildApp();

    const res = await postPstack(app, {
      id: 'evt_test',
      event: 'job.succeeded',
      at: Date.now(),
      data: { stack: 'pr-16828', action: 'up', test: true },
    });

    expect(res.status).toBe(200);
    await drain();
    expect(octokit.checkRuns).toHaveLength(0);
  });

  it('ignores a stack that does not name a pull request', async () => {
    const { app, octokit } = await buildApp();

    await postPstack(app, {
      id: 'evt_staging',
      event: 'stack.ready',
      at: Date.now(),
      data: { stack: 'staging', containers: 2, ready: 2 },
    });
    await drain();

    expect(octokit.checkRuns).toHaveLength(0);
  });
});

describe('event-automation app (GitHub ingress)', () => {
  /**
   * The GitHub plugin is still mounted, and the closed-PR rule is what keeps a
   * long-running instance from accumulating one state entry per PR it ever saw.
   */
  it('releases a stack’s state when its PR closes', async () => {
    const { app, pstack } = await buildApp();

    await postPstack(app, {
      id: 'evt_open',
      event: 'job.started',
      at: Date.now(),
      data: { stack: 'pr-16828', action: 'up' },
    });
    await drain();
    expect(pstack.active).toEqual(['pr-16828']);

    const res = await postGithub(app, githubPrBody('closed'), 'd-close');
    expect(res.status).toBe(200);
    await drain();

    expect(pstack.active).toEqual([]);
  });

  it('keeps other PRs’ state when one closes', async () => {
    const { app, pstack } = await buildApp();

    for (const stack of ['pr-16828', 'pr-2']) {
      await postPstack(app, {
        id: `evt_${stack}`,
        event: 'job.started',
        at: Date.now(),
        data: { stack, action: 'up' },
      });
      await drain();
    }
    expect(pstack.active).toHaveLength(2);

    await postGithub(app, githubPrBody('closed'), 'd-close-one');
    await drain();

    expect(pstack.active).toEqual(['pr-2']);
  });

  it('rejects a GitHub webhook with a bad signature', async () => {
    const { app } = await buildApp();

    const res = await app.fetch(
      new Request('http://local/webhooks/github', {
        method: 'POST',
        headers: {
          'x-github-event': 'pull_request',
          'x-github-delivery': 'd-forged',
          'x-hub-signature-256': 'sha256=deadbeef',
        },
        body: githubPrBody('closed'),
      }),
    );

    expect(res.status).toBe(401);
  });

  it('ignores a repo outside GITHUB_ALLOWED_REPOS', async () => {
    const { app, pstack } = await buildApp();

    await postPstack(app, {
      id: 'evt_other',
      event: 'job.started',
      at: Date.now(),
      data: { stack: 'pr-16828', action: 'up' },
    });
    await drain();

    await postGithub(
      app,
      githubPrBody('closed', { repo: 'not-allowed' }),
      'd-other-repo',
    );
    await drain();

    // The close was not acted on, so the stack is still tracked.
    expect(pstack.active).toEqual(['pr-16828']);
  });
});

describe('event-automation app (platform routes)', () => {
  it('serves /health and /previews', async () => {
    const { app } = await buildApp();
    expect((await app.fetch(new Request('http://local/health'))).status).toBe(
      200,
    );
    const previews = await app.fetch(new Request('http://local/previews'));
    expect(previews.status).toBe(200);
    expect(await previews.json()).toMatchObject({ count: 0, stacks: [] });
  });

  it('reports the stacks it is tracking at /previews', async () => {
    const { app } = await buildApp();
    await postPstack(app, {
      id: 'evt_track',
      event: 'job.started',
      at: Date.now(),
      data: { stack: 'pr-16828', action: 'up' },
    });
    await drain();

    const previews = await app.fetch(new Request('http://local/previews'));
    expect(await previews.json()).toMatchObject({
      count: 1,
      stacks: ['pr-16828'],
    });
  });

  it('logs received webhooks at /events and /events/json', async () => {
    const { app } = await buildApp();
    await postPstack(app, {
      id: 'evt_logged',
      event: 'stack.ready',
      at: Date.now(),
      data: { stack: 'pr-16828', containers: 1, ready: 1 },
    });
    await drain();

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
      source: 'preview-stacks',
      type: 'stack.ready',
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
        'POST /webhooks/preview-stacks',
        'GET /health',
        'GET /previews',
        'GET /events',
        'GET /events/json',
      ]),
    );
    // The Dokploy ingress is gone, so nothing may still advertise it.
    expect(paths).not.toContain('POST /webhooks/dokploy');
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

  it('no longer exposes a Dokploy webhook route', async () => {
    const { app } = await buildApp();
    const res = await app.fetch(
      new Request('http://local/webhooks/dokploy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(404);
  });
});
