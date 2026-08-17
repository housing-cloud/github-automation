/**
 * The GitHub REST calls this service needs beyond the suite's `OctokitLike`.
 *
 * The suite's GitHub plugin only *creates completed* check runs, which is
 * enough to mirror a finished deploy but not to track one: a preview stack has
 * to show up immediately as `in_progress` and then be *updated* in place as its
 * containers report, and the PR comment has to be edited rather than re-posted.
 * Both need endpoints outside `OctokitLike`, so this widened interface is what
 * the pstack reporter uses.
 */

export type CheckStatus = 'queued' | 'in_progress' | 'completed';
export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'neutral'
  | 'timed_out'
  | 'action_required'
  | 'skipped';

export interface CheckRunRef {
  id: number;
  name?: string;
}

export interface IssueComment {
  id: number;
  body?: string | null | undefined;
}

/** A submitted review, reduced to what re-approval needs to decide. */
export interface PullRequestReview {
  id: number;
  state?: string;
  user?: { login?: string; type?: string } | null;
}

/**
 * The slice of Octokit this service depends on.
 *
 * A strict superset of the suite's `OctokitLike`, so one client satisfies both
 * the GitHub plugin's handlers and the reporter's upserts.
 */
export interface AppOctokit {
  /**
   * The generic REST caller every Octokit exposes.
   *
   * Needed because GitHub's stacked-pull-request endpoints (`/repos/{o}/{r}/
   * stacks/...`) are not in Octokit's generated surface yet. Optional so the
   * many test doubles that never touch a stack stay valid.
   */
  request?: <T = unknown>(
    route: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: T }>;
  rest: {
    checks: {
      create: (params: {
        owner: string;
        repo: string;
        name: string;
        head_sha: string;
        status: CheckStatus;
        conclusion?: CheckConclusion;
        details_url?: string;
        started_at?: string;
        completed_at?: string;
        output?: { title: string; summary: string };
      }) => Promise<{ data: CheckRunRef }>;
      update: (params: {
        owner: string;
        repo: string;
        check_run_id: number;
        status?: CheckStatus;
        conclusion?: CheckConclusion;
        details_url?: string;
        completed_at?: string;
        output?: { title: string; summary: string };
      }) => Promise<unknown>;
      listForRef: (params: {
        owner: string;
        repo: string;
        ref: string;
        check_name?: string;
        filter?: 'all' | 'latest';
        per_page?: number;
        page?: number;
      }) => Promise<{ data: { check_runs: CheckRunRef[] } }>;
    };
    actions: {
      createWorkflowDispatch: (params: {
        owner: string;
        repo: string;
        workflow_id: string | number;
        ref: string;
        inputs?: Record<string, string>;
      }) => Promise<unknown>;
    };
    repos: {
      createDispatchEvent: (params: {
        owner: string;
        repo: string;
        event_type: string;
        client_payload?: Record<string, unknown>;
      }) => Promise<unknown>;
    };
    pulls: {
      /**
       * pstack webhooks name a *stack*, never a commit, but a check run must be
       * attached to a `head_sha` — so the PR's head commit is looked up here.
       */
      get: (params: {
        owner: string;
        repo: string;
        pull_number: number;
      }) => Promise<{
        data: {
          head: { sha: string };
          html_url?: string;
          state?: string;
          /** A draft cannot be approved meaningfully — see `approvals.ts`. */
          draft?: boolean;
          merged?: boolean;
          title?: string;
        };
      }>;
      list: (params: {
        owner: string;
        repo: string;
        state: 'open';
        per_page: number;
        page: number;
      }) => Promise<{
        data: Array<{ number: number; head: { sha: string } }>;
      }>;
      /**
       * Submit a review. Only ever called with `event: 'APPROVE'` here — see
       * `approvals.ts`, which is the sole caller.
       */
      createReview: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        event: 'APPROVE';
        body?: string;
      }) => Promise<{ data: { id: number; state?: string } }>;
      /** Reviews already on a PR, used to skip one this App has approved. */
      listReviews: (params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }) => Promise<{ data: PullRequestReview[] }>;
    };
    issues: {
      listLabelsOnIssue: (params: {
        owner: string;
        repo: string;
        issue_number: number;
      }) => Promise<{ data: Array<{ name: string }> }>;
      /**
       * Labels are sticky: `cloudy-redeploy` stays on the PR after it fires, so
       * re-applying it produces no `labeled` event. Removing it is what makes
       * the label a repeatable button rather than a one-shot.
       */
      removeLabel: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        name: string;
      }) => Promise<unknown>;
      createComment: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }) => Promise<{ data: IssueComment }>;
      updateComment: (params: {
        owner: string;
        repo: string;
        comment_id: number;
        body: string;
      }) => Promise<unknown>;
      listComments: (params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
      }) => Promise<{ data: IssueComment[] }>;
    };
  };
}

