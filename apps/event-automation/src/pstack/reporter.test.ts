/**
 * pstack reporter tests, driven by the **real payloads** captured from a live
 * pstack instance (stack `pr-16828`) rather than invented ones.
 *
 * The payloads matter: they are the reason the reporter derives the PR number
 * from the stack name and settles service checks from `pendingContainers`.
 */

import { noopLogger } from '@samyx/github-automation-suite';
import { describe, expect, it, vi } from 'vitest';
import type { AppOctokit } from '../github/checks';
import { PstackReporter, type PstackSignal } from './reporter';
import {
  parseStackIdentity,
  previewUrlFor,
  serviceFromContainer,
} from './stack';

const REPO = { owner: 'housing-cloud', name: 'web' };

/** The real events supplied, verbatim. */
const REAL = {
  healthcheckUpdated: {
    id: 'evt_msnjnfti_i_v0tbar',
    event: 'healthcheck.updated',
    at: 1786385243862,
    data: {
      stack: 'pr-16828',
      container: 'pr-16828-web-1',
      service: 'web',
      status: 'healthy',
      previous: 'starting',
    },
  },
  stackTimedout: {
    id: 'evt_msnhilf4_a_vuiop4',
    event: 'stack.timedout',
    at: 1786381658608,
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
  },
  containerStarted: {
    id: 'evt_msnjmzk0_b_52vsvq',
    event: 'container.started',
    at: 1786385222784,
    data: {
      stack: 'pr-16828',
      deployment: 'pr-16828',
      container: 'pr-16828-web-1',
      service: 'web',
      action: 'start',
      by: 'root (PSTACK_TOKEN)',
    },
  },
  deploymentCreated: {
    id: 'evt_msnfljfi_1_hqluya',
    event: 'deployment.created',
    at: 1786378436766,
    data: {
      id: 'pr-16828',
      kind: 'isolated',
      stack: 'pr-16828',
      specName: null,
      stackSharedWith: [],
    },
  },
  jobStarted: {
    id: 'evt_msnflk07_2_i9xr14',
    event: 'job.started',
    at: 1786378437511,
    data: {
      jobId: 'up-pr-16828-1-j5cfw8',
      stack: 'pr-16828',
      action: 'up',
      startedAt: 1786378437511,
    },
  },
  jobSucceeded: {
    id: 'evt_msnvxsr7_o_pyxv5n',
    event: 'job.succeeded',
    at: 1786405882579,
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
  },
  jobFailed: {
    id: 'evt_msngvem0_3_msyvpz',
    event: 'job.failed',
    at: 1786380576696,
    data: {
      jobId: 'up-pr-16828-1-j5cfw8',
      stack: 'pr-16828',
      action: 'up',
      state: 'failed',
      startedAt: 1786378437511,
      endedAt: 1786380576696,
      durationMs: 2139185,
      leakedAxes: [],
      verified: null,
      unverifiable: 0,
    },
  },
  dbSeedStarted: {
    id: 'evt_msnhep6s_4_nivjk6',
    event: 'container.started',
    at: 1786381476868,
    data: {
      stack: 'pr-16828',
      deployment: 'pr-16828',
      container: 'pr-16828-db-seed-1',
      service: 'db-seed',
      action: 'start',
      by: 'root (PSTACK_TOKEN)',
    },
  },
} as const;

/** Turn a raw pstack envelope into the reporter's signal, as the rule does. */
function signal(envelope: {
  event: string;
  data: Record<string, unknown>;
}): PstackSignal {
  const d = envelope.data;
  return {
    type: envelope.event,
    stack: d.stack as string | undefined,
    container: d.container as string | undefined,
    service: d.service as string | undefined,
    state: d.state as string | undefined,
    action: d.action as string | undefined,
    containers: d.containers as number | undefined,
    readyCount: d.ready as number | undefined,
    failedContainers: d.failedContainers as string[] | undefined,
    pendingContainers: d.pendingContainers as string[] | undefined,
    reachable: d.reachable as boolean | undefined,
    durationMs: d.durationMs as number | undefined,
    hasHealthcheck: d.hasHealthcheck as boolean | undefined,
    reason: d.reason as string | undefined,
    by: d.by as string | undefined,
  };
}

