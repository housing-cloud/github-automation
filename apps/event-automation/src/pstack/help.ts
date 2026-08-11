/**
 * The bot's usage comment: what it posts on a PR, once, alongside the checks.
 *
 * Kept separate from the deployment-status comment on purpose. That one is
 * rewritten on every pstack event, so anything durable written into it would be
 * overwritten by the next delivery; this one is written once and never edited,
 * so it stays a stable reference a reviewer can scroll back to.
 */

/** The commands the bot answers to, and what each one does. */
export interface BotCommand {
  /** The verb, as typed after the mention. */
  name: 'recheck' | 'redeploy' | 'restart';
  /** Comment trigger, e.g. `@cloudybot recheck`. */
  comment: string;
  /** Label trigger, e.g. `cloudy-recheck`. */
  label: string;
  /** One line describing the effect. */
  description: string;
}

export const BOT_MENTION = '@cloudybot';

/**
 * The three commands, in escalating order of disruption: `recheck` touches
 * nothing, `restart` bounces the containers, `redeploy` re-runs the deploy.
 * Listed this way so the cheapest fix is read first.
 */
export const BOT_COMMANDS: readonly BotCommand[] = [
  {
    name: 'recheck',
    comment: `${BOT_MENTION} recheck`,
    label: 'cloudy-recheck',
    description:
      'Re-read the stack’s current state from pstack and update the checks. Deploys nothing.',
  },
  {
    name: 'restart',
    comment: `${BOT_MENTION} restart`,
    label: 'cloudy-restart',
    description:
      'Restart the stack’s containers, then wait for readiness and update the checks.',
  },
  {
    name: 'redeploy',
    comment: `${BOT_MENTION} redeploy`,
    label: 'cloudy-redeploy',
    description:
      'Re-run the pstack deploy (`up`) for this PR, then wait for readiness and update the checks.',
  },
];

export interface HelpCommentOptions {
  /** Watched compose services, each of which gets its own check run. */
  services: readonly string[];
  /** Whether the control-plane API is configured — see `PSTACK_API_URL`. */
  commandsEnabled: boolean;
  /** pstack dashboard URL, linked for operators. */
  pstackBaseUrl?: string;
}

/** Render the help comment body. */
export function helpComment(options: HelpCommentOptions): string {
  const checks = ['pstack/stack', ...options.services.map((s) => `pstack/${s}`)]
    .map((name) => `\`${name}\``)
    .join(', ');

  const lines = [
    '### 🤖 Preview stack bot',
    '',
    `This PR gets a preview stack. Its progress shows up as the ${checks} checks,`,
    'and a separate **Preview stack** comment carries the live status and the',
    'preview URLs. That comment is rewritten as the deployment progresses; this',
    'one is posted once and never changes.',
    '',
  ];

  if (options.commandsEnabled) {
    lines.push(
      '#### Commands',
      '',
      'Comment the command, or add the label — they do the same thing. A label is',
      'removed once it has been handled, so it can be re-applied to run again.',
      '',
      '| Comment | Label | What it does |',
      '| --- | --- | --- |',
      ...BOT_COMMANDS.map(
        (command) =>
          `| \`${command.comment}\` | \`${command.label}\` | ${command.description} |`,
      ),
      '',
      'Each command replies on the checks: they reopen as in progress and settle',
      'once the stack does. Only one runs per stack at a time.',
      '',
    );
  } else {
    lines.push(
      '#### Commands',
      '',
      'Command handling is not configured on this deployment, so `@cloudybot`',
      'mentions and `cloudy-*` labels are ignored here.',
      '',
    );
  }

  lines.push(
    '#### What the checks mean',
    '',
    '| Check | Passes when |',
    '| --- | --- |',
    '| `pstack/stack` | every container in the stack reached ready |',
    ...options.services.map(
      (service) =>
        `| \`pstack/${service}\` | the \`${service}\` container reached ready (for a one-shot container, exited 0) |`,
    ),
    '',
    'A green deploy job is not a running app: `compose up -d` returns once the',
    'containers are *created*, so the checks stay pending until the readiness',
    'watch reports a verdict.',
  );

  if (options.pstackBaseUrl) {
    lines.push('', `Operators: [pstack dashboard](${options.pstackBaseUrl}).`);
  }

  return lines.join('\n');
}
