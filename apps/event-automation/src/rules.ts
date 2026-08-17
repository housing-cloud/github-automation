import type { HandlerSpec, Rule } from '@samyx/github-automation-suite';
import { withHandlerDescription } from '@samyx/github-automation-suite';
import {
  buildPreviewStacksRule,
  type PreviewStacksEventData,
} from '@samyx/gha-plugin-preview-stacks';
import { buildGithubRule } from '@samyx/github-automation-suite/plugins/github';
import type { AppEnv } from './env';
import { type AppOctokit, ensureComment } from './github/checks';
import { PR_OPENED_COMMENT_MARKER, prOpenedComment } from './github/pr-opened';
import type { PstackCommands } from './pstack/commands';
import { parseCommentCommand, parseLabelCommand } from './pstack/commands';
import type { PstackReporter, PstackSignal } from './pstack/reporter';

export interface CreateRulesOptions {
  env: AppEnv;
  pstack: PstackReporter;
  /** Present only when the pstack control-plane API is configured. */
  commands?: PstackCommands;
  /** Used by the PR-opened explainer. Absent in the pstack-only tests. */
  octokit?: AppOctokit;
}

/**
 * HOU automation rules.
 *
 * The contract: **a preview stack named `pr-<number>` gets three GitHub check
 * runs on that PR — the stack as a whole, plus one per watched compose service
 * — and a single PR comment carrying the status and details.**
 *
 * pstack owns the deploy; this service never triggers one, it only *reports*.
 * The reporting is push-driven: pstack signs and delivers an event for every
 * lifecycle transition, so there is nothing to poll.
 */
export function createRules(options: CreateRulesOptions): Rule[] {
  return [
    /**
     * The four reporting behaviours, all served by one rule.
     *
     * The three checks (`pstack/stack`, `pstack/<service>`) and the PR comment
     * are different *views* of one per-stack state machine, and a single pstack
     * event can move several of them at once — a `stack.timedout` both fails the
     * stack check and, via `pendingContainers`, fails the `web` check. Splitting
     * that across four rules would mean four rules racing to update the same
     * check runs and the same comment, so the events are fed to one reporter
     * that owns the state and serializes the GitHub writes.
     *
     * Test-button deliveries reuse the `job.succeeded` name;
     * `buildPreviewStacksRule` excludes them by default, which is kept.
     */
    buildPreviewStacksRule({
      name: 'pstack-preview-checks',
      events: [
        // Deploy lifecycle -> the stack check.
        'job.started',
        // Commands completed; the check stays pending until stack.ready.
        'job.succeeded',
        'job.failed',
        'job.leaked',
        'job.cancelled',
        // Readiness verdicts -> the stack check + any unsettled service check.
        'stack.ready',
        'stack.failed',
        'stack.timedout',
        // Per-container verdicts -> the per-service checks.
        'container.ready',
        'container.start-failed',
        // Cancels the readiness watch, so no stack.* verdict will follow.
        'container.stopped',
      ],
      handlers: [
        withHandlerDescription(
          pstackHandler(options),
          'mirror the preview stack + its watched containers onto GitHub check runs and a tracked PR comment',
        ),
      ],
    }),

    /**
     * Release a stack's in-memory state when its PR closes.
     *
     * The service is a long-running container, so without this the reporter
     * would accumulate one entry per PR it ever saw. The checks and the comment
     * already live on GitHub, so nothing is lost by forgetting.
     */
    buildGithubRule({
      name: 'pstack-forget-closed-pr',
      events: ['pull_request.closed'],
      handlers: [
        withHandlerDescription(
          forgetClosedPrHandler(options),
          'drop the closed PR’s preview-stack state from memory',
        ),
      ],
    }),

    ...commandRules(options),
    ...prOpenedRules(options),
  ];
}

/**
 * The preview-labels explainer on a newly opened PR.
 *
 * Off unless `PR_OPENED_COMMENT` is set, because it writes to *every* opened PR
 * in the allowed repos, including ones that will never get a preview stack.
 * That is a per-deployment decision, not a default.
 */
function prOpenedRules(options: CreateRulesOptions): Rule[] {
  const { env, octokit } = options;
  if (!env.prOpenedComment || !octokit) return [];

  return [
    buildGithubRule({
      name: 'pr-opened-preview-labels',
      // `reopened` is deliberately excluded: the PR already has the comment
      // from the first time, and `ensureComment` would only re-confirm that.
      events: ['pull_request.opened'],
      handlers: [
        withHandlerDescription(
          prOpenedCommentHandler(options),
          'explain the preview labels on a newly opened PR',
        ),
      ],
    }),
  ];
}

/**
 * Post the explainer once.
 *
 * The comment goes on the PR's **own** repo rather than `PSTACK_REPO`: this is
 * a reply to the PR that was just opened, and the engine has already limited
 * that to `GITHUB_ALLOWED_REPOS`.
 */
function prOpenedCommentHandler(options: CreateRulesOptions): HandlerSpec {
  const { env, octokit } = options;
  return {
    critical: false,
    run: async (ctx) => {
      const prNumber = ctx.event.data.prNumber;
      const repo = ctx.event.data.repo;
      if (prNumber === undefined || !repo || !octokit) return;

      // `ensureComment` re-checks GitHub, so a redelivered `opened` — or a
      // restart mid-delivery — cannot produce a second copy.
      const created = await ensureComment(
        octokit,
        repo,
        prNumber,
        PR_OPENED_COMMENT_MARKER,
        prOpenedComment({ pstackBaseUrl: env.pstackBaseUrl }),
      );
      ctx.logger.info(
        { pr: prNumber, repo: repo.name, created: created !== undefined },
        'pr: posted the preview-labels explainer',
      );
    },
  };
}