function mockOctokit(headSha = 'abc1234def') {
  const checks: Array<Record<string, unknown>> = [];
  const comments: Array<Record<string, unknown>> = [];
  let nextId = 500;
  const octokit: AppOctokit = {
    rest: {
      checks: {
        create: vi.fn(async (params) => {
          // Record the id we hand back, so a test can follow a check run's
          // updates without inferring ids from call order.
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
        get: vi.fn(async () => ({ data: { head: { sha: headSha } } })),
      },
      issues: {
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
        createComment: vi.fn(async (params) => {
          comments.push({ op: 'create', ...params });
          return { data: { id: 900 } };
        }),
        updateComment: vi.fn(async (params) => {
          comments.push({ op: 'update', ...params });
          return {};
        }),
        listComments: vi.fn(async () => ({ data: [] })),
      },
    },
  };
  return { octokit, checks, comments };
}

function reporter(overrides: Partial<{ services: string[] }> = {}) {
  const { octokit, checks, comments } = mockOctokit();
  const instance = new PstackReporter({
    octokit,
    repo: REPO,
    logger: noopLogger,
    services: overrides.services ?? ['db-seed', 'web'],
    previewDomain: 'preview.housing.cloud',
    pstackBaseUrl: 'https://pstack.housing.cloud',
  });
  return { reporter: instance, octokit, checks, comments };
}

/**
 * Latest state written for a named check run: the `create` call, or the last
 * `update` carrying the id that create returned.
 */
function latest(checks: Array<Record<string, unknown>>, name: string) {
  const created = checks.find((c) => c.op === 'create' && c.name === name);
  if (!created) return undefined;
  const updates = checks.filter(
    (c) => c.op === 'update' && c.check_run_id === created.id,
  );
  return (updates.at(-1) ?? created) as Record<string, unknown>;
}

/** The summary text of a check run's latest state, or '' when absent. */
function summaryOf(
  checks: Array<Record<string, unknown>>,
  name: string,
): string {
  const output = latest(checks, name)?.output as
    | { summary?: string }
    | undefined;
  return output?.summary ?? '';
}

describe('parseStackIdentity', () => {
  it('reads the PR number from the real stack name', () => {
    expect(parseStackIdentity('pr-16828')).toEqual({
      prNumber: 16828,
      prefix: '',
    });
  });

  it('supports a prefixed stack', () => {
    expect(parseStackIdentity('web-pr-12')).toEqual({
      prNumber: 12,
      prefix: 'web',
    });
  });

  it('ignores a stack that does not name a PR', () => {
    expect(parseStackIdentity('staging')).toBeUndefined();
    expect(parseStackIdentity('release-2024')).toBeUndefined();
    expect(parseStackIdentity(undefined)).toBeUndefined();
  });
});

describe('serviceFromContainer', () => {
  it('recovers the service from the real container names', () => {
    expect(serviceFromContainer('pr-16828-web-1', 'pr-16828')).toBe('web');
    expect(serviceFromContainer('pr-16828-db-seed-1', 'pr-16828')).toBe(
      'db-seed',
    );
  });
});

describe('previewUrlFor', () => {
  it('builds the URL pstack’s generated Traefik router serves', () => {
    expect(previewUrlFor('web', 'pr-16828', 'preview.housing.cloud')).toBe(
      'https://web-pr-16828.preview.housing.cloud',
    );
  });

  it('returns nothing without a configured domain', () => {
    expect(previewUrlFor('web', 'pr-16828', undefined)).toBeUndefined();
  });
});

describe('PstackReporter — requirement 1 (stack check)', () => {
  it('opens all three checks in_progress on the first event', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));

    const created = checks.filter((c) => c.op === 'create');
    expect(created.map((c) => c.name)).toEqual([
      'pstack/stack',
      'pstack/db-seed',
      'pstack/web',
    ]);
    for (const check of created) {
      expect(check.status).toBe('in_progress');
      expect(check.head_sha).toBe('abc1234def');
    }
  });

  it('marks the stack check successful on stack.ready', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle({
      type: 'stack.ready',
      stack: 'pr-16828',
      containers: 4,
      readyCount: 4,
    });

    const stack = latest(checks, 'pstack/stack');
    expect(stack?.status).toBe('completed');
    expect(stack?.conclusion).toBe('success');
  });

  it('fails the stack check on the real stack.timedout payload', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle(signal(REAL.stackTimedout));

    const stack = latest(checks, 'pstack/stack');
    expect(stack?.status).toBe('completed');
    expect(stack?.conclusion).toBe('failure');
    expect(summaryOf(checks, 'pstack/stack')).toContain('pr-16828-web-1');
  });

  it('fails the stack check on the real job.failed payload', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle(signal(REAL.jobFailed));

    expect(latest(checks, 'pstack/stack')?.conclusion).toBe('failure');
  });

  it('does not pass the stack check merely because the job succeeded', async () => {
    // `job.succeeded` for an `up` means the commands ran — `compose up -d`
    // returns once containers are created, not once the app is up.
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle({ type: 'job.succeeded', stack: 'pr-16828', action: 'up' });

    expect(latest(checks, 'pstack/stack')?.status).toBe('in_progress');
  });
});