export interface RepoRef {
  owner: string;
  name: string;
}

export interface ClearedPstackChecks {
  pullRequests: number[];
  checkRuns: number;
}

/**
 * Complete pstack checks as skipped for one PR, or for every open PR.
 *
 * GitHub exposes no delete operation for check runs or suites. `skipped` is the
 * closest useful equivalent to clearing: it removes a stale pending/failing
 * verdict without pretending the preview succeeded.
 */
export async function clearPstackChecks(
  octokit: AppOctokit,
  repo: RepoRef,
  target: { prNumber: number; headSha?: string } | { all: true },
): Promise<ClearedPstackChecks> {
  const pullRequests =
    'prNumber' in target
      ? [
          {
            number: target.prNumber,
            head: target.headSha
              ? { sha: target.headSha }
              : (
                  await octokit.rest.pulls.get({
                    owner: repo.owner,
                    repo: repo.name,
                    pull_number: target.prNumber,
                  })
                ).data.head,
          },
        ]
      : await listOpenPullRequests(octokit, repo);

  let checkRuns = 0;
  for (const pull of pullRequests) {
    checkRuns += await clearPstackChecksForRef(octokit, repo, pull.head.sha);
  }

  return {
    pullRequests: pullRequests.map((pull) => pull.number),
    checkRuns,
  };
}

async function listOpenPullRequests(
  octokit: AppOctokit,
  repo: RepoRef,
): Promise<Array<{ number: number; head: { sha: string } }>> {
  const pulls: Array<{ number: number; head: { sha: string } }> = [];
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
      per_page: 100,
      page,
    });
    pulls.push(...data);
    if (data.length < 100) return pulls;
  }
}

async function clearPstackChecksForRef(
  octokit: AppOctokit,
  repo: RepoRef,
  ref: string,
): Promise<number> {
  let cleared = 0;
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.checks.listForRef({
      owner: repo.owner,
      repo: repo.name,
      ref,
      filter: 'all',
      per_page: 100,
      page,
    });
    const pstackChecks = data.check_runs.filter((check) =>
      check.name?.startsWith('pstack/'),
    );
    await Promise.all(
      pstackChecks.map((check) =>
        octokit.rest.checks.update({
          owner: repo.owner,
          repo: repo.name,
          check_run_id: check.id,
          status: 'completed',
          conclusion: 'skipped',
          completed_at: new Date().toISOString(),
          output: {
            title: 'pstack check cleared',
            summary: 'Cleared by the pstack checks webhook.',
          },
        }),
      ),
    );
    cleared += pstackChecks.length;
    if (data.check_runs.length < 100) return cleared;
  }
}

/**
 * Create-or-update a check run by name on a commit. GitHub has no upsert, so
 * the existing run is looked up by `check_name` on the ref first — that is what
 * makes the 30s poll edit one check instead of stacking a new one per tick.
 * Returns the check run id so a caller can keep updating without re-listing.
 */