/**
 * The `@cloudybot` command rules — one for comments, one for labels.
 *
 * Registered only when the control-plane API is configured: a rule that
 * acknowledges `@cloudybot redeploy` and then cannot redeploy anything is worse
 * than no rule, and the dashboard's rule list would advertise it.
 *
 * Two rules rather than one because the trigger events carry the command in
 * different places (a comment body vs. a label name), and keeping them apart
 * means the dashboard shows which trigger fired.
 */
function commandRules(options: CreateRulesOptions): Rule[] {
  const { commands } = options;
  if (!commands) return [];

  return [
    buildGithubRule({
      name: 'cloudybot-command-comment',
      // `issue_comment` covers PR comments: GitHub delivers a PR's conversation
      // comments as issue comments, and a PR is an issue in that number space.
      // `.edited` is included so fixing a typo in the command runs it.
      events: ['issue_comment.created', 'issue_comment.edited'],
      handlers: [
        withHandlerDescription(
          commentCommandHandler(commands),
          'run the @cloudybot recheck/redeploy/restart command in a PR comment',
        ),
      ],
    }),

    buildGithubRule({
      name: 'cloudybot-command-label',
      events: ['pull_request.labeled'],
      handlers: [
        withHandlerDescription(
          labelCommandHandler(commands),
          'run the cloudy-recheck/redeploy/restart command applied as a label',
        ),
      ],
    }),
  ];
}

/**
 * A command in a PR comment.
 *
 * Two guards worth naming. **Issues are excluded**: `issue_comment` fires for
 * both, and only a PR has a preview stack. And **the bot's own comments are
 * ignored** — the help comment lists `@cloudybot redeploy` in a table, so a
 * service that read its own comments would redeploy every stack it ever
 * documented.
 */
function commentCommandHandler(commands: PstackCommands): HandlerSpec {
  return {
    critical: false,
    run: async (ctx) => {
      const payload = ctx.event.raw as {
        issue?: { number?: number; pull_request?: unknown };
        comment?: { body?: string; user?: { login?: string; type?: string } };
      };
      if (!payload.issue?.pull_request) return;
      if (payload.comment?.user?.type === 'Bot') return;

      const prNumber = ctx.event.data.prNumber ?? payload.issue.number;
      const command = parseCommentCommand(payload.comment?.body ?? '');
      if (prNumber === undefined || !command) return;

      ctx.logger.info(
        { pr: prNumber, command, by: payload.comment?.user?.login },
        'pstack: accepted a @cloudybot comment command',
      );
      commands.accept({
        command,
        prNumber,
        actor: payload.comment?.user?.login,
      });
    },
  };
}

/** A command applied as a `cloudy-*` label. */
function labelCommandHandler(commands: PstackCommands): HandlerSpec {
  return {
    critical: false,
    run: async (ctx) => {
      const payload = ctx.event.raw as {
        label?: { name?: string };
        sender?: { login?: string };
      };
      const prNumber = ctx.event.data.prNumber;
      const label = payload.label?.name;
      const command = label ? parseLabelCommand(label) : undefined;
      if (prNumber === undefined || !command || !label) return;

      ctx.logger.info(
        { pr: prNumber, command, label, by: payload.sender?.login },
        'pstack: accepted a cloudy-* label command',
      );
      commands.accept({
        command,
        prNumber,
        label,
        actor: payload.sender?.login,
      });
    },
  };
}

/**
 * Feed one pstack event to the reporter.
 *
 * Awaited rather than fired-and-forgotten: this is a single bounded set of
 * GitHub calls, and awaiting keeps the deliveries for one stack ordered under
 * the engine's per-delivery handling.
 */
function pstackHandler(options: CreateRulesOptions): HandlerSpec {
  const { pstack } = options;
  return {
    critical: false,
    run: async (ctx) => {
      await pstack.handle(pstackSignalFrom(ctx.event.data, ctx.event.type));
    },
  };
}

/** Forget every stack this service tracked for the PR that just closed. */
function forgetClosedPrHandler(options: CreateRulesOptions): HandlerSpec {
  const { pstack } = options;
  return {
    critical: false,
    run: async (ctx) => {
      const prNumber = ctx.event.data.prNumber;
      if (prNumber === undefined) return;
      const dropped = pstack.forgetPr(prNumber);
      if (dropped.length > 0) {
        ctx.logger.debug(
          { prNumber, stacks: dropped },
          'pstack: released state for a closed PR',
        );
      }
    },
  };
}

/** Project the plugin's flattened pstack fields onto the reporter's input. */
function pstackSignalFrom(
  data: PreviewStacksEventData,
  type: string,
): PstackSignal {
  return {
    type,
    stack: data.pstackStack,
    container: data.pstackContainer,
    service: data.pstackService,
    state: data.pstackState,
    action: data.pstackAction,
    error: data.pstackError,
    reason: data.pstackReason,
    exitCode: data.pstackExitCode,
    health: data.pstackHealth,
    hasHealthcheck: data.pstackHasHealthcheck,
    healthy: data.pstackHealthy,
    containers: data.pstackContainers,
    readyCount: data.pstackReadyCount,
    failedContainers: data.pstackFailedContainers,
    pendingContainers: data.pstackPendingContainers,
    reachable: data.pstackReachable,
    durationMs: data.pstackDurationMs,
    waitedMs: data.pstackWaitedMs,
    by: data.pstackBy,
  };
}