describe('PstackReporter — requirement 2 (db-seed)', () => {
  it('passes the db-seed check when its container reports ready', async () => {
    // A one-shot container that exits 0 is `ready` in pstack's verdict.
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle({
      type: 'container.ready',
      stack: 'pr-16828',
      container: 'pr-16828-db-seed-1',
      service: 'db-seed',
      hasHealthcheck: false,
    });

    const seed = latest(checks, 'pstack/db-seed');
    expect(seed?.status).toBe('completed');
    expect(seed?.conclusion).toBe('success');
  });

  it('fails the db-seed check when the container fails to start', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle({
      type: 'container.start-failed',
      stack: 'pr-16828',
      container: 'pr-16828-db-seed-1',
      service: 'db-seed',
      reason: 'exited with code 1',
    });

    const seed = latest(checks, 'pstack/db-seed');
    expect(seed?.conclusion).toBe('failure');
    expect(summaryOf(checks, 'pstack/db-seed')).toContain('exited with code 1');
  });

  it('records that an unprobed container was only running, not verified', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle({
      type: 'container.ready',
      stack: 'pr-16828',
      container: 'pr-16828-db-seed-1',
      service: 'db-seed',
      hasHealthcheck: false,
    });

    expect(summaryOf(checks, 'pstack/db-seed')).toContain('no healthcheck');
  });
});

describe('PstackReporter — requirement 3 (web)', () => {
  it('passes the web check when its container reports ready', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle({
      type: 'container.ready',
      stack: 'pr-16828',
      container: 'pr-16828-web-1',
      service: 'web',
      hasHealthcheck: true,
    });

    const web = latest(checks, 'pstack/web');
    expect(web?.status).toBe('completed');
    expect(web?.conclusion).toBe('success');
  });

  /**
   * The regression the real payload exposes: `web` never emits a per-container
   * event, and its only trace is `pendingContainers` on the timeout. Without
   * that path the check would stay `in_progress` forever and block the PR.
   */
  it('fails the web check from pendingContainers on the real stack.timedout', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle(signal(REAL.stackTimedout));

    const web = latest(checks, 'pstack/web');
    expect(web?.status).toBe('completed');
    expect(web?.conclusion).toBe('failure');
    expect(summaryOf(checks, 'pstack/web')).toContain('never became ready');
  });

  it('leaves no check pending once the stack has settled', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle(signal(REAL.stackTimedout));

    for (const name of ['pstack/stack', 'pstack/db-seed', 'pstack/web']) {
      expect(latest(checks, name)?.status).toBe('completed');
    }
  });

  it('passes a still-pending service when the stack reports ready', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle({
      type: 'stack.ready',
      stack: 'pr-16828',
      containers: 4,
      readyCount: 4,
    });

    expect(latest(checks, 'pstack/web')?.conclusion).toBe('success');
    expect(latest(checks, 'pstack/db-seed')?.conclusion).toBe('success');
  });
});

describe('PstackReporter — requirement 4 (PR comment)', () => {
  it('posts the comment once the stack check settles', async () => {
    const { reporter: r, comments } = reporter();
    await r.handle(signal(REAL.jobStarted));
    expect(comments).toHaveLength(0); // still pending — nothing to report yet

    await r.handle(signal(REAL.stackTimedout));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.op).toBe('create');
    expect(comments[0]?.issue_number).toBe(16828);
  });

  it('carries the status and the deployment details', async () => {
    const { reporter: r, comments } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle(signal(REAL.stackTimedout));

    const body = String(comments.at(-1)?.body);
    expect(body).toContain('Preview stack');
    expect(body).toContain('🔴 Failed');
    expect(body).toContain('pr-16828');
    expect(body).toContain('3 of 4 ready');
    expect(body).toContain('pr-16828-web-1');
    expect(body).toContain('https://pstack.housing.cloud');
  });

  it('shows the preview URL for a service that came up', async () => {
    const { reporter: r, comments } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle({
      type: 'stack.ready',
      stack: 'pr-16828',
      containers: 4,
      readyCount: 4,
    });

    expect(String(comments.at(-1)?.body)).toContain(
      'https://web-pr-16828.preview.housing.cloud',
    );
  });

  it('edits the same comment instead of posting a new one', async () => {
    const { reporter: r, comments } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle(signal(REAL.stackTimedout));
    await r.handle({
      type: 'container.ready',
      stack: 'pr-16828',
      container: 'pr-16828-web-1',
      service: 'web',
      hasHealthcheck: true,
    });

    expect(comments.filter((c) => c.op === 'create')).toHaveLength(1);
    expect(comments.filter((c) => c.op === 'update').length).toBeGreaterThan(0);
    expect(String(comments.at(-1)?.body)).toContain(
      'hou-event-automation:pstack-stack',
    );
  });
});

