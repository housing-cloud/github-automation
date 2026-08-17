/**
 * Bulk approval: request parsing and the GitHub calls it drives.
 *
 * Approving is a write against review state, so the assertions here are mostly
 * about what is *not* done — the refusals, the skips, and the duplicate that
 * never gets sent.
 */

import { noopLogger } from '@samyx/github-automation-suite';
import { describe, expect, it, vi } from 'vitest';
import { MAX_PRS_PER_REQUEST, parseApprovalRequest } from './approval-request';
import {
  approvePullRequests,
  readStack,
  resolveStack,
  stackNumberForPr,
} from './approvals';
import type { AppOctokit, PullRequestReview } from './checks';

const REPO = { owner: 'housing-cloud', name: 'web' };

describe('parseApprovalRequest', () => {
  it('reads a list of pull requests', () => {
    expect(parseApprovalRequest({ prs: [1, 2, 3] })).toEqual({
      kind: 'prs',
      prs: [1, 2, 3],
      body: undefined,
      drafts: false,
    });
  });

  it('reads a stack', () => {
    expect(parseApprovalRequest({ stack: 42 })).toMatchObject({
      kind: 'stack',
      stack: 42,
    });
  });

  it('carries an optional review body and the drafts opt-in', () => {
    expect(
      parseApprovalRequest({ prs: [1], body: '  ship it  ', drafts: true }),
    ).toMatchObject({ body: 'ship it', drafts: true });
  });

  /**
   * Both at once has no unambiguous meaning, and guessing is a bad property in
   * something that approves code.
   */
  it('rejects a body carrying both forms, or neither', () => {
    expect(parseApprovalRequest({ prs: [1], stack: 2 })).toHaveProperty(
      'error',
    );
    expect(parseApprovalRequest({})).toHaveProperty('error');
  });

  it('rejects anything that is not a JSON object', () => {
    for (const input of [null, [1, 2], 'prs', 7]) {
      expect(parseApprovalRequest(input)).toHaveProperty('error');
    }
  });

  it('rejects PR numbers that are not positive integers', () => {
    for (const prs of [[0], [-1], [1.5], ['3'], [null], []]) {
      expect(parseApprovalRequest({ prs })).toHaveProperty('error');
    }
  });

  it('rejects a stack number that is not a positive integer', () => {
    for (const stack of [0, -1, 2.5, '7', null]) {
      expect(parseApprovalRequest({ stack })).toHaveProperty('error');
    }
  });

  /** One call fans out to one write per entry, so the list is bounded. */
  it('rejects a list longer than the cap', () => {
    const prs = Array.from(
      { length: MAX_PRS_PER_REQUEST + 1 },
      (_, i) => i + 1,
    );
    expect(parseApprovalRequest({ prs })).toHaveProperty('error');
    expect(parseApprovalRequest({ prs: prs.slice(0, -1) })).not.toHaveProperty(
      'error',
    );
  });

  it('collapses a repeated PR number', () => {
    expect(parseApprovalRequest({ prs: [5, 5, 6] })).toMatchObject({
      prs: [5, 6],
    });
  });
});

/** A recording Octokit whose PRs and reviews the test scripts. */
function mockOctokit(
  options: {
    pulls?: Record<
      number,
      { state?: string; draft?: boolean; merged?: boolean }
    >;
    reviews?: Record<number, PullRequestReview[]>;
    failOn?: Record<number, number>;
  } = {},
) {
  const approved: number[] = [];
  const octokit = {
    rest: {
      checks: {
        create: vi.fn(async () => ({ data: { id: 1 } })),
        update: vi.fn(async () => ({})),
        listForRef: vi.fn(async () => ({ data: { check_runs: [] } })),
      },
      actions: { createWorkflowDispatch: vi.fn(async () => ({})) },
      repos: { createDispatchEvent: vi.fn(async () => ({})) },
      pulls: {
        get: vi.fn(async ({ pull_number }: { pull_number: number }) => {
          const status = options.failOn?.[pull_number];
          if (status) throw Object.assign(new Error('boom'), { status });
          const pull = options.pulls?.[pull_number] ?? {};
          return {
            data: {
              head: { sha: `sha-${pull_number}` },
              html_url: `https://github.com/housing-cloud/web/pull/${pull_number}`,
              state: pull.state ?? 'open',
              draft: pull.draft ?? false,
              merged: pull.merged ?? false,
            },
          };
        }),
        list: vi.fn(async () => ({ data: [] })),
        createReview: vi.fn(
          async ({ pull_number }: { pull_number: number }) => {
            approved.push(pull_number);
            return { data: { id: 100 + pull_number } };
          },
        ),
        listReviews: vi.fn(
          async ({ pull_number }: { pull_number: number }) => ({
            data: options.reviews?.[pull_number] ?? [],
          }),
        ),
      },
      issues: {
        listLabelsOnIssue: vi.fn(async () => ({ data: [] })),
        removeLabel: vi.fn(async () => ({})),
        createComment: vi.fn(async () => ({ data: { id: 1 } })),
        updateComment: vi.fn(async () => ({})),
        listComments: vi.fn(async () => ({ data: [] })),
      },
    },
  } as unknown as AppOctokit;
  return { octokit, approved };
}

