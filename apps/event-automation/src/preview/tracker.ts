/**
 * The preview-deployment tracker: the poller that turns a Dokploy preview
 * build into a live GitHub check run + PR comment.
 *
 * **Why polling.** Dokploy's own GitHub webhook receiver
 * (`/api/deploy/github`) creates a preview deployment when a PR is opened,
 * synchronized, reopened or labeled, and queues it. But its *notification*
 * channel only fires the org-wide `build.success` / `build.error` events, which
 * name a project + application and never a pull request — so a webhook can tell
 * you *something* finished, not *which PR's preview* did. The authoritative
 * per-PR status lives in `previewDeployment.all`, so this tracker reads it back
 * on an interval (default 30s) until the preview settles.
 *
 * One tracker run per (repo, PR, head SHA). Re-tracking the same key (e.g. the
 * webhook is redelivered) replaces the old loop rather than racing it.
 */

import type { Logger } from '@samyx/github-automation-suite';
import {
  type DokployClient,
  type DokployPreviewDeployment,
  type DokployStatus,
  previewUrl,
} from '../dokploy/client';
import {
  type CheckConclusion,
  type CheckStatus,
  type RepoRef,
  type TrackerOctokit,
  upsertCheckRun,
  upsertComment,
} from '../github/checks';

/** Marker that identifies this service's PR comment, so it is edited in place. */
export const COMMENT_MARKER = 'hou-event-automation:dokploy-preview';

export interface TrackerTarget {
  repo: RepoRef;
  prNumber: number;
  headSha: string;
  /** Dokploy application whose preview deployments cover this PR. */
  applicationId: string;
  /** Name shown for the application in the check + comment. */
  applicationName: string;
}

export interface PreviewTrackerOptions {
  dokploy: DokployClient;
  octokit: TrackerOctokit;
  /** Dokploy base URL, for the details link on the check run. */
  dokployBaseUrl: string;
  logger: Logger;
  /** How often to re-read the preview status. Defaults to 30s. */
  pollIntervalMs?: number;
  /** Give up (and fail the check) after this long. Defaults to 30m. */
  timeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

interface TrackerRun {
  cancelled: boolean;
  done: Promise<void>;
}

/**
 * Runs and de-duplicates the per-PR polling loops. Long-lived: the service is
 * a always-on container, so an in-process loop is the right shape — nothing is
 * durable across a restart, which the check run's `in_progress` state makes
 * visible (a restarted service simply re-tracks on the next webhook).
 */
export class PreviewTracker {
  private readonly runs = new Map<string, TrackerRun>();
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PreviewTrackerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Live tracker keys — surfaced by `/previews` for observability. */
  get active(): string[] {
    return [...this.runs.keys()];
  }

  /**
   * Start tracking a PR's preview. Idempotent per (repo, PR, sha): a duplicate
   * call cancels the in-flight loop and starts a fresh one, so a redelivered
   * webhook never leaves two loops fighting over one check run.
   */
  track(target: TrackerTarget): Promise<void> {
    const key = trackerKey(target);
    const previous = this.runs.get(key);
    if (previous) previous.cancelled = true;

    const run: TrackerRun = { cancelled: false, done: Promise.resolve() };
    run.done = this.loop(key, target, run).finally(() => {
      if (this.runs.get(key) === run) this.runs.delete(key);
    });
    this.runs.set(key, run);
    return run.done;
  }

  /** Stop every loop (shutdown / tests). */
  dispose(): void {
    for (const run of this.runs.values()) run.cancelled = true;
    this.runs.clear();
  }