describe('PstackReporter — edge cases', () => {
  it('ignores a stack whose name does not identify a PR', async () => {
    const { reporter: r, checks, octokit } = reporter();
    await r.handle({ type: 'stack.ready', stack: 'staging' });

    expect(checks).toHaveLength(0);
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });

  it('resolves the PR head commit once and reuses it', async () => {
    const { reporter: r, octokit } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle(signal(REAL.stackTimedout));

    expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
  });

  it('gives up cleanly when the PR cannot be resolved', async () => {
    const { octokit, checks } = mockOctokit();
    octokit.rest.pulls.get = vi.fn(async () => {
      throw new Error('404 not found');
    });
    const r = new PstackReporter({
      octokit,
      repo: REPO,
      logger: noopLogger,
      services: ['web'],
    });

    await expect(r.handle(signal(REAL.jobStarted))).resolves.toBeUndefined();
    expect(checks).toHaveLength(0);
  });

  it('re-opens the checks when the stack is redeployed', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle(signal(REAL.stackTimedout));
    expect(latest(checks, 'pstack/web')?.conclusion).toBe('failure');

    await r.handle(signal(REAL.jobStarted)); // a new `up` for the same stack
    expect(latest(checks, 'pstack/web')?.status).toBe('in_progress');
    expect(latest(checks, 'pstack/stack')?.status).toBe('in_progress');
  });

  it('fails pending checks when an operator stops a container', async () => {
    // Stopping a container cancels the readiness watch, so no stack.* verdict
    // follows — without this the checks would hang forever.
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle({
      type: 'container.stopped',
      stack: 'pr-16828',
      container: 'pr-16828-web-1',
      service: 'web',
      by: 'root (PSTACK_TOKEN)',
    });

    expect(latest(checks, 'pstack/stack')?.status).toBe('completed');
    expect(latest(checks, 'pstack/web')?.conclusion).toBe('failure');
    expect(summaryOf(checks, 'pstack/web')).toContain('root (PSTACK_TOKEN)');
  });

  it('does not rewrite GitHub when nothing changed', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    const afterOpen = checks.length;

    // `container.started` is not a readiness verdict — it must not churn.
    await r.handle(signal(REAL.containerStarted));
    expect(checks).toHaveLength(afterOpen);
  });

  it('writes only the check that actually moved', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    checks.length = 0;

    // db-seed settles; the stack and web checks are unchanged, so exactly one
    // check run is written rather than all three.
    await r.handle({
      type: 'container.ready',
      stack: 'pr-16828',
      container: 'pr-16828-db-seed-1',
      service: 'db-seed',
      hasHealthcheck: false,
    });

    expect(checks).toHaveLength(1);
    expect((checks[0]?.output as { title: string } | undefined)?.title).toBe(
      'db-seed ready',
    );
  });

  it('notes when a verdict was taken on last-known data', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle(signal(REAL.jobStarted));
    await r.handle({
      type: 'stack.failed',
      stack: 'pr-16828',
      failedContainers: ['pr-16828-web-1'],
      reachable: false,
    });

    expect(summaryOf(checks, 'pstack/stack')).toContain(
      'Docker stopped answering',
    );
  });

  it('tracks two PRs independently', async () => {
    const { reporter: r, checks } = reporter();
    await r.handle({ type: 'job.started', stack: 'pr-1', action: 'up' });
    await r.handle({ type: 'job.started', stack: 'pr-2', action: 'up' });
    await r.handle({
      type: 'stack.ready',
      stack: 'pr-1',
      containers: 1,
      readyCount: 1,
    });

    expect(r.active).toEqual(['pr-1', 'pr-2']);
    // pr-2 must still be pending: only pr-1 reported ready.
    const pr2Creates = checks.filter(
      (c) => c.op === 'create' && c.name === 'pstack/stack',
    );
    expect(pr2Creates).toHaveLength(2);
  });
});
