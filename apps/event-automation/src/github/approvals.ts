/**
 * Bulk PR approval, for an explicit list of PRs or a whole `gh stack`.
 *
 * A stack is a chain of dependent PRs where each one's base is the branch below
 * it. Reviewing the top of a stack means approving every layer under it, and
 * doing that by hand is both tedious and easy to get half-done — which is the
 * state this exists to avoid.
 *
 * Three properties shape the implementation:
 *
 * 1. **Approving is a write against review state**, so every refusal is
 *    explicit and per PR. A closed, merged or draft PR is reported as skipped
 *    rather than approved, and an unknown PR is an error on that PR alone.
 * 2. **Partial success is the normal outcome.** Ten PRs where one 404s should
 *    approve nine and say which one failed, so the response is a per-PR result
 *    list and the status code reflects the mix.
 * 3. **Re-approving is a no-op.** GitHub happily stacks duplicate APPROVE
 *    reviews, which spams every subscriber; an existing approval from this App
 *    on the current head is left alone.
 */

import type { Logger } from '@samyx/github-automation-suite';
import type { AppOctokit, RepoRef } from './checks';

/** What happened to one PR. */
export interface ApprovalResult {
  pr: number;
  status: 'approved' | 'already-approved' | 'skipped' | 'failed';
  /** Why, for everything except a plain approval. */
  reason?: string;
  url?: string;
}

export interface ApproveOptions {
  octokit: AppOctokit;
  repo: RepoRef;
  logger: Logger;
  /** Review body. GitHub shows this on the approval. */
  body?: string;
  /**
   * Approve even a draft PR. Off by default: a draft is explicitly "not ready",
   * and approving one is almost always a mistake rather than an intent.
   */
  includeDrafts?: boolean;
}

/** One member of a stack, in stack order (bottom first). */
export interface StackMember {
  number: number;
  state?: string;
  draft?: boolean;
  merged?: boolean;
}

/** A stack as GitHub reports it. */
export interface StackInfo {
  number: number;
  base?: string;
  open?: boolean;
  pullRequests: StackMember[];
}

/**
 * The raw shape of `GET /repos/{owner}/{repo}/stacks/{number}`.
 *
 * Declared rather than imported because stacked PRs are not in Octokit's
 * generated types yet; only the fields actually read are named.
 */
interface StackResponse {
  number?: number;
  base?: { ref?: string };
  open?: boolean;
  pull_requests?: Array<{
    number?: number;
    state?: string;
    draft?: boolean;
    merged_at?: string | null;
  }>;
}

/**
 * Read a stack and its member PRs, in stack order.
 *
 * The endpoint is addressed by the stack's own number, which is *not* a PR
 * number — GitHub numbers stacks separately. `resolveStack` accepts either, by
 * falling back to "which stack is this PR in?" when the direct read 404s, so an
 * operator can pass the PR number they are looking at.
 */
export async function readStack(
  octokit: AppOctokit,
  repo: RepoRef,
  stackNumber: number,
): Promise<StackInfo | undefined> {
  if (!octokit.request) return undefined;
  const { data } = await octokit.request<StackResponse>(
    'GET /repos/{owner}/{repo}/stacks/{stack_number}',
    { owner: repo.owner, repo: repo.name, stack_number: stackNumber },
  );
  return {
    number: data.number ?? stackNumber,
    base: data.base?.ref,
    open: data.open,
    pullRequests: (data.pull_requests ?? [])
      .filter(
        (pull): pull is { number: number } & typeof pull =>
          typeof pull.number === 'number',
      )
      .map((pull) => ({
        number: pull.number,
        state: pull.state,
        draft: pull.draft,
        // The REST payload reports a merge as a timestamp, not a boolean.
        merged: pull.merged_at != null,
      })),
  };
}

/** GraphQL shape for "which stack is this PR in?". */
interface StackForPrResponse {
  data?: {
    repository?: {
      pullRequest?: { stack?: { number?: number } | null } | null;
    } | null;
  };
}

/**
 * The stack containing a given PR, or `undefined` when it is not in one.
 *
 * Only GraphQL exposes this direction — there is no
 * `GET /pulls/{n}/stack` — so this is the one place the service leaves REST.
 */
export async function stackNumberForPr(
  octokit: AppOctokit,
  repo: RepoRef,
  prNumber: number,
): Promise<number | undefined> {
  if (!octokit.request) return undefined;
  const { data } = await octokit.request<StackForPrResponse>('POST /graphql', {
    query: `query($owner:String!,$name:String!,$number:Int!){
      repository(owner:$owner,name:$name){
        pullRequest(number:$number){ stack { number } }
      }
    }`,
    variables: { owner: repo.owner, name: repo.name, number: prNumber },
  });
  return data?.data?.repository?.pullRequest?.stack?.number ?? undefined;
}

