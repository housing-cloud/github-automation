import { noopLogger } from '@samyx/github-automation-suite';
import { describe, expect, it, vi } from 'vitest';
import type {
  DokployClient,
  DokployPreviewDeployment,
} from '../dokploy/client';
import type { TrackerOctokit } from '../github/checks';
import { checkStateFor, PreviewTracker, type TrackerTarget } from './tracker';

const BASE_URL = 'https://dokploy.test';

function target(overrides: Partial<TrackerTarget> = {}): TrackerTarget {
  return {
    repo: { owner: 'housing-cloud', name: 'repo-a' },
    prNumber: 3,
    headSha: 'abc1234567890',
    applicationId: 'app-1',
    applicationName: 'repo-a',
    ...overrides,
  };
}

function preview(
  previewStatus: DokployPreviewDeployment['previewStatus'],
  overrides: Partial<DokployPreviewDeployment> = {},
): DokployPreviewDeployment {
  return {
    previewDeploymentId: 'prev-1',
    applicationId: 'app-1',
    appName: 'preview-abc',
    branch: 'feature',
    pullRequestId: '900',
    pullRequestNumber: '3',
    pullRequestURL: 'https://github.com/housing-cloud/repo-a/pull/3',
    pullRequestTitle: 'A change',
    previewStatus,
    createdAt: '2026-08-09T00:00:00.000Z',
    domain: { host: 'preview-abc.hou.test', https: true },
    ...overrides,
  };
}

function mockOctokit() {
  const checkRuns: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
  let nextId = 1;
  const octokit: TrackerOctokit = {
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
  return { octokit, checkRuns, comments };
}

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
    applicationUrl: vi.fn(async () => `${BASE_URL}/dashboard/app-1`),
  } as unknown as DokployClient;
}

/**
 * A tracker whose sleeps are instant and whose clock advances by the poll
 * interval per tick — so a 30-minute timeout is reached in a handful of loops.
 */
function tracker(
  octokit: TrackerOctokit,
  dokploy: DokployClient,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
) {
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  let clock = 0;
  return new PreviewTracker({
    dokploy,
    octokit,
    dokployBaseUrl: BASE_URL,
    logger: noopLogger,
    pollIntervalMs,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
}

describe('checkStateFor', () => {
  it('keeps idle and running in progress, and settles done/error', () => {
    expect(checkStateFor('idle')).toMatchObject({ status: 'in_progress' });
    expect(checkStateFor('running')).toMatchObject({ status: 'in_progress' });
    expect(checkStateFor('done')).toMatchObject({
      status: 'completed',
      conclusion: 'success',
    });
    expect(checkStateFor('error')).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
    });
  });

  it('never attaches a conclusion while still in progress', () => {
    expect(checkStateFor('running').conclusion).toBeUndefined();
    expect(checkStateFor('idle').conclusion).toBeUndefined();
  });
});

describe('PreviewTracker', () => {
  it('reports every status transition exactly once', async () => {
    const { octokit, checkRuns } = mockOctokit();
    const dokploy = stubDokploy([
      [preview('idle')],
      [preview('running')],
      [preview('running')],
      [preview('done')],
    ]);

    await tracker(octokit, dokploy).track(target());

    // create (queued) + running + done — the repeated `running` poll is not
    // re-reported, which is what keeps the check from flapping.
    expect(checkRuns).toHaveLength(3);
    expect(checkRuns.at(-1)).toMatchObject({
      status: 'completed',
      conclusion: 'success',
    });
  });

  it('fails the check when the preview errors', async () => {
    const { octokit, checkRuns } = mockOctokit();
    await tracker(octokit, stubDokploy([[preview('error')]])).track(target());
    expect(checkRuns.at(-1)).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
    });
  });

  it('times out a preview that never settles', async () => {
    const { octokit, checkRuns, comments } = mockOctokit();
    const dokploy = stubDokploy([[preview('running')]]);

    await tracker(octokit, dokploy, {
      pollIntervalMs: 30_000,
      timeoutMs: 120_000,
    }).track(target());

    expect(checkRuns.at(-1)).toMatchObject({
      status: 'completed',
      conclusion: 'timed_out',
    });
    expect(String(comments.at(-1)?.body)).toContain('Timed out');
  });

  it('times out when Dokploy never returns a matching preview', async () => {
    const { octokit, checkRuns } = mockOctokit();
    const dokploy = stubDokploy([[]]);

    await tracker(octokit, dokploy, {
      pollIntervalMs: 30_000,
      timeoutMs: 60_000,
    }).track(target());

    expect(checkRuns.at(-1)).toMatchObject({ conclusion: 'timed_out' });
  });

  it('ignores previews belonging to another PR', async () => {
    const { octokit, checkRuns } = mockOctokit();
    const dokploy = stubDokploy([
      [preview('done', { pullRequestNumber: '99' })],
    ]);

    await tracker(octokit, dokploy, {
      pollIntervalMs: 30_000,
      timeoutMs: 60_000,
    }).track(target());

    expect(checkRuns.at(-1)).toMatchObject({ conclusion: 'timed_out' });
  });

  it('picks the newest preview when several exist for the PR', async () => {
    const { octokit, comments } = mockOctokit();
    const dokploy = stubDokploy([
      [
        preview('error', {
          createdAt: '2026-08-01T00:00:00.000Z',
          appName: 'old',
        }),
        preview('done', {
          createdAt: '2026-08-09T00:00:00.000Z',
          appName: 'new',
        }),
      ],
    ]);

    await tracker(octokit, dokploy).track(target());
    expect(String(comments.at(-1)?.body)).toContain('new');
  });

  it('clears the run from `active` once it settles', async () => {
    const { octokit } = mockOctokit();
    const instance = tracker(octokit, stubDokploy([[preview('done')]]));
    await instance.track(target());
    expect(instance.active).toEqual([]);
  });

  it('supersedes an in-flight run for the same PR and commit', async () => {
    const { octokit, checkRuns } = mockOctokit();
    const instance = tracker(octokit, stubDokploy([[preview('running')]]), {
      pollIntervalMs: 30_000,
      timeoutMs: 300_000,
    });

    const first = instance.track(target());
    const second = instance.track(target());
    await Promise.all([first, second]);

    // The superseded loop stops rather than racing the new one to the finish.
    expect(instance.active).toEqual([]);
    expect(checkRuns.length).toBeGreaterThan(0);
  });

  it('keeps a separate run per head commit', async () => {
    const { octokit } = mockOctokit();
    const instance = tracker(octokit, stubDokploy([[preview('done')]]));
    await Promise.all([
      instance.track(target({ headSha: 'sha-one' })),
      instance.track(target({ headSha: 'sha-two' })),
    ]);
    expect(instance.active).toEqual([]);
  });

  it('survives a GitHub failure on the initial check', async () => {
    const { octokit, checkRuns } = mockOctokit();
    octokit.rest.checks.create = vi.fn(async () => {
      throw new Error('github 500');
    }) as never;

    await expect(
      tracker(octokit, stubDokploy([[preview('done')]])).track(target()),
    ).resolves.toBeUndefined();
    expect(checkRuns).toHaveLength(0);
  });

  it('dispose() stops every loop', async () => {
    const { octokit } = mockOctokit();
    const instance = tracker(octokit, stubDokploy([[preview('running')]]), {
      timeoutMs: 10 * 60_000,
    });
    void instance.track(target());
    instance.dispose();
    expect(instance.active).toEqual([]);
  });
});
