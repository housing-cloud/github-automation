/**
 * `@cloudybot` commands: the pull direction of this service.
 *
 * A reviewer types `@cloudybot redeploy` (or adds `cloudy-redeploy`) and the
 * service calls pstack's control-plane API, waits for the result, and settles
 * the checks from it. Three properties shape the implementation:
 *
 * 1. **The work outlives the webhook.** A redeploy is minutes; GitHub gives a
 *    webhook delivery ~10 seconds. So a command is *accepted* synchronously —
 *    the checks reopen immediately, which is the acknowledgement — and then
 *    runs detached. `drain()` exists so tests and shutdown can await them.
 * 2. **The verdict is expressed as pstack events.** `readinessToSignals` turns
 *    a settled `Readiness` into the same `container.*` + `stack.*` signals the
 *    webhooks carry, so the reporter's reducer has one way to settle a check,
 *    not two. That is what makes `recheck` able to repair a check left pending
 *    by a missed delivery.
 * 3. **One command per deployment at a time.** pstack itself rejects a second
 *    job on a busy stack with a 409, and racing two waits on one stack would
 *    have them fight over the same checks.
 */

import type { Logger } from '@samyx/github-automation-suite';
import {
  PstackError,
  type PstackControlClient,
  type Readiness,
  signalFromJob,
  signalsFromReadiness,
  varsForPr,
} from './client';
import { BOT_COMMANDS, BOT_MENTION, type BotCommand } from './help';
import type { PstackReporter } from './reporter';
import { parseStackIdentity } from './stack';
import type { AppOctokit, RepoRef } from '../github/checks';

export type CommandName = BotCommand['name'];

// Both derived from the same table the help comment renders, so a command
// cannot be documented and unroutable (or the reverse), and the table's
// ordering stays free to change.
const COMMAND_NAMES: readonly CommandName[] = BOT_COMMANDS.map((c) => c.name);

/** `cloudy-recheck` -> `recheck`. */
const LABELS = new Map<string, CommandName>(
  BOT_COMMANDS.map((command) => [command.label, command.name]),
);

/**
 * Read a command out of a comment body.
 *
 * Anchored to the start of a line so quoting someone else's `@cloudybot
 * redeploy` in a reply does not redeploy the stack — the quoted line begins
 * with `>`. Trailing text after the verb is allowed, so
 * "@cloudybot redeploy please" works, but a bare mention does not fire.
 */
export function parseCommentCommand(body: string): CommandName | undefined {
  const pattern = new RegExp(
    `^\\s*${BOT_MENTION}\\s+(${COMMAND_NAMES.join('|')})\\b`,
    'im',
  );
  const match = pattern.exec(body);
  return match ? (match[1]?.toLowerCase() as CommandName) : undefined;
}

/** Read a command out of an applied label name. */
export function parseLabelCommand(label: string): CommandName | undefined {
  return LABELS.get(label.trim().toLowerCase());
}

/** Every `cloudy-*` label the bot consumes. */
export function commandLabels(): string[] {
  return [...LABELS.keys()];
}

export interface PstackCommandsOptions {
  client: PstackControlClient;
  reporter: PstackReporter;
  octokit: AppOctokit;
  repo: RepoRef;
  logger: Logger;
  /** How long to wait for a deploy job before giving up on the wait. */
  jobTimeoutMs?: number;
  /** How long to wait for the readiness watch to settle. */
  readyTimeoutMs?: number;
}

export interface CommandRequest {
  command: CommandName;
  prNumber: number;
  /** Label to remove once handled, for label-triggered commands. */
  label?: string;
  /** Who asked, for the check summary. */
  actor?: string;
}

/** One pstack deployment belonging to a PR. */
interface Deployment {
  id: string;
  stack: string;
}

