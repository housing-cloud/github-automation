import type { HandlerSpec, Rule } from '@samyx/github-automation-suite';
import { withHandlerDescription } from '@samyx/github-automation-suite';
import {
  buildPreviewStacksRule,
  type PreviewStacksEventData,
} from '@samyx/gha-plugin-preview-stacks';
import { buildGithubRule } from '@samyx/github-automation-suite/plugins/github';
import type { AppEnv } from './env';
import type { PstackReporter, PstackSignal } from './pstack/reporter';

export interface CreateRulesOptions {
  env: AppEnv;
  pstack: PstackReporter;
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
  ];
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
