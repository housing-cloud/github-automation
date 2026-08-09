/**
 * The GitHub REST calls this service needs beyond the suite's `OctokitLike`.
 *
 * The suite's GitHub plugin only *creates completed* check runs, which is
 * enough to mirror a finished deploy but not to track one: a queued preview has
 * to show up immediately as `in_progress` and then be *updated* in place, and
 * the PR comment has to be edited rather than re-posted every 30s. Both need
 * endpoints outside `OctokitLike`, so this widened interface is what the
 * tracker asks the service registry for.
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
}

export interface IssueComment {
  id: number;
  body?: string | null | undefined;
}

/**
 * The slice of Octokit this service depends on.
 *
 * A strict superset of the suite's `OctokitLike`, so one client satisfies both
 * the GitHub plugin's handlers and the tracker's upserts.
 */
export interface TrackerOctokit {
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
    issues: {
      listLabelsOnIssue: (params: {
        owner: string;
        repo: string;
        issue_number: number;
      }) => Promise<{ data: Array<{ name: string }> }>;
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

/**
 * Create-or-update a check run by name on a commit. GitHub has no upsert, so
 * the existing run is looked up by `check_name` on the ref first — that is what
 * makes the 30s poll edit one check instead of stacking a new one per tick.
 * Returns the check run id so a caller can keep updating without re-listing.
 */
export async function upsertCheckRun(
  octokit: TrackerOctokit,
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
  octokit: TrackerOctokit,
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
  octokit: TrackerOctokit,
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
  octokit: TrackerOctokit,
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
