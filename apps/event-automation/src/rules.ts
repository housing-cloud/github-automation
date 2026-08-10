import type {
  AutomationContext,
  HandlerSpec,
  Rule,
} from '@samyx/github-automation-suite';
import { withHandlerDescription } from '@samyx/github-automation-suite';
import { buildDokployRule, dokployFailed } from '@samyx/gha-plugin-dokploy';
import {
  buildPreviewStacksRule,
  type PreviewStacksEventData,
} from '@samyx/gha-plugin-preview-stacks';
import { buildGithubRule } from '@samyx/github-automation-suite/plugins/github';
import type { AppEnv } from './env';
import type { PreviewTracker, TrackerTarget } from './preview/tracker';
import type { PstackReporter, PstackSignal } from './pstack/reporter';

export interface CreateRulesOptions {
  env: AppEnv;
  tracker: PreviewTracker;
  pstack: PstackReporter;
}

/**
 * HOU automation rules.
 *
 * The contract is simple: **a pull request against a repo that has a Dokploy
 * application gets a check run tracking its preview deployment, plus one PR
 * comment carrying the preview URL and the deployment details.**
 *
 * Dokploy's own GitHub receiver creates and queues the preview; this service
 * never triggers the deploy, it only *reports* it. Because Dokploy's webhooks
 * carry no PR identity (see `preview/tracker.ts`), the reporting is done by a
 * poller the PR events start — a `pull_request` webhook is the trigger, the
 * Dokploy REST API is the source of truth.
 */
export function createRules(options: CreateRulesOptions): Rule[] {
  const { env } = options;

  const rules: Rule[] = [
    buildGithubRule({
      name: 'dokploy-preview-track',
      // The same actions Dokploy's own receiver acts on (`pages/api/deploy/
      // github.ts`): each of these queues or re-queues a preview deployment.
      events: [
        'pull_request.opened',
        'pull_request.reopened',
        'pull_request.synchronize',
      ],
      handlers: [
        withHandlerDescription(
          trackPreviewHandler(options),
          'track the PR’s Dokploy preview deployment on a GitHub check run + PR comment',
        ),
      ],
    }),

    /**
     * Requirements 1–4, all served by one rule.
     *
     * The three checks (`pstack/stack`, `pstack/db-seed`, `pstack/web`) and the
     * PR comment are different *views* of one per-stack state machine, and a
     * single pstack event can move several of them at once — a `stack.timedout`
     * both fails the stack check and, via `pendingContainers`, fails the `web`
     * check. Splitting that across four rules would mean four rules racing to
     * update the same check runs and the same comment, so the events are fed to
     * one reporter that owns the state and serializes the GitHub writes.
     *
     * Test-button deliveries reuse the `job.succeeded` name;
     * `buildPreviewStacksRule` excludes them by default, which is kept.
     */
    buildPreviewStacksRule({
      name: 'pstack-preview-checks',
      events: [
        // Deploy lifecycle -> the stack check.
        'job.started',
        'job.failed',
        'job.leaked',
        'job.cancelled',
        // Readiness verdicts -> the stack check + any unsettled service check.
        'stack.ready',
        'stack.failed',
        'stack.timedout',
        // Per-container verdicts -> the db-seed and web checks.
        'container.ready',
        'container.start-failed',
        // Cancels the readiness watch, so no stack.* verdict will follow.
        'container.stopped',
      ],
      handlers: [
        withHandlerDescription(
          pstackHandler(options),
          'mirror the preview stack + its db-seed/web containers onto GitHub check runs and a tracked PR comment',
        ),
      ],
    }),
  ];

  // A Dokploy build failure that maps to a repo is worth shouting about even
  // though it carries no PR — the tracker already covers the per-PR path.
  if (env.slackWebhookUrl) {
    rules.push(
      buildDokployRule({
        name: 'dokploy-failure-slack',
        when: dokployFailed(),
        handlers: [
          {
            use: 'http.post',
            critical: false,
            with: {
              url: env.slackWebhookUrl,
              body: (ctx: AutomationContext) => ({
                text: `Dokploy failure: ${
                  ctx.event.data.dokployProject ?? 'unknown'
                }/${ctx.event.data.dokployApplication ?? 'unknown'} — ${
                  ctx.event.data.dokployErrorMessage ?? 'no message'
                }`,
              }),
            },
          } as HandlerSpec,
        ],
      }),
    );
  }

  return rules;
}

/**
 * Start (or restart) the polling tracker for the PR this event concerns.
 *
 * Returns as soon as the loop is running: the loop lives for minutes, and the
 * webhook response must not wait for it. Its first action posts the queued
 * check + comment, so by the time GitHub retries anything the PR already shows
 * the deployment.
 */
function trackPreviewHandler(options: CreateRulesOptions): HandlerSpec {
  const { env, tracker } = options;
  return {
    critical: false,
    run: async (ctx) => {
      const target = trackerTargetFor(env, ctx.event.data);
      if (!target) {
        ctx.logger.debug(
          { repo: ctx.event.data.repo?.name },
          'no dokploy application mapped for this repo — skipping',
        );
        return;
      }
      ctx.logger.info(
        { repo: target.repo.name, pr: target.prNumber, sha: target.headSha },
        'tracking dokploy preview deployment',
      );
      // Fire-and-forget: the loop outlives the request by design.
      void tracker.track(target);
    },
  };
}

/**
 * Feed one pstack event to the reporter.
 *
 * Awaited rather than fired-and-forgotten: unlike the Dokploy tracker (which
 * owns a minutes-long poll loop), this is a single bounded set of GitHub calls,
 * and awaiting keeps the deliveries for one stack ordered under the engine's
 * per-delivery handling.
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

/** Project the plugin's flattened pstack fields onto the reporter's input. */
export function pstackSignalFrom(
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

/** Project a normalized PR event onto a tracker target, or `undefined`. */
export function trackerTargetFor(
  env: AppEnv,
  data: {
    repo?: { owner: string; name: string };
    prNumber?: number;
    sha?: string;
  },
): TrackerTarget | undefined {
  const { repo, prNumber, sha } = data;
  if (!repo || prNumber === undefined || !sha) return undefined;
  const application = env.repoApplications.get(repo.name);
  if (!application) return undefined;
  return {
    repo,
    prNumber,
    headSha: sha,
    applicationId: application.applicationId,
    applicationName: application.name,
  };
}
