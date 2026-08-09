import type {
  AutomationContext,
  HandlerSpec,
  Rule,
} from '@samyx/github-automation-suite';
import { withHandlerDescription } from '@samyx/github-automation-suite';
import { buildDokployRule, dokployFailed } from '@samyx/gha-plugin-dokploy';
import { buildGithubRule } from '@samyx/github-automation-suite/plugins/github';
import type { AppEnv } from './env';
import type { PreviewTracker, TrackerTarget } from './preview/tracker';

export interface CreateRulesOptions {
  env: AppEnv;
  tracker: PreviewTracker;
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