export class PstackCommands {
  /** Deployment ids with a command in flight. */
  private readonly running = new Set<string>();
  /** PRs being resolved or acted on, so two triggers cannot both start. */
  private readonly pending = new Set<number>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: PstackCommandsOptions) {}

  /**
   * Accept a command and return immediately.
   *
   * The webhook that triggered it gets its 200 while the work continues in the
   * background, because a deploy takes minutes and GitHub gives a delivery
   * seconds. Errors are reported onto the checks, never thrown at the caller.
   */
  accept(request: CommandRequest): void {
    const task = this.run(request).catch((error) => {
      this.options.logger.error(
        {
          command: request.command,
          pr: request.prNumber,
          error: String(error),
        },
        'pstack: command failed unexpectedly',
      );
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /** Await every accepted command. Used by tests and graceful shutdown. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  private async run(request: CommandRequest): Promise<void> {
    const { logger } = this.options;
    if (this.pending.has(request.prNumber)) {
      logger.info(
        { pr: request.prNumber, command: request.command },
        'pstack: a command is already running for this PR — ignoring',
      );
      return;
    }
    this.pending.add(request.prNumber);

    try {
      // Removed first, and regardless of the outcome: a sticky label produces
      // no second `labeled` event, so leaving it on turns a button into a
      // one-shot. Removing it also makes the "already running" case visible —
      // the label disappears, so a re-apply is a deliberate retry.
      if (request.label) await this.removeLabel(request);

      const deployments = await this.resolveDeployments(request.prNumber);
      if (deployments.length === 0) {
        logger.info(
          { pr: request.prNumber, command: request.command },
          'pstack: no deployment matches this PR — nothing to do',
        );
        return;
      }

      for (const deployment of deployments) {
        if (this.running.has(deployment.id)) {
          logger.info(
            { deployment: deployment.id, command: request.command },
            'pstack: deployment already has a command in flight — ignoring',
          );
          continue;
        }
        this.running.add(deployment.id);
        try {
          await this.execute(request, deployment);
        } finally {
          this.running.delete(deployment.id);
        }
      }
    } finally {
      this.pending.delete(request.prNumber);
    }
  }

  /**
   * The deployments belonging to a PR.
   *
   * Listed from pstack rather than assumed to be `pr-<n>`, because one PR can
   * own several prefixed deployments (`web-pr-12`, `api-pr-12`) and the API's
   * `:id` is the registry id, not the resolved stack name. The listing is
   * matched on the *stack* name, which is what carries the PR number.
   *
   * Falls back to the canonical `pr-<n>` when the listing cannot be read, so a
   * transient API failure does not make a working command look unsupported.
   */
  private async resolveDeployments(prNumber: number): Promise<Deployment[]> {
    const canonical = `pr-${prNumber}`;
    try {
      const rows = await this.options.client.deployments.list(
        varsForPr(prNumber),
      );
      const matched: Deployment[] = [];
      for (const row of rows) {
        // A row whose spec variables this call did not supply degrades to
        // `stack: null`; the id is then the only name available, and it is
        // conventionally the same shape.
        const name = row.stack ?? row.id;
        if (parseStackIdentity(name)?.prNumber === prNumber) {
          matched.push({ id: row.id, stack: name });
        }
      }
      return matched;
    } catch (error) {
      this.options.logger.debug(
        { pr: prNumber, error: String(error) },
        'pstack: listing deployments failed — assuming the canonical name',
      );
      return [{ id: canonical, stack: canonical }];
    }
  }

  private async execute(
    request: CommandRequest,
    deployment: Deployment,
  ): Promise<void> {
    const { reporter, logger } = this.options;
    const vars = varsForPr(request.prNumber);
    const by = request.actor ? ` by @${request.actor}` : '';

    // Reopen the checks first: this is the acknowledgement, and it has to be
    // visible before work that takes minutes begins.
    await reporter.handle({
      type: 'command.started',
      stack: deployment.stack,
      title: STARTED_TITLE[request.command],
      reason: `${STARTED_DETAIL[request.command]}${by}`,
    });

    try {
      if (request.command === 'redeploy') {
        const started = await this.options.client.deployments.up(
          deployment.id,
          vars,
        );
        const job = await this.options.client.waitForJob(started.id, {
          timeoutMs: this.options.jobTimeoutMs ?? 30 * 60_000,
        });
        if (job.state !== 'ok') {
          // `failed`, `leaked` and `cancelled` are answers, not exceptions —
          // the client returns them, and each maps onto the `job.*` event the
          // reporter already knows how to fail a stack with.
          await reporter.handle(signalFromJob(job));
          return;
        }
      }

      if (request.command === 'restart') {
        const restarted = await this.restartContainers(deployment, request);
        if (restarted === 0) {
          await reporter.handle({
            type: 'command.failed',
            stack: deployment.stack,
            error: 'the stack has no containers to restart',
          });
          return;
        }
      }

      // `up` and `restart` both (re)start the readiness watch, so only an
      // untouched `recheck` needs to force a settled one to re-run.
      const readiness = await this.waitForReadiness(deployment, request, {
        refresh: request.command === 'recheck',
      });

      if (readiness.state === 'watching') {
        // Still converging when the wait expired. Reporting failure here would
        // be a false negative — pstack's own `stack.*` delivery will settle it.
        await reporter.handle({
          type: 'command.started',
          stack: deployment.stack,
          title: 'Preview stack still converging',
          reason:
            'still converging when the wait expired — the checks settle when pstack reports',
        });
        return;
      }

      for (const signal of signalsFromReadiness(readiness)) {
        await reporter.handle(signal);
      }
    } catch (error) {
      logger.error(
        {
          deployment: deployment.id,
          command: request.command,
          error: String(error),
        },
        'pstack: command failed',
      );
      await reporter.handle({
        type: 'command.failed',
        stack: deployment.stack,
        error: describeError(error, request.command),
      });
    }
  }

  /**
   * Restart every container the deployment owns.
   *
   * pstack's restart verb is per **container**, not per service or per stack —
   * deliberately, since `docker restart` on the wrong name could take down
   * Traefik and every other preview on the host. So the container list comes
   * from the deployment's own runtime view, which is also the only list the API
   * will accept names from.
   */
  private async restartContainers(
    deployment: Deployment,
    request: CommandRequest,
  ): Promise<number> {
    const vars = varsForPr(request.prNumber);
    const runtime = await this.options.client.deployments.runtime(
      deployment.id,
      vars,
    );
    let restarted = 0;
    for (const container of runtime.containers) {
      await this.options.client.containers.restart(
        deployment.id,
        container.name,
        {
          vars,
        },
      );
      restarted++;
    }
    return restarted;
  }

  /**
   * Long-poll readiness until it settles, or until the deadline.
   *
   * `?wait=30` returns the moment the watch leaves `watching`, so this is a
   * re-issue loop with no edge to miss rather than a poll on a timer. A
   * still-`watching` result is returned as-is: the caller decides, and it is
   * not a failure.
   */
  private async waitForReadiness(
    deployment: Deployment,
    request: CommandRequest,
    options: { refresh: boolean },
  ): Promise<Readiness> {
    const vars = varsForPr(request.prNumber);
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 10 * 60_000);
    let refresh = options.refresh;
    for (;;) {
      const readiness = await this.options.client.deployments.readiness(
        deployment.id,
        { wait: 30, refresh, vars },
      );
      refresh = false;
      if (readiness.state !== 'watching') return readiness;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return readiness;
      // `wait=30` is what paces this loop: the server holds the request until
      // the watch settles. A hop that does not honour it (or a watch that has
      // not started yet) answers immediately, and re-issuing on that with no
      // floor would be a hot loop against the API.
      await delay(Math.min(1_000, remaining));
    }
  }

  private async removeLabel(request: CommandRequest): Promise<void> {
    if (!request.label) return;
    try {
      await this.options.octokit.rest.issues.removeLabel({
        owner: this.options.repo.owner,
        repo: this.options.repo.name,
        issue_number: request.prNumber,
        name: request.label,
      });
    } catch (error) {
      // Already removed, or removed by a human between the event and now.
      this.options.logger.debug(
        { pr: request.prNumber, label: request.label, error: String(error) },
        'pstack: removing the command label failed',
      );
    }
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const STARTED_TITLE: Record<CommandName, string> = {
  recheck: 'Rechecking the preview stack',
  redeploy: 'Redeploying the preview stack',
  restart: 'Restarting the preview stack',
};

const STARTED_DETAIL: Record<CommandName, string> = {
  recheck: 're-reading the stack’s state from pstack, requested',
  redeploy: 'redeploy requested',
  restart: 'container restart requested',
};

/**
 * A human-readable reason for the check summary.
 *
 * `PstackError` carries the server's own message and status, and the two
 * statuses a reviewer can act on are called out: a 409 means something else is
 * already running on that stack, and a 404 means there is no deployment to act
 * on rather than a broken bot.
 */
function describeError(error: unknown, command: CommandName): string {
  if (error instanceof PstackError) {
    if (error.status === 409) {
      return `pstack refused the ${command}: the stack already has a job in flight`;
    }
    if (error.status === 404) {
      return `pstack has no deployment for this PR, so there is nothing to ${command}`;
    }
    return `pstack refused the ${command} (HTTP ${error.status}): ${error.message}`;
  }
  return `the ${command} could not be completed: ${String(error)}`;
}