  private async loop(
    key: string,
    target: TrackerTarget,
    run: TrackerRun,
  ): Promise<void> {
    const { logger } = this.options;
    const deadline = this.now() + this.timeoutMs;
    const checkName = checkRunName(target.applicationName);

    // Post the queued state before the first poll, so the PR shows the check
    // the moment the webhook lands rather than 30s later.
    let checkRunId: number | undefined;
    let commentId: number | undefined;
    // Seeded with `idle` because the queued check posted below is exactly how
    // `idle` renders — without this the first poll would rewrite an identical
    // check run for no reason.
    let lastStatus: DokployStatus | undefined;

    try {
      checkRunId = await upsertCheckRun(this.options.octokit, target.repo, {
        name: checkName,
        headSha: target.headSha,
        status: 'in_progress',
        title: 'Queued in Dokploy',
        summary: queuedSummary(target),
        detailsUrl: this.options.dokployBaseUrl,
      });
      commentId = await upsertComment(
        this.options.octokit,
        target.repo,
        target.prNumber,
        COMMENT_MARKER,
        queuedComment(target),
        commentId,
      );
      lastStatus = 'idle';
    } catch (error) {
      logger.error(
        { key, error: String(error) },
        'preview tracker: initial check failed',
      );
    }

    while (!run.cancelled) {
      await this.sleep(this.pollIntervalMs);
      if (run.cancelled) return;

      let preview: DokployPreviewDeployment | undefined;
      try {
        const previews = await this.options.dokploy.listPreviewDeployments(
          target.applicationId,
        );
        preview = findPreview(previews, target.prNumber);
      } catch (error) {
        // A transient Dokploy outage must not fail the PR — keep polling until
        // the deadline and only then report the timeout.
        logger.warn(
          { key, error: String(error) },
          'preview tracker: dokploy poll failed, retrying',
        );
      }

      if (preview) {
        const status = preview.previewStatus;
        if (status !== lastStatus) {
          lastStatus = status;
          try {
            checkRunId = await this.report(
              target,
              checkName,
              preview,
              checkRunId,
            );
            commentId = await upsertComment(
              this.options.octokit,
              target.repo,
              target.prNumber,
              COMMENT_MARKER,
              statusComment(
                target,
                preview,
                this.options.dokployBaseUrl,
                await this.options.dokploy.applicationUrl(target.applicationId),
              ),
              commentId,
            );
          } catch (error) {
            logger.error(
              { key, error: String(error) },
              'preview tracker: github update failed',
            );
          }
        }
        if (status === 'done' || status === 'error') {
          logger.info({ key, status }, 'preview tracker: settled');
          return;
        }
      }

      if (this.now() >= deadline) {
        logger.warn({ key }, 'preview tracker: timed out');
        await this.reportTimeout(
          target,
          checkName,
          checkRunId,
          commentId,
        ).catch((error) =>
          logger.error(
            { key, error: String(error) },
            'preview tracker: timeout report failed',
          ),
        );
        return;
      }
    }
  }

  /** Push the current Dokploy status onto the check run. */
  private async report(
    target: TrackerTarget,
    checkName: string,
    preview: DokployPreviewDeployment,
    checkRunId: number | undefined,
  ): Promise<number> {
    const { status, conclusion, title } = checkStateFor(preview.previewStatus);
    const detailsUrl = await this.options.dokploy.applicationUrl(
      target.applicationId,
    );
    return upsertCheckRun(this.options.octokit, target.repo, {
      name: checkName,
      headSha: target.headSha,
      status,
      conclusion,
      title,
      summary: statusComment(
        target,
        preview,
        this.options.dokployBaseUrl,
        detailsUrl,
      ),
      detailsUrl,
      checkRunId,
    });
  }

