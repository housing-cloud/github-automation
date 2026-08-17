/**
 * The preview-labels explainer, posted on a newly opened PR.
 *
 * Three labels control whether a PR gets a preview stack and what happens to it
 * when the PR closes. They are enforced by the pstack side, not by this service
 * — this comment is documentation, and says so, because a reviewer who reads
 * "add `preview`" here and sees nothing happen should know where to look.
 *
 * Separate from the `@cloudybot` help comment on purpose. That one is posted
 * when a stack's checks first open and describes the checks and commands; this
 * one is posted when the PR opens, before any stack exists, and describes how to
 * get (or avoid) one. A PR with previews disabled gets this and never the other.
 */

/** A preview label, and what it does while it is on the PR. */
export interface PreviewLabel {
  name: string;
  /** Short effect, for the table. */
  effect: string;
  /** The longer note under the table, when there is more to say. */
  note?: string;
}

export const PREVIEW_LABELS: readonly PreviewLabel[] = [
  {
    name: 'preview',
    effect: 'Run a preview stack for this PR.',
    note:
      'Transitional: previews are opt-in for now, and will become the default ' +
      'for every PR later. When that happens this label stops being needed.',
  },
  {
    name: 'no-preview',
    effect: 'Do not run a preview for this PR while this label is present.',
    note:
      'Wins over `preview`, and is the one to reach for once previews become ' +
      'the default. Removing it lets the next push deploy normally.',
  },
  {
    name: 'preserve-preview',
    effect: 'Keep the preview running after the PR is closed.',
    note:
      'A closed PR normally has its stack torn down. Use this to hold one open ' +
      'for debugging, and remember to remove it — a preserved stack keeps ' +
      'consuming resources until someone takes it down.',
  },
];

export const PR_OPENED_COMMENT_MARKER = 'hou-event-automation:preview-labels';

export interface PrOpenedCommentOptions {
  /** pstack dashboard URL, linked for anyone wanting the stack itself. */
  pstackBaseUrl?: string;
}

/** Render the explainer body. */
export function prOpenedComment(options: PrOpenedCommentOptions = {}): string {
  const lines = [
    '### 🏗️ Preview stacks on this PR',
    '',
    'Whether this PR gets its own preview deployment is controlled by labels:',
    '',
    '| Label | Effect |',
    '| --- | --- |',
    ...PREVIEW_LABELS.map((label) => `| \`${label.name}\` | ${label.effect} |`),
    '',
    ...PREVIEW_LABELS.filter((label) => label.note).map(
      (label) => `- **\`${label.name}\`** — ${label.note}`,
    ),
    '',
    'Labels take effect from the next deployment for this PR, so add or remove',
    'one before pushing. Once a stack exists, its progress appears as',
    '`pstack/*` checks and a **Preview stack** comment.',
  ];

  if (options.pstackBaseUrl) {
    lines.push('', `Operators: [pstack dashboard](${options.pstackBaseUrl}).`);
  }

  return lines.join('\n');
}
