import { createHmac } from 'node:crypto';
import { MemoryFlowRunStore, noopLogger } from '@samyx/github-automation-suite';
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
    pstackChecksWebhookSecret: 'checks-secret',
    pstackRepo: 'repo-a',
    pstackServices: ['db-seed', 'web'],
    pstackBaseUrl: 'https://pstack.test',
    pstackPreviewDomain: 'preview.hou.test',
    eventLogLimit: 500,
    pstackCommandTimeoutMs: 10 * 60_000,
    prOpenedComment: false,
    flowRunDbPath: ':memory:',
    flowRunLimit: 200,
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
          const id = nextId++;
          checkRuns.push({ op: 'create', id, ...params });
          return { data: { id } };
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
        list: vi.fn(async () => ({ data: [] })),
      },
      issues: {
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
        removeLabel: vi.fn(async () => ({})),
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
    logger?: typeof noopLogger;
  } = {},
) {
  const octokit = overrides.octokit ?? mockOctokit();
  const built = await createEventAutomation({
    env: env(overrides.envOverrides),
    octokit,
    logger: overrides.logger ?? noopLogger,
    fetch: overrides.fetch,
    flowRuns: new MemoryFlowRunStore(),
  });
  return { ...built, octokit };
}

/** Let any queued async handler work drain before asserting. */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

interface LogLine {
  level: string;
  fields: Record<string, unknown>;
  message: string;
}