const approve = (
  prs: number[],
  octokit: AppOctokit,
  extra: { body?: string; includeDrafts?: boolean } = {},
) =>
  approvePullRequests(prs, {
    octokit,
    repo: REPO,
    logger: noopLogger,
    ...extra,
  });

describe('approvePullRequests', () => {
  it('approves each open PR and says so', async () => {
    const { octokit, approved } = mockOctokit();
    const results = await approve([1, 2], octokit);

    expect(approved).toEqual([1, 2]);
    expect(results).toEqual([
      {
        pr: 1,
        url: 'https://github.com/housing-cloud/web/pull/1',
        status: 'approved',
      },
      {
        pr: 2,
        url: 'https://github.com/housing-cloud/web/pull/2',
        status: 'approved',
      },
    ]);
  });

  it('passes the review body through', async () => {
    const { octokit } = mockOctokit();
    await approve([1], octokit, { body: 'stack approved' });

    expect(octokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE', body: 'stack approved' }),
    );
  });

  /**
   * GitHub accepts duplicate APPROVE reviews and notifies every subscriber for
   * each one, so a retried bulk approval would be noise rather than a no-op.
   */
  it('does not approve twice', async () => {
    const { octokit, approved } = mockOctokit({
      reviews: {
        1: [{ id: 1, state: 'APPROVED', user: { login: 'bot', type: 'Bot' } }],
      },
    });
    const results = await approve([1], octokit);

    expect(approved).toEqual([]);
    expect(results[0]).toMatchObject({ status: 'already-approved' });
  });

  /** A human's approval is not a reason to withhold the one that was asked for. */
  it('still approves when only a human has approved', async () => {
    const { octokit, approved } = mockOctokit({
      reviews: {
        1: [
          { id: 1, state: 'APPROVED', user: { login: 'alice', type: 'User' } },
        ],
      },
    });
    await approve([1], octokit);

    expect(approved).toEqual([1]);
  });

  /** A later verdict supersedes an earlier one, so order decides. */
  it('re-approves after its own approval was dismissed', async () => {
    const { octokit, approved } = mockOctokit({
      reviews: {
        1: [
          { id: 1, state: 'APPROVED', user: { login: 'bot', type: 'Bot' } },
          { id: 2, state: 'DISMISSED', user: { login: 'bot', type: 'Bot' } },
        ],
      },
    });
    await approve([1], octokit);

    expect(approved).toEqual([1]);
  });

  it('skips a closed or merged PR instead of approving it', async () => {
    const { octokit, approved } = mockOctokit({
      pulls: { 1: { state: 'closed' }, 2: { merged: true } },
    });
    const results = await approve([1, 2], octokit);

    expect(approved).toEqual([]);
    expect(results[0]).toMatchObject({
      status: 'skipped',
      reason: 'PR is closed',
    });
    expect(results[1]).toMatchObject({
      status: 'skipped',
      reason: 'already merged',
    });
  });

  /**
   * A draft is explicitly "not ready". Approving one is nearly always a mistake
   * rather than an intent, so it takes a second, deliberate flag.
   */
  it('skips a draft unless drafts are opted in', async () => {
    const { octokit, approved } = mockOctokit({
      pulls: { 1: { draft: true } },
    });
    const skipped = await approve([1], octokit);
    expect(approved).toEqual([]);
    expect(skipped[0]).toMatchObject({ status: 'skipped' });
    expect(skipped[0]?.reason).toContain('draft');

    await approve([1], octokit, { includeDrafts: true });
    expect(approved).toEqual([1]);
  });

  /** Nine of ten approved is the right outcome, not an all-or-nothing failure. */
  it('keeps going after one PR fails, and attributes the failure', async () => {
    const { octokit, approved } = mockOctokit({ failOn: { 2: 404 } });
    const results = await approve([1, 2, 3], octokit);

    expect(approved).toEqual([1, 3]);
    expect(results[1]).toMatchObject({
      pr: 2,
      status: 'failed',
      reason: 'no such pull request',
    });
  });

  it('explains the failures an operator can act on', async () => {
    const { octokit } = mockOctokit({ failOn: { 1: 403, 2: 422 } });
    const results = await approve([1, 2], octokit);

    expect(results[0]?.reason).toContain('may not approve');
    expect(results[1]?.reason).toContain('cannot approve itself');
  });

  it('approves a repeated number only once', async () => {
    const { octokit, approved } = mockOctokit();
    await approve([7, 7], octokit);
    expect(approved).toEqual([7]);
  });

  /** Unreadable review history must not block the approval that was asked for. */
  it('approves anyway when the review history cannot be read', async () => {
    const { octokit, approved } = mockOctokit();
    octokit.rest.pulls.listReviews = vi.fn(async () => {
      throw new Error('502');
    });
    await approve([1], octokit);
    expect(approved).toEqual([1]);
  });
});

