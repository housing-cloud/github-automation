/**
 * `@cloudybot` command tests.
 *
 * Driven through the real `PstackCommands` against a fake pstack API and a
 * recording Octokit, so what is asserted is the HTTP the service actually
 * sends and the check runs it actually writes — not an internal call count.
 */

import { noopLogger } from '@samyx/github-automation-suite';
import { describe, expect, it, vi } from 'vitest';
import type { AppOctokit } from '../github/checks';
import { createPstackClient } from './client';
import {
  commandLabels,
  parseCommentCommand,
  parseLabelCommand,
  PstackCommands,
} from './commands';
import { BOT_COMMANDS, helpComment } from './help';
import { PstackReporter } from './reporter';

const REPO = { owner: 'housing-cloud', name: 'web' };

describe('parseCommentCommand', () => {
  it('reads each documented command', () => {
    expect(parseCommentCommand('@cloudybot recheck')).toBe('recheck');
    expect(parseCommentCommand('@cloudybot redeploy')).toBe('redeploy');
    expect(parseCommentCommand('@cloudybot restart')).toBe('restart');
  });

  it('accepts the command mid-comment and with trailing words', () => {
    expect(
      parseCommentCommand('looks broken\n@cloudybot redeploy please 🙏'),
    ).toBe('redeploy');
  });

  it('is case-insensitive, as GitHub mentions are', () => {
    expect(parseCommentCommand('@CloudyBot ReDeploy')).toBe('redeploy');
  });

  /**
   * The guard that stops a conversation from redeploying itself: GitHub's
   * "quote reply" prefixes the quoted line with `>`, and the bot's own help
   * comment lists every command in a table.
   */
  it('ignores a quoted or tabulated mention', () => {
    expect(parseCommentCommand('> @cloudybot redeploy')).toBeUndefined();
    expect(
      parseCommentCommand('| `@cloudybot redeploy` | `cloudy-redeploy` | … |'),
    ).toBeUndefined();
  });

  it('ignores a bare mention and an unknown verb', () => {
    expect(parseCommentCommand('@cloudybot')).toBeUndefined();
    expect(parseCommentCommand('@cloudybot deploy')).toBeUndefined();
    expect(parseCommentCommand('@cloudybot recheckall')).toBeUndefined();
  });
});

describe('parseLabelCommand', () => {
  it('maps every documented label to its command', () => {
    expect(parseLabelCommand('cloudy-recheck')).toBe('recheck');
    expect(parseLabelCommand('cloudy-redeploy')).toBe('redeploy');
    expect(parseLabelCommand('cloudy-restart')).toBe('restart');
  });

  it('ignores an unrelated label', () => {
    expect(parseLabelCommand('bug')).toBeUndefined();
    expect(parseLabelCommand('cloudy')).toBeUndefined();
  });

  it('documents exactly the labels it accepts', () => {
    expect(commandLabels().sort()).toEqual(
      BOT_COMMANDS.map((c) => c.label).sort(),
    );
  });
});