/** A logger that keeps what was written, for asserting on operator-facing logs. */
function recordingLogger(lines: LogLine[]): typeof noopLogger {
  const record =
    (level: string) =>
    (value: unknown, message?: string): void => {
      lines.push({
        level,
        fields:
          typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>)
            : {},
        message: message ?? (typeof value === 'string' ? value : ''),
      });
    };
  return {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

/**
 * Latest state written for a named check run. `create` carries the name and
 * `update` only the id it returned, so the two have to be joined.
 */
function latestCheck(calls: Array<Record<string, unknown>>, name: string) {
  const created = calls.find((c) => c.op === 'create' && c.name === name);
  if (!created) return undefined;
  const updates = calls.filter(
    (c) => c.op === 'update' && c.check_run_id === created.id,
  );
  return (updates.at(-1) ?? created) as Record<string, unknown>;
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

  it('accepts the real job.succeeded and keeps the stack check pending', async () => {
    const { app, octokit } = await buildApp();
    const at = Date.now();

    await postPstack(app, {
      id: 'evt_started_before_success',
      event: 'job.started',
      at,
      data: {
        jobId: 'up-pr-16828-2-zhhhxy',
        stack: 'pr-16828',
        action: 'up',
        startedAt: 1786404404604,
      },
    });
    await drain();

    const res = await postPstack(app, {
      id: 'evt_msnvxsr7_o_pyxv5n',
      event: 'job.succeeded',
      at,
      data: {
        jobId: 'up-pr-16828-2-zhhhxy',
        stack: 'pr-16828',
        action: 'up',
        state: 'ok',
        startedAt: 1786404404604,
        endedAt: 1786405882579,
        durationMs: 1477975,
        leakedAxes: [],
        verified: null,
        unverifiable: 0,
      },
    });
    expect(res.status).toBe(200);
    await drain();

    const update = octokit.checkRuns.find(
      (call) =>
        call.op === 'update' &&
        (call.output as { title?: string } | undefined)?.title ===
          'Deployment completed; checking readiness',
    );
    expect(update).toMatchObject({
      status: 'in_progress',
      conclusion: undefined,
    });
    expect(
      (update?.output as { summary?: string } | undefined)?.summary,
    ).toContain('deploy job succeeded in 1478s; checking container readiness');
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

  /**
   * `x-pstack-redelivery: 1` is what pstack sets when an operator replays a
   * delivery from the Notifiers page — the usual way a missed event gets
   * re-sent. It must be accepted and acted on, not treated as a duplicate.
   */
  it('accepts a delivery an operator replayed', async () => {
    const logs: LogLine[] = [];
    const { app, octokit } = await buildApp({ logger: recordingLogger(logs) });
    const at = Date.now();
    const body = JSON.stringify({
      id: 'evt_replay',
      event: 'stack.ready',
      at,
      data: { stack: 'pr-16828', state: 'ready', containers: 1, ready: 1 },
    });

    const res = await app.fetch(
      new Request('http://local/webhooks/preview-stacks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pstack-event': 'stack.ready',
          'x-pstack-delivery': 'evt_replay',
          'x-pstack-timestamp': String(at),
          'x-pstack-redelivery': '1',
          'x-pstack-signature': `sha256=${createHmac('sha256', 'pstack-secret')
            .update(`${at}.${body}`)
            .digest('hex')}`,
        },
        body,
      }),
    );

    expect(res.status).toBe(200);
    await drain();
    expect(latestCheck(octokit.checkRuns, 'pstack/stack')?.conclusion).toBe(
      'success',
    );
    // The replay is logged as such: at-least-once delivery makes it normal
    // traffic, and an operator who pressed Replay needs to see it landed.
    expect(
      logs.some((l) => l.message.includes('replayed webhook delivery')),
    ).toBe(true);
  });

  /**
   * A rejection is logged with its cause. A stale timestamp is a clock skew and
   * a bad signature is a wrong secret or an attack; an operator staring at a 401
   * has nothing else to tell them apart.
   */
  it('reports why a delivery was rejected', async () => {
    const logs: LogLine[] = [];
    const { app } = await buildApp({ logger: recordingLogger(logs) });

    await postPstack(
      app,
      {
        id: 'evt_forged',
        event: 'stack.ready',
        at: Date.now(),
        data: { stack: 'pr-16828', containers: 1, ready: 1 },
      },
      'wrong-secret',
    );
    await postPstack(app, {
      id: 'evt_stale',
      event: 'stack.ready',
      at: Date.now() - 60 * 60_000,
      data: { stack: 'pr-16828', containers: 1, ready: 1 },
    });

    const reasons = logs
      .filter((l) => l.message.includes('rejected a webhook delivery'))
      .map((l) => l.fields.reason);
    expect(reasons).toEqual(['signature mismatch', 'stale timestamp']);
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
  it('clears pstack checks for one stack and forgets its reporter state', async () => {
    const octokit = mockOctokit();
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          { id: 10, name: 'pstack/stack' },
          { id: 11, name: 'pstack/web' },
          { id: 12, name: 'other/check' },
        ],
      },
    });
    const { app, pstack } = await buildApp({ octokit });
    await postPstack(app, {
      id: 'evt_cleanup_one',
      event: 'job.started',
      at: Date.now(),
      data: { stack: 'pr-16828', action: 'up' },
    });
    await drain();

    const res = await app.fetch(
      new Request('http://local/webhooks/pstack/checks/clear', {
        method: 'POST',
        headers: {
          authorization: 'Bearer checks-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ stack: 'pr-16828' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pullRequests: [16828],
      checkRuns: 2,
      stack: 'pr-16828',
      forgotten: ['pr-16828'],
    });
    expect(pstack.active).toEqual([]);
    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    const cleared = octokit.checkRuns.filter(
      (run) => run.op === 'update' && run.conclusion === 'skipped',
    );
    expect(cleared.map((run) => run.check_run_id)).toEqual([10, 11]);
  });

  it('clears pstack checks for every open PR', async () => {
    const octokit = mockOctokit();
    vi.mocked(octokit.rest.pulls.list).mockResolvedValue({
      data: [
        { number: 1, head: { sha: 'sha-1' } },
        { number: 2, head: { sha: 'sha-2' } },
      ],
    });
    vi.mocked(octokit.rest.checks.listForRef).mockImplementation(
      async ({ ref }) => ({
        data: {
          check_runs: [{ id: ref === 'sha-1' ? 21 : 22, name: 'pstack/stack' }],
        },
      }),
    );
    const { app } = await buildApp({ octokit });

    const res = await app.fetch(
      new Request('http://local/webhooks/pstack/checks/clear', {
        method: 'POST',
        headers: {
          authorization: 'Bearer checks-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ all: true }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      pullRequests: [1, 2],
      checkRuns: 2,
      forgotten: [],
    });
    expect(
      octokit.checkRuns
        .filter((run) => run.conclusion === 'skipped')
        .map((run) => run.check_run_id),
    ).toEqual([21, 22]);
  });

  it('clears pstack checks across every GitHub results page', async () => {
    const octokit = mockOctokit();
    vi.mocked(octokit.rest.checks.listForRef).mockImplementation(
      async ({ page }) => ({
        data: {
          check_runs:
            page === 1
              ? [
                  { id: 31, name: 'pstack/stack' },
                  ...Array.from({ length: 99 }, (_, index) => ({
                    id: 1000 + index,
                    name: `other/${index}`,
                  })),
                ]
              : [{ id: 32, name: 'pstack/web' }],
        },
      }),
    );
    const { app } = await buildApp({ octokit });

    const res = await app.fetch(
      new Request('http://local/webhooks/pstack/checks/clear', {
        method: 'POST',
        headers: {
          authorization: 'Bearer checks-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ stack: 'pr-16828' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ checkRuns: 2 });
    expect(octokit.rest.checks.listForRef).toHaveBeenCalledTimes(2);
    expect(
      octokit.checkRuns
        .filter((run) => run.conclusion === 'skipped')
        .map((run) => run.check_run_id),
    ).toEqual([31, 32]);
  });

  it('does not let an in-flight stack event rewrite checks after cleanup', async () => {
    const octokit = mockOctokit();
    const { app, pstack } = await buildApp({ octokit });
    await postPstack(app, {
      id: 'evt_cleanup_race_open',
      event: 'job.started',
      at: Date.now(),
      data: { stack: 'pr-16828', action: 'up' },
    });
    await drain();

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const cleanupEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(octokit.rest.checks.listForRef).mockImplementationOnce(
      async () => {
        entered();
        await gate;
        return {
          data: {
            check_runs: [
              { id: 100, name: 'pstack/stack' },
              { id: 101, name: 'pstack/db-seed' },
              { id: 102, name: 'pstack/web' },
            ],
          },
        };
      },
    );

    const cleanup = app.fetch(
      new Request('http://local/webhooks/pstack/checks/clear', {
        method: 'POST',
        headers: {
          authorization: 'Bearer checks-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ stack: 'pr-16828' }),
      }),
    );
    await cleanupEntered;

    const event = await postPstack(app, {
      id: 'evt_cleanup_race_ready',
      event: 'stack.ready',
      at: Date.now(),
      data: { stack: 'pr-16828', containers: 2, ready: 2 },
    });
    expect(event.status).toBe(200);
    release();
    expect((await cleanup).status).toBe(200);
    await drain();

    expect(pstack.active).toEqual([]);
    expect(
      octokit.checkRuns.filter((run) => run.conclusion === 'success'),
    ).toEqual([]);
    expect(
      octokit.checkRuns.filter((run) => run.conclusion === 'skipped'),
    ).toHaveLength(3);
  });

  it('waits for initial check creation before clearing a new stack', async () => {
    const octokit = mockOctokit();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const openingEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let nextId = 100;
    vi.mocked(octokit.rest.checks.create).mockImplementation(async (params) => {
      const id = nextId++;
      octokit.checkRuns.push({ op: 'create', id, ...params });
      if (params.name === 'pstack/web') {
        entered();
        await gate;
      }
      return { data: { id } };
    });
    const { app, pstack } = await buildApp({ octokit });

    const firstEvent = postPstack(app, {
      id: 'evt_cleanup_opening',
      event: 'job.started',
      at: Date.now(),
      data: { stack: 'pr-16828', action: 'up' },
    });
    await openingEntered;
    const cleanup = app.fetch(
      new Request('http://local/webhooks/pstack/checks/clear', {
        method: 'POST',
        headers: {
          authorization: 'Bearer checks-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ stack: 'pr-16828' }),
      }),
    );
    await drain();
    vi.mocked(octokit.rest.checks.listForRef).mockResolvedValue({
      data: {
        check_runs: [
          { id: 100, name: 'pstack/stack' },
          { id: 101, name: 'pstack/db-seed' },
          { id: 102, name: 'pstack/web' },
        ],
      },
    });
    release();

    expect((await firstEvent).status).toBe(200);
    expect((await cleanup).status).toBe(200);
    await drain();
    expect(pstack.active).toEqual([]);
    expect(
      octokit.checkRuns.filter((run) => run.conclusion === 'skipped'),
    ).toHaveLength(3);
    expect(octokit.checkRuns.at(-1)).toMatchObject({ conclusion: 'skipped' });
  });

  it('protects and validates the pstack checks cleanup webhook', async () => {
    const { app } = await buildApp();
    const request = (authorization?: string, body = '{}') =>
      app.fetch(
        new Request('http://local/webhooks/pstack/checks/clear', {
          method: 'POST',
          headers: {
            ...(authorization ? { authorization } : {}),
            'content-type': 'application/json',
          },
          body,
        }),
      );

    expect((await request()).status).toBe(401);
    expect((await request('Bearer checks-secret')).status).toBe(400);
    expect(
      (
        await request(
          'Bearer checks-secret',
          JSON.stringify({ stack: 'staging' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          'Bearer checks-secret',
          JSON.stringify({ stack: 'web-pr-1' }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          'Bearer checks-secret',
          JSON.stringify({ all: true, stack: 'pr-1' }),
        )
      ).status,
    ).toBe(400);

    const queryToken = await app.fetch(
      new Request(
        'http://local/webhooks/pstack/checks/clear?token=checks-secret',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ all: true }),
        },
      ),
    );
    expect(queryToken.status).toBe(401);
  });

  it('serves /health and /previews', async () => {
    const { app } = await buildApp();
    expect((await app.fetch(new Request('http://local/health'))).status).toBe(
      200,
    );
    const previews = await app.fetch(new Request('http://local/previews'));
    expect(previews.status).toBe(200);
    expect(await previews.json()).toMatchObject({ count: 0, stacks: [] });
  });

  it('enables the dashboard flow-runs API with the configured store', async () => {
    const { app, flowRuns, dispose } = await buildApp();
    flowRuns.start({
      id: 'preview-flow::pr-1@1',
      key: 'preview-flow::pr-1',
      rule: 'preview-flow',
      entity: 'pr-1',
      blocks: 2,
      at: 10,
    });

    const response = await app.fetch(
      new Request('http://local/dashboard/api/flow-runs'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      enabled: true,
      count: 1,
      limit: 200,
      runs: [{ entity: 'pr-1', status: 'active' }],
    });
    await dispose();
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
        'POST /webhooks/pstack/checks/clear',
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

/**
 * The `@cloudybot` commands, driven end to end: a signed GitHub webhook in at
 * the HTTP edge, and the pstack calls plus check runs it produces out the other
 * side. Everything between (rule matching, the command runner, the reporter) is
 * the real code.
 */
describe('event-automation app (@cloudybot commands)', () => {
  /** A pstack API that records what the app asks it for. */
  function pstackApi(options: { containers?: string[] } = {}) {
    const calls: Array<{ method: string; path: string }> = [];
    const containers = options.containers ?? ['pr-16828-web-1'];
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        // Only the pstack API is faked; anything else is a bug in the test.
        if (url.origin !== 'https://pstack-api.test') {
          throw new Error(`unexpected fetch to ${url.origin}`);
        }
        calls.push({ method: init?.method ?? 'GET', path: url.pathname });

        if (url.pathname === '/api/deployments') {
          return json({
            deployments: [
              {
                id: 'pr-16828',
                stack: 'pr-16828',
                kind: 'isolated',
                busy: false,
                running: true,
              },
            ],
          });
        }
        if (url.pathname.endsWith('/up')) {
          return json({
            job: {
              id: 'job-1',
              stack: 'pr-16828',
              action: 'up',
              state: 'running',
              startedAt: 0,
            },
          });
        }
        if (url.pathname.startsWith('/api/jobs/')) {
          return json({
            job: {
              id: 'job-1',
              stack: 'pr-16828',
              action: 'up',
              state: 'ok',
              startedAt: 0,
              endedAt: 1_000,
            },
          });
        }
        if (url.pathname.endsWith('/restart')) {
          return json({ container: 'x', action: 'restart', note: 'ok' });
        }
        if (url.pathname.endsWith('/runtime')) {
          return json({
            stack: 'pr-16828',
            reachable: true,
            challenge: 'dns01',
            findings: [],
            containers: containers.map((name, i) => ({
              id: `c${i}`,
              name,
              service: 'web',
              image: 'img',
              state: 'running',
              health: 'healthy',
              exitCode: null,
              restartCount: 0,
              networks: [],
              ingressIp: null,
              ports: [],
              traefikLabels: {},
            })),
            routes: [
              {
                router: 'r-web',
                container: containers[0] ?? 'pr-16828-web-1',
                rule: 'Host(`shop-pr-16828.hou.test`)',
                hosts: ['shop-pr-16828.hou.test'],
                service: 'web',
                port: 3000,
                entrypoints: 'websecure',
                tls: true,
                certresolver: null,
                priority: null,
                target: null,
              },
            ],
          });
        }
        if (url.pathname.endsWith('/readiness')) {
          return json({
            id: 'pr-16828',
            stack: 'pr-16828',
            state: 'ready',
            startedAt: 0,
            endedAt: 2_000,
            reachable: true,
            timeoutMs: 180_000,
            containers: containers.map((name) => ({
              name,
              service: 'web',
              state: 'running',
              health: 'healthy',
              hasHealthcheck: true,
              exitCode: null,
              restartCount: 0,
              ready: true,
              failed: false,
            })),
          });
        }
        throw new Error(`unexpected pstack call ${url.pathname}`);
      },
    );

    return { fetchMock, calls };
  }

  const CommandEnv: Partial<AppEnv> = {
    pstackApiUrl: 'https://pstack-api.test',
    pstackApiToken: 'pstack_pat_test',
  };

  function commentBody(
    body: string,
    options: {
      userType?: string;
      isPr?: boolean;
      action?: string;
      repo?: string;
    } = {},
  ): string {
    const repo = options.repo ?? 'repo-a';
    return JSON.stringify({
      action: options.action ?? 'created',
      issue: {
        number: 16828,
        pull_request: options.isPr === false ? undefined : { url: 'x' },
      },
      comment: {
        id: 1,
        body,
        user: { login: 'alice', type: options.userType ?? 'User' },
      },
      repository: {
        name: repo,
        full_name: `housing-cloud/${repo}`,
        owner: { login: 'housing-cloud' },
      },
    });
  }

  function labeledBody(label: string): string {
    return JSON.stringify({
      action: 'labeled',
      number: 16828,
      label: { name: label },
      sender: { login: 'alice' },
      pull_request: {
        number: 16828,
        head: {
          sha: 'abc1234567890',
          ref: 'feature',
          repo: {
            full_name: 'housing-cloud/repo-a',
            name: 'repo-a',
            owner: { login: 'housing-cloud' },
          },
        },
        base: { ref: 'main' },
        labels: [{ name: label }],
      },
      repository: {
        name: 'repo-a',
        full_name: 'housing-cloud/repo-a',
        owner: { login: 'housing-cloud' },
      },
    });
  }

  /** Await the app's detached command work, not just the microtask queue. */
  async function settle(commands: { drain(): Promise<void> } | undefined) {
    await drain();
    await commands?.drain();
    await drain();
  }

  it('redeploys the stack from a PR comment and settles the checks', async () => {
    const { fetchMock, calls } = pstackApi();
    const { app, octokit, commands } = await buildApp({
      envOverrides: CommandEnv,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await postGithub(
      app,
      commentBody('@cloudybot redeploy'),
      'd-cmd-1',
      'issue_comment',
    );
    expect(res.status).toBe(200);
    await settle(commands);

    expect(
      calls.some((c) => c.method === 'POST' && c.path.endsWith('/up')),
    ).toBe(true);
    expect(latestCheck(octokit.checkRuns, 'pstack/stack')?.conclusion).toBe(
      'success',
    );
  });

  it('runs the command applied as a label and removes it', async () => {
    const { fetchMock, calls } = pstackApi();
    const { app, octokit, commands } = await buildApp({
      envOverrides: CommandEnv,
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await postGithub(app, labeledBody('cloudy-restart'), 'd-cmd-2');
    expect(res.status).toBe(200);
    await settle(commands);

    expect(calls.some((c) => c.path.endsWith('/restart'))).toBe(true);
    expect(octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'cloudy-restart', issue_number: 16828 }),
    );
  });

  /**
   * The bot's own help comment documents `@cloudybot redeploy` in a table. A
   * service that acted on its own comments would redeploy every stack it ever
   * documented, so this is the loop that must not close.
   */
  it('ignores a command in a bot’s own comment', async () => {
    const { fetchMock, calls } = pstackApi();
    const { app, commands } = await buildApp({
      envOverrides: CommandEnv,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await postGithub(
      app,
      commentBody('@cloudybot redeploy', { userType: 'Bot' }),
      'd-cmd-3',
      'issue_comment',
    );
    await settle(commands);

    expect(calls).toHaveLength(0);
  });

  it('ignores a command on an issue, which has no preview stack', async () => {
    const { fetchMock, calls } = pstackApi();
    const { app, commands } = await buildApp({
      envOverrides: CommandEnv,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await postGithub(
      app,
      commentBody('@cloudybot redeploy', { isPr: false }),
      'd-cmd-4',
      'issue_comment',
    );
    await settle(commands);

    expect(calls).toHaveLength(0);
  });

  it('ignores ordinary conversation', async () => {
    const { fetchMock, calls } = pstackApi();
    const { app, commands } = await buildApp({
      envOverrides: CommandEnv,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await postGithub(
      app,
      commentBody('should we redeploy this?'),
      'd-cmd-5',
      'issue_comment',
    );
    await settle(commands);

    expect(calls).toHaveLength(0);
  });

  /**
   * A command is a write against real infrastructure, so it must respect the
   * same repo allow-list as everything else: a PR in a repo this service was
   * not scoped to cannot drive a deploy through it.
   */
  it('ignores a command from a repo outside GITHUB_ALLOWED_REPOS', async () => {
    const { fetchMock, calls } = pstackApi();
    const { app, commands } = await buildApp({
      envOverrides: CommandEnv,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await postGithub(
      app,
      commentBody('@cloudybot redeploy', { repo: 'not-allowed' }),
      'd-cmd-7',
      'issue_comment',
    );
    await settle(commands);

    expect(calls).toHaveLength(0);
  });

  /**
   * Without the API configured the service cannot carry a command out, so the
   * rule is not registered at all — acknowledging one it cannot run would be
   * worse than ignoring it.
   */
  it('does not register the command rules without the API configured', async () => {
    const { app, commands } = await buildApp();
    expect(commands).toBeUndefined();

    const res = await postGithub(
      app,
      commentBody('@cloudybot redeploy'),
      'd-cmd-6',
      'issue_comment',
    );
    expect(res.status).toBe(200);
  });

  it('puts the live Traefik URL on the comment', async () => {
    const { fetchMock } = pstackApi();
    const { app, octokit } = await buildApp({
      envOverrides: CommandEnv,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await postPstack(app, {
      id: 'evt_ready',
      event: 'stack.ready',
      at: Date.now(),
      data: { stack: 'pr-16828', state: 'ready', containers: 1, ready: 1 },
    });
    await drain();

    const body = String(octokit.comments.at(-1)?.body);
    expect(body).toContain('https://shop-pr-16828.hou.test');
    // The configured pattern would have produced this instead.
    expect(body).not.toContain('web-pr-16828.preview.hou.test');
  });

  it('posts the help comment when the checks first open', async () => {
    const { app, octokit } = await buildApp();

    await postPstack(app, {
      id: 'evt_start',
      event: 'job.started',
      at: Date.now(),
      data: { stack: 'pr-16828', action: 'up' },
    });
    await drain();

    const help = octokit.comments.filter((c) =>
      String(c.body).includes('Preview stack bot'),
    );
    expect(help).toHaveLength(1);
    expect(help[0]?.issue_number).toBe(16828);
  });
});

/**
 * The preview-labels explainer on a newly opened PR, driven end to end through
 * a signed GitHub webhook.
 */
describe('event-automation app (PR opened explainer)', () => {
  const EnabledEnv: Partial<AppEnv> = { prOpenedComment: true };

  it('comments on a newly opened PR', async () => {
    const { app, octokit } = await buildApp({ envOverrides: EnabledEnv });

    const res = await postGithub(app, githubPrBody('opened'), 'd-open-1');
    expect(res.status).toBe(200);
    await drain();

    expect(octokit.comments).toHaveLength(1);
    expect(octokit.comments[0]).toMatchObject({
      op: 'create',
      issue_number: 16828,
      repo: 'repo-a',
    });
  });

  it('explains all three labels', async () => {
    const { app, octokit } = await buildApp({ envOverrides: EnabledEnv });
    await postGithub(app, githubPrBody('opened'), 'd-open-2');
    await drain();

    const body = String(octokit.comments[0]?.body);
    for (const label of ['preview', 'no-preview', 'preserve-preview']) {
      expect(body).toContain(`\`${label}\``);
    }
  });

  /** Off by default: it writes to every opened PR, so it must be asked for. */
  it('stays silent when the flag is not set', async () => {
    const { app, octokit } = await buildApp();

    const res = await postGithub(app, githubPrBody('opened'), 'd-open-3');
    expect(res.status).toBe(200);
    await drain();

    expect(octokit.comments).toHaveLength(0);
  });

  it('does not comment on other pull_request actions', async () => {
    const { app, octokit } = await buildApp({ envOverrides: EnabledEnv });

    await postGithub(app, githubPrBody('synchronize'), 'd-open-4');
    await postGithub(app, githubPrBody('closed'), 'd-open-5');
    await drain();

    expect(octokit.comments).toHaveLength(0);
  });

  /**
   * GitHub delivery is at-least-once, and a redelivered `opened` would
   * otherwise add a second copy. The marker lookup is what prevents it, which
   * also covers a restart between the two deliveries.
   */
  it('does not post twice when the PR already carries the comment', async () => {
    const octokit = mockOctokit();
    const { app } = await buildApp({ envOverrides: EnabledEnv, octokit });

    await postGithub(app, githubPrBody('opened'), 'd-open-6');
    await drain();
    expect(octokit.comments).toHaveLength(1);

    // The PR now carries it, exactly as GitHub would report on a redelivery.
    const posted = String(octokit.comments[0]?.body);
    octokit.rest.issues.listComments = vi.fn(async () => ({
      data: [{ id: 1, body: posted }],
    }));

    await postGithub(app, githubPrBody('opened'), 'd-open-7');
    await drain();

    expect(octokit.comments).toHaveLength(1);
  });

  it('comments on the PR’s own repo', async () => {
    const { app, octokit } = await buildApp({
      envOverrides: {
        ...EnabledEnv,
        githubAllowedRepos: new Set(['repo-a', 'repo-b']),
      },
    });

    await postGithub(
      app,
      githubPrBody('opened', { repo: 'repo-b', number: 7 }),
      'd-open-8',
    );
    await drain();

    expect(octokit.comments[0]).toMatchObject({
      repo: 'repo-b',
      issue_number: 7,
    });
  });

  it('ignores a repo outside GITHUB_ALLOWED_REPOS', async () => {
    const { app, octokit } = await buildApp({ envOverrides: EnabledEnv });

    await postGithub(
      app,
      githubPrBody('opened', { repo: 'not-allowed' }),
      'd-open-9',
    );
    await drain();

    expect(octokit.comments).toHaveLength(0);
  });

  /**
   * The explainer and the pstack help comment are different artefacts with
   * different triggers: this one when the PR opens, the other when a stack's
   * checks first open. A PR that gets both must carry both.
   */
  it('is separate from the pstack help comment', async () => {
    const { app, octokit } = await buildApp({ envOverrides: EnabledEnv });

    await postGithub(app, githubPrBody('opened'), 'd-open-10');
    await drain();
    await postPstack(app, {
      id: 'evt_open_stack',
      event: 'job.started',
      at: Date.now(),
      data: { stack: 'pr-16828', action: 'up' },
    });
    await drain();

    const bodies = octokit.comments.map((c) => String(c.body));
    expect(
      bodies.filter((b) => b.includes('Preview stacks on this PR')),
    ).toHaveLength(1);
    expect(bodies.filter((b) => b.includes('Preview stack bot'))).toHaveLength(
      1,
    );
  });
});