  private async reportTimeout(
    target: TrackerTarget,
    checkName: string,
    checkRunId: number | undefined,
    commentId: number | undefined,
  ): Promise<void> {
    const summary = `The Dokploy preview for this PR did not report a result within ${Math.round(
      this.timeoutMs / 60_000,
    )} minutes.`;
    await upsertCheckRun(this.options.octokit, target.repo, {
      name: checkName,
      headSha: target.headSha,
      status: 'completed',
      conclusion: 'timed_out',
      title: 'Preview deployment timed out',
      summary,
      detailsUrl: this.options.dokployBaseUrl,
      checkRunId,
    });
    await upsertComment(
      this.options.octokit,
      target.repo,
      target.prNumber,
      COMMENT_MARKER,
      `### Dokploy preview deployment\n\n⏱️ **Timed out** — ${summary}`,
      commentId,
    );
  }
}

/** One loop per PR head commit: a new push supersedes the previous tracker. */
export function trackerKey(target: TrackerTarget): string {
  return `${target.repo.owner}/${target.repo.name}#${target.prNumber}@${target.headSha}`;
}

/** The check-run name — stable per application so the upsert finds it again. */
export function checkRunName(applicationName: string): string {
  return `dokploy/${applicationName} (preview)`;
}

/**
 * Map Dokploy's preview status onto a GitHub check state. `idle`/`running` stay
 * `in_progress` (the PR shows a spinner); `done` passes and `error` fails,
 * which is requirement (c).
 */
export function checkStateFor(status: DokployStatus): {
  status: CheckStatus;
  conclusion?: CheckConclusion;
  title: string;
} {
  switch (status) {
    case 'done':
      return {
        status: 'completed',
        conclusion: 'success',
        title: 'Preview deployment ready',
      };
    case 'error':
      return {
        status: 'completed',
        conclusion: 'failure',
        title: 'Preview deployment failed',
      };
    case 'running':
      return { status: 'in_progress', title: 'Building preview deployment' };
    default:
      return { status: 'in_progress', title: 'Queued in Dokploy' };
  }
}

/**
 * Dokploy stores `pullRequestNumber` as text, and one application can hold
 * several previews; the newest matching row is the one this PR's check tracks.
 */
function findPreview(
  previews: DokployPreviewDeployment[],
  prNumber: number,
): DokployPreviewDeployment | undefined {
  return previews
    .filter((preview) => Number(preview.pullRequestNumber) === prNumber)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function queuedSummary(target: TrackerTarget): string {
  return `The preview deployment for \`${target.applicationName}\` has been queued in Dokploy. This check updates every 30 seconds.`;
}

function queuedComment(target: TrackerTarget): string {
  return [
    '### Dokploy preview deployment',
    '',
    '| | |',
    '| --- | --- |',
    '| **Status** | 🟡 Queued |',
    `| **Application** | \`${target.applicationName}\` |`,
    `| **Commit** | \`${target.headSha.slice(0, 7)}\` |`,
    '',
    '_Updating every 30 seconds._',
  ].join('\n');
}

/** The PR comment body — requirement (b): the URL plus the deployment details. */
function statusComment(
  target: TrackerTarget,
  preview: DokployPreviewDeployment,
  dokployBaseUrl: string,
  detailsUrl: string,
): string {
  const url = previewUrl(preview);
  const rows: Array<[string, string]> = [
    ['Status', statusBadge(preview.previewStatus)],
    ['Application', `\`${target.applicationName}\``],
    ['Preview URL', url ? `[${url}](${url})` : '_pending_'],
    ['Dokploy', `[open deployment](${detailsUrl})`],
    ['Instance', dokployBaseUrl],
    ['Branch', `\`${preview.branch}\``],
    ['Commit', `\`${target.headSha.slice(0, 7)}\``],
    ['Preview app', `\`${preview.appName}\``],
  ];
  if (preview.expiresAt) rows.push(['Expires', preview.expiresAt]);

  return [
    '### Dokploy preview deployment',
    '',
    '| | |',
    '| --- | --- |',
    ...rows.map(([label, value]) => `| **${label}** | ${value} |`),
  ].join('\n');
}

function statusBadge(status: DokployStatus): string {
  switch (status) {
    case 'done':
      return '🟢 Ready';
    case 'error':
      return '🔴 Failed';
    case 'running':
      return '🔵 Building';
    default:
      return '🟡 Queued';
  }
}
