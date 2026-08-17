/**
 * The bulk-approval webhook's request body.
 *
 * Kept apart from the route so the parsing is testable without HTTP, and from
 * `approvals.ts` so the GitHub calls do not depend on the wire format.
 *
 * Two shapes, exactly one at a time:
 *
 *   { "prs": [1, 2, 3] }   approve these pull requests
 *   { "stack": 42 }        approve every open PR in this gh-stack
 *
 * Requiring exactly one is deliberate. A body carrying both would have an
 * ambiguous intent, and guessing at intent is not a good property in something
 * that approves code.
 */

/** A validated request. */
export type ApprovalRequest =
  | { kind: 'prs'; prs: number[]; body?: string; drafts: boolean }
  | { kind: 'stack'; stack: number; body?: string; drafts: boolean };

export interface ParseFailure {
  error: string;
}

/** How many PRs one call may approve. */
export const MAX_PRS_PER_REQUEST = 50;

export function parseApprovalRequest(
  input: unknown,
): ApprovalRequest | ParseFailure {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'body must be a JSON object' };
  }
  const value = input as Record<string, unknown>;

  const hasPrs = 'prs' in value;
  const hasStack = 'stack' in value;
  if (hasPrs === hasStack) {
    return {
      error: 'body must carry exactly one of "prs" (array) or "stack" (number)',
    };
  }

  const body = typeof value.body === 'string' ? value.body.trim() : undefined;
  if (body !== undefined && body.length > 65_536) {
    return { error: '"body" is too long' };
  }
  const drafts = value.drafts === true;

  if (hasStack) {
    const stack = value.stack;
    if (!isPositiveInteger(stack)) {
      return { error: '"stack" must be a positive integer' };
    }
    return { kind: 'stack', stack, body, drafts };
  }

  const prs = value.prs;
  if (!Array.isArray(prs) || prs.length === 0) {
    return { error: '"prs" must be a non-empty array of pull request numbers' };
  }
  // Bounded because one call fans out to one GitHub write per entry, and a
  // runaway list would burn the installation's rate limit on a single request.
  if (prs.length > MAX_PRS_PER_REQUEST) {
    return {
      error: `"prs" may name at most ${MAX_PRS_PER_REQUEST} pull requests`,
    };
  }
  if (!prs.every(isPositiveInteger)) {
    return { error: '"prs" must contain only positive integers' };
  }
  return { kind: 'prs', prs: [...new Set(prs)], body, drafts };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