/** An Octokit whose raw `request` answers the stacks endpoints. */
function stackOctokit(handler: (route: string, params: any) => unknown) {
  const { octokit, approved } = mockOctokit();
  const request = vi.fn(async (route: string, params: any) => ({
    data: handler(route, params),
  }));
  return {
    octokit: Object.assign(octokit, { request }) as AppOctokit,
    approved,
    request,
  };
}

const STACK_PAYLOAD = {
  number: 13956,
  base: { ref: 'main' },
  open: true,
  pull_requests: [
    { number: 10, state: 'closed', draft: false, merged_at: '2026-01-01' },
    { number: 11, state: 'open', draft: false, merged_at: null },
    { number: 12, state: 'open', draft: true, merged_at: null },
  ],
};

describe('readStack', () => {
  it('reads the members in stack order, bottom first', async () => {
    const { octokit, request } = stackOctokit(() => STACK_PAYLOAD);
    const stack = await readStack(octokit, REPO, 13956);

    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/stacks/{stack_number}',
      expect.objectContaining({ stack_number: 13956 }),
    );
    expect(stack?.pullRequests.map((p) => p.number)).toEqual([10, 11, 12]);
    expect(stack?.base).toBe('main');
  });

  /** The REST payload reports a merge as a timestamp, not a boolean. */
  it('reads a merged member from its merge timestamp', async () => {
    const { octokit } = stackOctokit(() => STACK_PAYLOAD);
    const stack = await readStack(octokit, REPO, 13956);

    expect(stack?.pullRequests[0]).toMatchObject({ number: 10, merged: true });
    expect(stack?.pullRequests[1]).toMatchObject({ number: 11, merged: false });
  });
});

describe('resolveStack', () => {
  /**
   * Stacks are numbered separately from PRs, but an operator reads a PR number
   * off the page in front of them. Accepting only one would be a coin flip.
   */
  it('accepts a PR number and finds the stack containing it', async () => {
    const { octokit } = stackOctokit((route, params) => {
      if (route.includes('stacks/{stack_number}')) {
        if (params.stack_number === 11) {
          throw Object.assign(new Error('nope'), { status: 404 });
        }
        return STACK_PAYLOAD;
      }
      return {
        data: { repository: { pullRequest: { stack: { number: 13956 } } } },
      };
    });

    const stack = await resolveStack(octokit, REPO, 11, noopLogger);
    expect(stack?.number).toBe(13956);
  });

  it('prefers a direct stack-number hit without a second lookup', async () => {
    const { octokit, request } = stackOctokit(() => STACK_PAYLOAD);
    await resolveStack(octokit, REPO, 13956, noopLogger);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when the number is neither', async () => {
    const { octokit } = stackOctokit((route) => {
      if (route.includes('stacks/{stack_number}')) {
        throw Object.assign(new Error('nope'), { status: 404 });
      }
      return { data: { repository: { pullRequest: { stack: null } } } };
    });

    await expect(
      resolveStack(octokit, REPO, 999, noopLogger),
    ).resolves.toBeUndefined();
  });
});

describe('stackNumberForPr', () => {
  it('asks GraphQL, the only direction REST does not expose', async () => {
    const { octokit, request } = stackOctokit(() => ({
      data: { repository: { pullRequest: { stack: { number: 77 } } } },
    }));

    await expect(stackNumberForPr(octokit, REPO, 11)).resolves.toBe(77);
    expect(request).toHaveBeenCalledWith(
      'POST /graphql',
      expect.objectContaining({
        variables: { owner: REPO.owner, name: REPO.name, number: 11 },
      }),
    );
  });

  it('reports nothing for a PR in no stack', async () => {
    const { octokit } = stackOctokit(() => ({
      data: { repository: { pullRequest: { stack: null } } },
    }));
    await expect(stackNumberForPr(octokit, REPO, 11)).resolves.toBeUndefined();
  });
});