export async function upsertCheckRun(
  octokit: AppOctokit,
  repo: RepoRef,
  params: {
    name: string;
    headSha: string;
    status: CheckStatus;
    conclusion?: CheckConclusion;
    detailsUrl?: string;
    title: string;
    summary: string;
    /** Skip the lookup when the caller already knows the id. */
    checkRunId?: number;
  },
): Promise<number> {
  const existingId =
    params.checkRunId ??
    (await findCheckRun(octokit, repo, params.headSha, params.name));

  const output = { title: params.title, summary: params.summary };
  const completedAt =
    params.status === 'completed' ? new Date().toISOString() : undefined;

  if (existingId !== undefined) {
    await octokit.rest.checks.update({
      owner: repo.owner,
      repo: repo.name,
      check_run_id: existingId,
      status: params.status,
      conclusion: params.conclusion,
      details_url: params.detailsUrl,
      completed_at: completedAt,
      output,
    });
    return existingId;
  }

  const created = await octokit.rest.checks.create({
    owner: repo.owner,
    repo: repo.name,
    name: params.name,
    head_sha: params.headSha,
    status: params.status,
    conclusion: params.conclusion,
    details_url: params.detailsUrl,
    started_at: new Date().toISOString(),
    completed_at: completedAt,
    output,
  });
  return created.data.id;
}

async function findCheckRun(
  octokit: AppOctokit,
  repo: RepoRef,
  ref: string,
  name: string,
): Promise<number | undefined> {
  try {
    const { data } = await octokit.rest.checks.listForRef({
      owner: repo.owner,
      repo: repo.name,
      ref,
      check_name: name,
    });
    return data.check_runs[0]?.id;
  } catch {
    // A missing/forbidden listing must not stop us from creating the run.
    return undefined;
  }
}

/**
 * Create-or-update the service's single comment on a PR, identified by an
 * invisible HTML marker appended to the body. Without the marker every poll
 * would append a new comment; with it the same comment is edited in place.
 */
export async function upsertComment(
  octokit: AppOctokit,
  repo: RepoRef,
  issueNumber: number,
  marker: string,
  body: string,
  knownCommentId?: number,
): Promise<number> {
  const full = `${body}\n\n<!-- ${marker} -->`;
  const commentId =
    knownCommentId ?? (await findComment(octokit, repo, issueNumber, marker));

  if (commentId !== undefined) {
    await octokit.rest.issues.updateComment({
      owner: repo.owner,
      repo: repo.name,
      comment_id: commentId,
      body: full,
    });
    return commentId;
  }

  const created = await octokit.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    body: full,
  });
  return created.data.id;
}

async function findComment(
  octokit: AppOctokit,
  repo: RepoRef,
  issueNumber: number,
  marker: string,
): Promise<number | undefined> {
  try {
    const { data } = await octokit.rest.issues.listComments({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issueNumber,
      per_page: 100,
    });
    return data.find((comment) => comment.body?.includes(marker))?.id;
  } catch {
    return undefined;
  }
}

/**
 * Post a marked comment **only if the PR does not already carry one**, and
 * never edit it afterwards.
 *
 * This is the shape the help comment needs, and it differs from
 * {@link upsertComment} in the case that matters: an existing help comment is
 * left exactly as it is. Editing it on every deploy would push a PR
 * notification for text that never changes, and the point of a separate
 * comment is that it is written once and then stays out of the way.
 *
 * Returns the comment id when one was created, `undefined` when one already
 * existed. The listing is best-effort — see {@link findComment} — so a failed
 * lookup falls through to creating one, which is the harmless direction: the
 * caller only asks once per PR per process.
 */
export async function ensureComment(
  octokit: AppOctokit,
  repo: RepoRef,
  issueNumber: number,
  marker: string,
  body: string,
): Promise<number | undefined> {
  const existing = await findComment(octokit, repo, issueNumber, marker);
  if (existing !== undefined) return undefined;
  const created = await octokit.rest.issues.createComment({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issueNumber,
    body: `${body}\n\n<!-- ${marker} -->`,
  });
  return created.data.id;
}