/** A pstack API that answers from a scripted route table and records calls. */
function fakePstack(
  options: {
    readiness?: Array<Record<string, unknown>>;
    jobState?: string;
    containers?: string[];
    deployments?: Array<Record<string, unknown>>;
    fail?: { path: string; status: number; body?: Record<string, unknown> };
  } = {},
) {
  const calls: Array<{ method: string; url: string }> = [];
  const readinessQueue = [...(options.readiness ?? [])];
  // The last scripted state repeats rather than reverting to ready, so a
  // "still converging" script stays converging for as long as it is polled.
  let lastReadiness: Record<string, unknown> | undefined;
  const containers = options.containers ?? ['pr-16828-web-1'];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      const path = new URL(url).pathname;

      if (options.fail && path.includes(options.fail.path)) {
        return json(
          options.fail.body ?? { error: 'refused' },
          options.fail.status,
        );
      }

      if (path === '/api/deployments') {
        return json({
          deployments: options.deployments ?? [
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
      if (path.endsWith('/up')) {
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
      if (path.startsWith('/api/jobs/')) {
        return json({
          job: {
            id: 'job-1',
            stack: 'pr-16828',
            action: 'up',
            state: options.jobState ?? 'ok',
            startedAt: 0,
            endedAt: 1_000,
            error:
              options.jobState && options.jobState !== 'ok'
                ? 'deploy blew up'
                : undefined,
          },
        });
      }
      if (path.endsWith('/runtime')) {
        return json({
          stack: 'pr-16828',
          reachable: true,
          challenge: 'dns01',
          findings: [],
          containers: containers.map((name, index) => ({
            id: `c${index}`,
            name,
            service: name.replace(/^pr-16828-/, '').replace(/-\d+$/, ''),
            image: 'img',
            state: 'running',
            health: null,
            exitCode: null,
            restartCount: 0,
            networks: [],
            ingressIp: null,
            ports: [],
            traefikLabels: {},
          })),
          routes: containers.map((name) => {
            const service = name.replace(/^pr-16828-/, '').replace(/-\d+$/, '');
            return {
              router: `r-${service}`,
              container: name,
              rule: `Host(\`${service}-pr-16828.preview.housing.cloud\`)`,
              hosts: [`${service}-pr-16828.preview.housing.cloud`],
              service,
              port: 3000,
              entrypoints: 'websecure',
              tls: true,
              certresolver: null,
              priority: null,
              target: null,
            };
          }),
        });
      }
      if (path.endsWith('/restart')) {
        return json({ container: 'x', action: 'restart', note: 'ok' });
      }
      if (path.endsWith('/readiness')) {
        const next = readinessQueue.shift() ??
          lastReadiness ?? {
            state: 'ready',
            containers: containers.map((name) => ({
              name,
              service: name.replace(/^pr-16828-/, '').replace(/-\d+$/, ''),
              state: 'running',
              health: 'healthy',
              hasHealthcheck: true,
              exitCode: null,
              restartCount: 0,
              ready: true,
              failed: false,
            })),
          };
        lastReadiness = next;
        return json({
          id: 'pr-16828',
          stack: 'pr-16828',
          startedAt: 0,
          endedAt: 2_000,
          reachable: true,
          timeoutMs: 180_000,
          ...next,
        });
      }
      return json({ error: `unexpected ${method} ${path}` }, 500);
    },
  );

  return { fetchMock, calls };
}

function mockOctokit() {
  const checks: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
  const removedLabels: Array<Record<string, unknown>> = [];
  let nextId = 700;
  const octokit: AppOctokit = {
    rest: {
      checks: {
        create: vi.fn(async (params) => {
          const id = nextId++;
          checks.push({ op: 'create', id, ...params });
          return { data: { id } };
        }),
        update: vi.fn(async (params) => {
          checks.push({ op: 'update', ...params });
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
        removeLabel: vi.fn(async (params) => {
          removedLabels.push(params);
          return {};
        }),
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
  return { octokit, checks, comments, removedLabels };
}

function harness(
  pstackOptions: Parameters<typeof fakePstack>[0] = {},
  { readyTimeoutMs = 5_000 }: { readyTimeoutMs?: number } = {},
) {
  const { fetchMock, calls } = fakePstack(pstackOptions);
  const { octokit, checks, comments, removedLabels } = mockOctokit();
  const client = createPstackClient({
    baseUrl: 'https://api.preview.housing.cloud',
    token: 'pstack_pat_test',
    fetch: fetchMock as unknown as typeof fetch,
  });
  const reporter = new PstackReporter({
    octokit,
    repo: REPO,
    logger: noopLogger,
    services: ['web'],
    commandsEnabled: true,
  });
  const commands = new PstackCommands({
    client,
    reporter,
    octokit,
    repo: REPO,
    logger: noopLogger,
    readyTimeoutMs,
  });
  return { commands, reporter, checks, comments, removedLabels, calls };
}

/** The latest state written for a named check run. */
function latest(checks: Array<Record<string, unknown>>, name: string) {
  const created = checks.find((c) => c.op === 'create' && c.name === name);
  if (!created) return undefined;
  const updates = checks.filter(
    (c) => c.op === 'update' && c.check_run_id === created.id,
  );
  return (updates.at(-1) ?? created) as Record<string, unknown>;
}

const titlesOf = (checks: Array<Record<string, unknown>>) =>
  checks.map((c) => (c.output as { title?: string } | undefined)?.title ?? '');

describe('PstackCommands — recheck', () => {
  /**
   * The point of `recheck`: a check left pending by a delivery that never
   * arrived is repaired by reading the state pstack already has, with no
   * deploy and no restart.
   */
  it('settles the checks from the stack’s current readiness, deploying nothing', async () => {
    const { commands, checks, calls } = harness();
    commands.accept({ command: 'recheck', prNumber: 16828 });
    await commands.drain();

    expect(latest(checks, 'pstack/stack')?.conclusion).toBe('success');
    expect(latest(checks, 'pstack/web')?.conclusion).toBe('success');
    expect(calls.some((c) => c.url.includes('/up'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/restart'))).toBe(false);
  });

  /**
   * A settled watch answers instantly with its old verdict, so a recheck that
   * did not force a re-run would keep reporting the state it was asked to
   * re-examine.
   */
  it('forces a settled readiness watch to re-run', async () => {
    const { commands, calls } = harness();
    commands.accept({ command: 'recheck', prNumber: 16828 });
    await commands.drain();

    expect(calls.find((c) => c.url.includes('/readiness'))?.url).toContain(
      'refresh=1',
    );
  });

  it('reopens the checks before the wait, so the command is visible', async () => {
    const { commands, checks } = harness(
      { readiness: [{ state: 'watching', containers: [] }] },
      { readyTimeoutMs: 20 },
    );
    commands.accept({ command: 'recheck', prNumber: 16828 });
    await commands.drain();

    expect(titlesOf(checks)).toContain('Rechecking the preview stack');
  });

  it('names who asked in the check summary', async () => {
    const { commands, checks } = harness();
    commands.accept({ command: 'recheck', prNumber: 16828, actor: 'alice' });
    await commands.drain();

    const summaries = checks.map(
      (c) => (c.output as { summary?: string } | undefined)?.summary ?? '',
    );
    expect(summaries.some((s) => s.includes('by @alice'))).toBe(true);
  });
});

describe('PstackCommands — redeploy', () => {
  it('runs `up`, waits for the job, then settles from readiness', async () => {
    const { commands, checks, calls } = harness();
    commands.accept({ command: 'redeploy', prNumber: 16828 });
    await commands.drain();

    const up = calls.find((c) => c.url.includes('/up'));
    expect(up?.method).toBe('POST');
    // `down` needs the same variables as `up`, and so does every read.
    expect(up?.url).toContain('PR=16828');
    expect(calls.some((c) => c.url.includes('/api/jobs/job-1'))).toBe(true);
    expect(latest(checks, 'pstack/stack')?.conclusion).toBe('success');
  });

  /**
   * `failed`, `leaked` and `cancelled` are answers the client returns rather
   * than throws, and each has to reach the checks — a deploy that blew up must
   * not leave them spinning.
   */
  it('fails the checks when the deploy job does', async () => {
    const { commands, checks } = harness({ jobState: 'failed' });
    commands.accept({ command: 'redeploy', prNumber: 16828 });
    await commands.drain();

    expect(latest(checks, 'pstack/stack')?.conclusion).toBe('failure');
    expect(
      (latest(checks, 'pstack/stack')?.output as { summary?: string })?.summary,
    ).toContain('deploy blew up');
    expect(latest(checks, 'pstack/web')?.conclusion).toBe('failure');
  });

  /**
   * pstack rejects a second action on a busy stack with a 409 rather than
   * queueing it — a `down` deleting the branch an `up` just created is the
   * corruption the interlock exists to prevent. The reviewer needs to be told
   * that, not left with a pending check.
   */
  it('reports pstack’s 409 busy refusal on the check', async () => {
    const { commands, checks } = harness({
      fail: {
        path: '/up',
        status: 409,
        body: { error: 'stack pr-16828 already has a job in flight' },
      },
    });
    commands.accept({ command: 'redeploy', prNumber: 16828 });
    await commands.drain();

    const stack = latest(checks, 'pstack/stack');
    expect(stack?.conclusion).toBe('failure');
    expect((stack?.output as { summary?: string })?.summary).toContain(
      'already has a job in flight',
    );
  });

  it('says there is nothing to redeploy when pstack has no such deployment', async () => {
    const { commands, checks } = harness({
      fail: { path: '/up', status: 404 },
    });
    commands.accept({ command: 'redeploy', prNumber: 16828 });
    await commands.drain();

    expect(
      (latest(checks, 'pstack/stack')?.output as { summary?: string })?.summary,
    ).toContain('nothing to redeploy');
  });
});

describe('PstackCommands — restart', () => {
  /**
   * pstack's restart verb is per container, on purpose: `docker restart` on a
   * name the deployment does not own could take down Traefik and every other
   * preview on the host.
   */
  it('restarts every container the deployment owns, then settles the checks', async () => {
    const { commands, checks, calls } = harness({
      containers: ['pr-16828-web-1', 'pr-16828-worker-1'],
    });
    commands.accept({ command: 'restart', prNumber: 16828 });
    await commands.drain();

    const restarts = calls.filter((c) => c.url.includes('/restart'));
    expect(restarts).toHaveLength(2);
    expect(restarts.every((c) => c.method === 'POST')).toBe(true);
    expect(restarts[0]?.url).toContain('/containers/pr-16828-web-1/restart');
    expect(latest(checks, 'pstack/stack')?.conclusion).toBe('success');
  });

  it('reports a stack with nothing to restart instead of hanging', async () => {
    const { commands, checks } = harness({ containers: [] });
    commands.accept({ command: 'restart', prNumber: 16828 });
    await commands.drain();

    expect(latest(checks, 'pstack/stack')?.conclusion).toBe('failure');
    expect(
      (latest(checks, 'pstack/stack')?.output as { summary?: string })?.summary,
    ).toContain('no containers to restart');
  });
});

describe('PstackCommands — mechanics', () => {
  /**
   * A label is sticky: re-applying `cloudy-redeploy` while it is still on the
   * PR produces no `labeled` event. Removing it is what turns it into a button
   * that can be pressed twice.
   */
  it('removes the triggering label so it can be applied again', async () => {
    const { commands, removedLabels } = harness();
    commands.accept({
      command: 'redeploy',
      prNumber: 16828,
      label: 'cloudy-redeploy',
    });
    await commands.drain();

    expect(removedLabels).toEqual([
      {
        owner: 'housing-cloud',
        repo: 'web',
        issue_number: 16828,
        name: 'cloudy-redeploy',
      },
    ]);
  });

  it('acts on every deployment a PR owns, not just the canonical name', async () => {
    const { commands, calls } = harness({
      deployments: [
        {
          id: 'web-pr-16828',
          stack: 'web-pr-16828',
          kind: 'isolated',
          busy: false,
          running: true,
        },
        {
          id: 'api-pr-16828',
          stack: 'api-pr-16828',
          kind: 'isolated',
          busy: false,
          running: true,
        },
        {
          id: 'staging',
          stack: 'staging',
          kind: 'shared',
          busy: false,
          running: true,
        },
      ],
    });
    commands.accept({ command: 'redeploy', prNumber: 16828 });
    await commands.drain();

    const ups = calls.filter((c) => c.url.includes('/up')).map((c) => c.url);
    expect(ups).toHaveLength(2);
    expect(ups[0]).toContain('/deployments/web-pr-16828/up');
    expect(ups[1]).toContain('/deployments/api-pr-16828/up');
  });

  it('ignores a second command while one is still running on the PR', async () => {
    const { commands, calls } = harness(
      { readiness: [{ state: 'watching', containers: [] }] },
      { readyTimeoutMs: 20 },
    );
    commands.accept({ command: 'redeploy', prNumber: 16828 });
    commands.accept({ command: 'redeploy', prNumber: 16828 });
    await commands.drain();

    expect(calls.filter((c) => c.url.includes('/up'))).toHaveLength(1);
  });

  /**
   * Still `watching` when the wait expires is not a verdict: pstack's own
   * `stack.*` delivery is still coming, and failing here would be a false
   * negative on a stack that is merely slow.
   */
  it('leaves the checks pending when the stack is still converging', async () => {
    const { commands, checks } = harness(
      { readiness: [{ state: 'watching', containers: [] }] },
      { readyTimeoutMs: 20 },
    );
    commands.accept({ command: 'recheck', prNumber: 16828 });
    await commands.drain();

    expect(latest(checks, 'pstack/stack')?.status).toBe('in_progress');
    expect(titlesOf(checks)).toContain('Preview stack still converging');
  });

  it('reports a wait that could not be made at all', async () => {
    const { commands, checks } = harness({
      fail: { path: '/readiness', status: 500 },
    });
    commands.accept({ command: 'recheck', prNumber: 16828 });
    await commands.drain();

    expect(latest(checks, 'pstack/stack')?.conclusion).toBe('failure');
  });
});

describe('helpComment', () => {
  it('documents every command in both of its forms', () => {
    const body = helpComment({ services: ['web'], commandsEnabled: true });
    for (const command of BOT_COMMANDS) {
      expect(body).toContain(command.comment);
      expect(body).toContain(command.label);
    }
  });

  it('lists a check row per watched service', () => {
    const body = helpComment({
      services: ['db-seed', 'web'],
      commandsEnabled: true,
    });
    expect(body).toContain('`pstack/db-seed`');
    expect(body).toContain('`pstack/web`');
    expect(body).toContain('`pstack/stack`');
  });

  /** Documenting a command the service cannot run is worse than documenting none. */
  it('says so when the commands are not configured', () => {
    const body = helpComment({ services: ['web'], commandsEnabled: false });
    expect(body).toContain('not configured');
    expect(body).not.toContain('| `@cloudybot redeploy` |');
  });

  it('links the pstack dashboard when one is configured', () => {
    expect(
      helpComment({
        services: ['web'],
        commandsEnabled: true,
        pstackBaseUrl: 'https://pstack.housing.cloud',
      }),
    ).toContain('https://pstack.housing.cloud');
  });
});