/**
 * Resolve a requested stack number to a real stack.
 *
 * Tries it as a stack number first, then as a PR number. Operators read PR
 * numbers off the page they are looking at and stacks are numbered separately,
 * so accepting only one of the two would be a coin flip.
 */
export async function resolveStack(
  octokit: AppOctokit,
  repo: RepoRef,
  requested: number,
  logger: Logger,
): Promise<StackInfo | undefined> {
  try {
    return await readStack(octokit, repo, requested);
  } catch (error) {
    logger.debug(
      { stack: requested, error: String(error) },
      'approvals: no stack with that number — trying it as a PR number',
    );
  }

  const viaPr = await stackNumberForPr(octokit, repo, requested).catch(
    () => undefined,
  );
  if (viaPr === undefined || viaPr === requested) return undefined;
  return await readStack(octokit, repo, viaPr).catch(() => undefined);
}

/**
 * Approve a list of PRs.
 *
 * Sequential on purpose: these are writes against the same repo, a partial
 * result has to be attributable to a specific PR, and a bulk approval is not
 * latency-sensitive.
 */
export async function approvePullRequests(
  prNumbers: readonly number[],
  options: ApproveOptions,
): Promise<ApprovalResult[]> {
  const results: ApprovalResult[] = [];
  // A repeated number would otherwise produce two approvals on one PR.
  for (const pr of [...new Set(prNumbers)]) {
    results.push(await approveOne(pr, options));
  }
  return results;
}

async function approveOne(
  pr: number,
  options: ApproveOptions,
): Promise<ApprovalResult> {
  const { octokit, repo, logger } = options;
  try {
    const { data: pull } = await octokit.rest.pulls.get({
      owner: repo.owner,
      repo: repo.name,
      pull_number: pr,
    });
    const url = pull.html_url;

    // Read before write. Each of these is a PR an operator could plausibly
    // include in a bulk request by accident, and none of them wants an
    // approval.
    if (pull.merged) {
      return { pr, url, status: 'skipped', reason: 'already merged' };
    }
    if (pull.state && pull.state !== 'open') {
      return { pr, url, status: 'skipped', reason: `PR is ${pull.state}` };
    }
    if (pull.draft && !options.includeDrafts) {
      return {
        pr,
        url,
        status: 'skipped',
        reason: 'PR is a draft — pass "drafts": true to approve it anyway',
      };
    }

    if (await hasOwnApproval(octokit, repo, pr)) {
      return { pr, url, status: 'already-approved' };
    }

    await octokit.rest.pulls.createReview({
      owner: repo.owner,
      repo: repo.name,
      pull_number: pr,
      event: 'APPROVE',
      ...(options.body ? { body: options.body } : {}),
    });
    logger.info({ pr, repo: repo.name }, 'approvals: approved a pull request');
    return { pr, url, status: 'approved' };
  } catch (error) {
    logger.error(
      { pr, repo: repo.name, error: String(error) },
      'approvals: approving a pull request failed',
    );
    return { pr, status: 'failed', reason: describeError(error) };
  }
}

/**
 * Whether this App has already approved the PR.
 *
 * GitHub accepts duplicate APPROVE reviews and notifies every subscriber for
 * each one, so a retried bulk approval would be noisy rather than idempotent.
 * A later `CHANGES_REQUESTED` from the same reviewer supersedes an earlier
 * approval, so only the most recent verdict counts.
 */
async function hasOwnApproval(
  octokit: AppOctokit,
  repo: RepoRef,
  pr: number,
): Promise<boolean> {
  try {
    const { data } = await octokit.rest.pulls.listReviews({
      owner: repo.owner,
      repo: repo.name,
      pull_number: pr,
      per_page: 100,
    });
    let approved = false;
    for (const review of data) {
      // Only this App's own reviews: a human's approval is not a reason to
      // withhold the one that was asked for.
      if (review.user?.type !== 'Bot') continue;
      if (review.state === 'APPROVED') approved = true;
      if (review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED')
        approved = false;
    }
    return approved;
  } catch {
    // Unreadable review history is not a reason to refuse: the caller asked for
    // an approval, and a duplicate is the recoverable direction.
    return false;
  }
}

function describeError(error: unknown): string {
  const status = (error as { status?: number } | undefined)?.status;
  if (status === 404) return 'no such pull request';
  if (status === 403) return 'the GitHub App may not approve this pull request';
  if (status === 422) {
    // The App's own PR, or an already-terminal review state.
    return 'GitHub rejected the approval (a PR cannot approve itself)';
  }
  return status ? `GitHub returned HTTP ${status}` : String(error);
}
