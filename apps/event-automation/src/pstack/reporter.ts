/**
 * The pstack reporter: turns pstack's event stream into three GitHub check runs
 * per PR plus one tracked comment.
 *
 *   1. `pstack/stack`     — the stack as a whole (requirement 1)
 *   2. `pstack/db-seed`   — the seed container finished successfully (req. 2)
 *   3. `pstack/web`       — the web container reached ready (requirement 3)
 *   4. a PR comment, posted/updated when (1) settles (requirement 4)
 *
 * ## Why this holds state
 *
 * pstack's events are *deltas*, and the three checks are driven by different
 * ones. A check must also be **created pending before it can pass**, since a PR
 * that shows a green check only after success is indistinguishable from a PR
 * with no check at all. So the first event seen for a stack opens all three
 * checks `in_progress`, and later events settle them individually.
 *
 * The state is per stack (`pr-16828`), keyed off the stack name because that is
 * the only PR-identifying field the relevant payloads carry — see
 * `parseStackIdentity`. It is in-memory: the checks live on GitHub, which is the
 * durable store, and a restart simply re-opens the checks on the next event.
 *
 * ## The two payload facts that drive the design
 *
 * - **A one-shot container is "ready" when it exits 0.** pstack's verdict is
 *   `state === 'exited' && exitCode === 0 -> ready`, so `db-seed` completing
 *   successfully arrives as a plain `container.ready`. There is no separate
 *   "job finished" event to wait for.
 * - **A container that never comes up may produce no per-container event at
 *   all.** In the real `stack.timedout` payload the only trace of the failure
 *   is `pendingContainers: ["pr-16828-web-1"]`. So the terminal `stack.*` event
 *   is also what settles any service check still pending — otherwise the `web`
 *   check would spin forever on exactly the payload provided.
 */

import type { Logger } from '@samyx/github-automation-suite';
import {
  type CheckConclusion,
  type CheckStatus,
  type RepoRef,
  type AppOctokit,
  ensureComment,
  upsertCheckRun,
  upsertComment,
} from '../github/checks';
import { helpComment } from './help';
import {
  parseStackIdentity,
  previewUrlFor,
  serviceCheckName,
  serviceFromContainer,
  stackCheckName,
} from './stack';

/** Marker identifying the pstack comment, so it is edited rather than stacked. */
const PSTACK_COMMENT_MARKER = 'hou-event-automation:pstack-stack';

/** Marker identifying the one-time help comment. */
export const HELP_COMMENT_MARKER = 'hou-event-automation:cloudybot-help';

/** A pstack event, reduced to the fields the reporter reads. */
export interface PstackSignal {
  type: string;
  stack?: string;
  container?: string;
  service?: string;
  state?: string;
  action?: string;
  error?: string;
  reason?: string;
  exitCode?: number | null;
  health?: string | null;
  hasHealthcheck?: boolean;
  healthy?: boolean;
  containers?: number;
  readyCount?: number;
  failedContainers?: string[];
  pendingContainers?: string[];
  reachable?: boolean;
  durationMs?: number;
  waitedMs?: number;
  by?: string;
  /**
   * Pending-state check title, set only by the synthetic `command.*` signals so
   * a running command names itself ("Redeploying…") instead of showing the
   * generic "Preview stack deploying".
   */
  title?: string;
}

/**
 * The public URLs a stack serves, per compose service.
 *
 * Read from pstack's live routing table when the control-plane API is
 * configured (see `pstack/client.ts`), so the comment links the hostnames
 * Traefik actually answers on rather than a reconstructed pattern.
 */
export type ServiceUrlResolver = (
  stack: string,
  prNumber: number,
) => Promise<ReadonlyMap<string, readonly string[]> | undefined>;

export interface PstackReporterOptions {
  octokit: AppOctokit;
  repo: RepoRef;
  logger: Logger;
  /** Services that get their own check run, e.g. `['db-seed', 'web']`. */
  services: readonly string[];
  /** Preview domain, used to build the per-service URL in the comment. */
  previewDomain?: string;
  /** pstack dashboard base URL, linked from the checks. */
  pstackBaseUrl?: string;
  /**
   * Live per-service URLs from pstack's routing table. When omitted (or when
   * it returns nothing) the comment falls back to the `previewDomain` pattern.
   */
  resolveUrls?: ServiceUrlResolver;
  /**
   * Whether the `@cloudybot` commands are actually wired up. Only affects the
   * help comment: documenting a command the service cannot run is worse than
   * documenting none.
   */
  commandsEnabled?: boolean;
}

type Phase = 'pending' | 'succeeded' | 'failed';

interface ServiceState {
  phase: Phase;
  detail?: string;
  checkRunId?: number;
  /** Last state pushed to GitHub, so an unchanged check is not rewritten. */
  rendered?: string;
}

interface StackState {
  stack: string;
  prNumber: number;
  headSha: string;
  stackPhase: Phase;
  stackDetail?: string;
  /** Pending-state title while a `@cloudybot` command is running. */
  pendingTitle?: string;
  stackCheckRunId?: number;
  /** Last stack-check state pushed to GitHub. */
  stackRendered?: string;
  services: Map<string, ServiceState>;
  commentId?: number;
  /** Live URLs per service, from pstack's routing table. */
  urls?: ReadonlyMap<string, readonly string[]>;
  /** Serializes GitHub writes so concurrent webhooks cannot interleave. */
  queue: Promise<void>;
}

/**
 * Consumes pstack signals and maintains the checks + comment for each stack.
 */
export class PstackReporter {
  private readonly stacks = new Map<string, StackState>();
  private readonly blockedStacks = new Set<string>();
  /** PRs whose help comment this process has already ensured. */
  private readonly helped = new Set<number>();
  private clearingAll = false;

  constructor(private readonly options: PstackReporterOptions) {}

  /** Stacks currently being reported on — surfaced by `/previews`. */
  get active(): string[] {
    return [...this.stacks.keys()];
  }

  /**
   * Handle one pstack event. Resolves once GitHub has been updated, so a rule
   * can await it and the webhook response reflects a real write.
   */
  async handle(signal: PstackSignal): Promise<void> {
    if (
      this.clearingAll ||
      (signal.stack !== undefined && this.blockedStacks.has(signal.stack))
    )
      return;

    const identity = parseStackIdentity(signal.stack);
    if (!identity) {
      this.options.logger.debug(
        { stack: signal.stack, event: signal.type },
        'pstack: stack name does not identify a PR — ignoring',
      );
      return;
    }

    const state = await this.stateFor(
      signal.stack as string,
      identity.prNumber,
    );
    if (!state || this.clearingAll || this.blockedStacks.has(state.stack))
      return;

    // One writer at a time per stack: `container.ready` for db-seed and web can
    // arrive in the same tick, and both mutate the same comment.
    const next = state.queue.then(() => this.apply(state, signal));
    state.queue = next.catch(() => undefined);
    await next;
  }

  /**
   * Drop every stack belonging to a pull request, returning the names dropped.
   *
   * One PR can own more than one stack when the deployments are prefixed
   * (`web-pr-12`, `api-pr-12`), so this matches on the parsed PR number rather
   * than guessing the stack name.
   */
  forgetPr(prNumber: number): string[] {
    const dropped: string[] = [];
    for (const [stack, state] of this.stacks) {
      if (state.prNumber === prNumber) dropped.push(stack);
    }
    for (const stack of dropped) this.stacks.delete(stack);
    return dropped;
  }

  /** Serialize a one-stack GitHub cleanup against its in-flight event writes. */
  async clearStack<T>(
    stack: string,
    clear: (headSha: string | undefined) => Promise<T>,
  ): Promise<{ result: T; forgotten: string[] }> {
    this.blockedStacks.add(stack);
    const state = this.stacks.get(stack);
    try {
      await state?.queue;
      const result = await clear(state?.headSha);
      const forgotten =
        state && this.stacks.get(stack) === state && this.stacks.delete(stack)
          ? [stack]
          : [];
      return { result, forgotten };
    } finally {
      this.blockedStacks.delete(stack);
    }
  }

  /** Serialize an all-open-PR cleanup against every in-flight event write. */
  async clearAll<T>(
    clear: () => Promise<T>,
  ): Promise<{ result: T; forgotten: string[] }> {
    this.clearingAll = true;
    const states = [...this.stacks.values()];
    try {
      await Promise.all(states.map((state) => state.queue));
      const result = await clear();
      const forgotten = this.active;
      this.stacks.clear();
      return { result, forgotten };
    } finally {
      this.clearingAll = false;
    }
  }

  private async stateFor(
    stack: string,
    prNumber: number,
  ): Promise<StackState | undefined> {
    if (this.clearingAll || this.blockedStacks.has(stack)) return undefined;
    const existing = this.stacks.get(stack);
    if (existing) return existing;

    // A check run must hang off a commit, and pstack never sends one.
    let headSha: string;
    try {
      const { data } = await this.options.octokit.rest.pulls.get({
        owner: this.options.repo.owner,
        repo: this.options.repo.name,
        pull_number: prNumber,
      });
      headSha = data.head.sha;
    } catch (error) {
      this.options.logger.error(
        { stack, prNumber, error: String(error) },
        'pstack: could not resolve PR head commit — cannot open checks',
      );
      return undefined;
    }

    if (this.clearingAll || this.blockedStacks.has(stack)) return undefined;

    const state: StackState = {
      stack,
      prNumber,
      headSha,
      stackPhase: 'pending',
      services: new Map(
        this.options.services.map((service) => [
          service,
          { phase: 'pending' as Phase },
        ]),
      ),
      queue: Promise.resolve(),
    };
    this.stacks.set(stack, state);

    // Open all three checks immediately: a check that only appears on success
    // tells a reviewer nothing while the deploy is running.
    state.queue = this.openChecks(state);
    await state.queue;
    return state;
  }

  private async openChecks(state: StackState): Promise<void> {
    try {
      // Written through the same renderer `flush` uses, so the seeded
      // `rendered` values are exactly what GitHub now shows and the first real
      // event updates only the check that actually moved.
      await this.writeChecks(state);
    } catch (error) {
      this.options.logger.error(
        { stack: state.stack, error: String(error) },
        'pstack: opening checks failed',
      );
    }
    // Requirement: whenever the checks are added to a PR, make sure the PR
    // also carries the bot's help comment. It is posted after the checks
    // rather than before so a failure here cannot delay the thing reviewers
    // are actually waiting on, and it is deliberately separate from the
    // deployment-status comment: one is a fixed reference, the other is
    // rewritten on every event.
    await this.ensureHelpComment(state);
  }

  /**
   * Post the usage comment once per PR.
   *
   * Guarded twice, because both guards cover a different failure: the
   * in-process `helped` set stops a second stack on the same PR (`web-pr-12`
   * and `api-pr-12`) from racing to post two, and `ensureComment` re-checks
   * GitHub so a restarted process does not post a duplicate.
   */
  private async ensureHelpComment(state: StackState): Promise<void> {
    if (this.helped.has(state.prNumber)) return;
    this.helped.add(state.prNumber);
    try {
      await ensureComment(
        this.options.octokit,
        this.options.repo,
        state.prNumber,
        HELP_COMMENT_MARKER,
        helpComment({
          services: this.options.services,
          commandsEnabled: this.options.commandsEnabled ?? false,
          pstackBaseUrl: this.options.pstackBaseUrl,
        }),
      );
    } catch (error) {
      // Retry on the next stack event rather than never.
      this.helped.delete(state.prNumber);
      this.options.logger.error(
        { stack: state.stack, pr: state.prNumber, error: String(error) },
        'pstack: posting the help comment failed',
      );
    }
  }

  private async apply(state: StackState, signal: PstackSignal): Promise<void> {
    const before = snapshot(state);
    this.reduce(state, signal);
    const after = snapshot(state);
    if (before === after) return;

    try {
      await this.flush(state, signal);
    } catch (error) {
      this.options.logger.error(
        { stack: state.stack, event: signal.type, error: String(error) },
        'pstack: github update failed',
      );
    }
  }

  /** Fold one event into the stack's state. Pure apart from the state object. */
  private reduce(state: StackState, signal: PstackSignal): void {
    switch (signal.type) {
      // Not a pstack event: a `@cloudybot` command starting work that will
      // change the answer. Reopening the checks here is what makes the command
      // visible immediately, rather than the PR looking untouched for the
      // minutes a redeploy takes.
      case 'command.started':
        state.stackPhase = 'pending';
        state.stackDetail = signal.reason;
        state.pendingTitle = signal.title;
        for (const service of state.services.values()) {
          service.phase = 'pending';
          service.detail = undefined;
        }
        return;

      // The command could not be carried out (pstack refused it, or the wait
      // itself failed). Left pending, the checks would block the PR on work
      // that is no longer happening.
      case 'command.failed':
        state.stackPhase = 'failed';
        state.stackDetail = signal.error ?? 'the command failed';
        this.failPendingServices(state, 'the command failed');
        return;

      // A redeploy of an existing stack: re-open everything so the checks track
      // the new attempt rather than showing the previous run's result.
      case 'job.started':
        if (signal.action === 'up') {
          state.stackPhase = 'pending';
          state.stackDetail = undefined;
          state.pendingTitle = undefined;
          for (const service of state.services.values()) {
            service.phase = 'pending';
            service.detail = undefined;
          }
        }
        return;

      // `job.succeeded` for an `up` means the commands ran, NOT that the app is
      // up — `compose up -d` returns once containers are created. Record the
      // hand-off to the readiness watch, but keep the stack check pending until
      // `stack.ready` / `stack.failed` / `stack.timedout` supplies the verdict.
      case 'job.succeeded':
        if (signal.action === 'up' && state.stackPhase === 'pending') {
          const duration =
            signal.durationMs === undefined
              ? ''
              : ` in ${Math.max(1, Math.round(signal.durationMs / 1000))}s`;
          state.stackDetail = `deploy job succeeded${duration}; checking container readiness`;
        }
        return;

      case 'job.failed':
      case 'job.leaked':
        if (signal.action === 'up' || signal.type === 'job.leaked') {
          state.stackPhase = 'failed';
          state.stackDetail =
            signal.error ??
            `${signal.action ?? 'job'} ${signal.state ?? 'failed'}`;
          this.failPendingServices(state, 'the deploy job failed');
        }
        return;

      case 'job.cancelled':
        // A person stopped it; nothing was undone. Report it rather than
        // leaving a check spinning forever, but do not call it a build failure.
        if (signal.action === 'up') {
          state.stackPhase = 'failed';
          state.stackDetail = 'the deploy was cancelled — nothing was undone';
          this.failPendingServices(state, 'the deploy was cancelled');
        }
        return;

      case 'container.ready': {
        const service = this.serviceOf(signal, state);
        const target = service && state.services.get(service);
        if (!target) return;
        target.phase = 'succeeded';
        // `hasHealthcheck === false` means running, not probed — the honest
        // ceiling, so it is recorded rather than presented as a passed probe.
        target.detail =
          signal.hasHealthcheck === false
            ? 'running (no healthcheck declared)'
            : 'healthcheck passed';
        return;
      }

      case 'container.start-failed': {
        const service = this.serviceOf(signal, state);
        const target = service && state.services.get(service);
        if (!target) return;
        target.phase = 'failed';
        target.detail = signal.reason ?? 'failed to start';
        return;
      }

      case 'stack.ready':
        state.stackPhase = 'succeeded';
        state.stackDetail = `${signal.readyCount ?? 0}/${signal.containers ?? 0} containers ready`;
        // Every container is ready by definition, so any service check still
        // pending (its `container.ready` was missed) settles here too.
        for (const service of state.services.values()) {
          if (service.phase === 'pending') {
            service.phase = 'succeeded';
            service.detail = 'ready (stack reported ready)';
          }
        }
        return;

      case 'stack.failed':
      case 'stack.timedout': {
        state.stackPhase = 'failed';
        const pending = signal.pendingContainers ?? [];
        const failed = signal.failedContainers ?? [];
        state.stackDetail =
          signal.type === 'stack.timedout'
            ? `timed out with ${pending.length || 'some'} container(s) still converging${
                pending.length ? `: ${pending.join(', ')}` : ''
              }`
            : `containers failed${failed.length ? `: ${failed.join(', ')}` : ''}`;
        if (signal.reachable === false) {
          state.stackDetail += ' (Docker stopped answering — last-known state)';
        }
        // The named containers are the only per-service signal in this payload.
        this.settleFromContainerLists(state, failed, pending, signal.type);
        return;
      }

      // A person stopped a container, which also cancels the readiness watch —
      // so no `stack.*` verdict will follow and a pending check would hang.
      case 'container.stopped': {
        const service = this.serviceOf(signal, state);
        const target = service && state.services.get(service);
        if (target && target.phase === 'pending') {
          target.phase = 'failed';
          target.detail = `stopped by ${signal.by ?? 'an operator'}`;
        }
        if (state.stackPhase === 'pending') {
          state.stackPhase = 'failed';
          state.stackDetail = `\`${signal.container ?? 'a container'}\` was stopped by ${
            signal.by ?? 'an operator'
          }, which cancels the readiness watch`;
          this.failPendingServices(state, 'the readiness watch was cancelled');
        }
        return;
      }

      default:
    }
  }

  /**
   * Settle service checks from a terminal `stack.*` payload's container lists.
   * This is what makes the provided `stack.timedout` payload actionable: `web`
   * appears only in `pendingContainers`.
   */
  private settleFromContainerLists(
    state: StackState,
    failed: readonly string[],
    pending: readonly string[],
    eventType: string,
  ): void {
    const mark = (names: readonly string[], detail: string) => {
      for (const container of names) {
        const service = serviceFromContainer(container, state.stack);
        const target = service && state.services.get(service);
        if (target && target.phase === 'pending') {
          target.phase = 'failed';
          target.detail = detail;
        }
      }
    };
    mark(failed, 'the container failed to start');
    mark(
      pending,
      eventType === 'stack.timedout'
        ? 'never became ready before the deadline'
        : 'never became ready',
    );
    // Anything still pending was not named: the stack ended without a verdict
    // for it, which is a failure of the check's question, not a pass.
    this.failPendingServices(
      state,
      eventType === 'stack.timedout'
        ? 'the stack timed out before this service reported'
        : 'the stack failed before this service reported',
    );
  }

  private failPendingServices(state: StackState, detail: string): void {
    for (const service of state.services.values()) {
      if (service.phase === 'pending') {
        service.phase = 'failed';
        service.detail = detail;
      }
    }
  }

  /** The compose service for a container-scoped event. */
  private serviceOf(
    signal: PstackSignal,
    state: StackState,
  ): string | undefined {
    if (signal.service) return signal.service;
    if (signal.container) {
      return serviceFromContainer(signal.container, state.stack);
    }
    return undefined;
  }

  /** Push the current state onto GitHub: three checks, then the comment. */
  private async flush(state: StackState, signal: PstackSignal): Promise<void> {
    await this.writeChecks(state);

    // Requirement 4: comment once the stack check has settled. Also refreshed
    // after that, so a later redeploy does not leave a stale comment.
    if (state.stackPhase !== 'pending' || state.commentId !== undefined) {
      await this.refreshUrls(state);
      state.commentId = await upsertComment(
        this.options.octokit,
        this.options.repo,
        state.prNumber,
        PSTACK_COMMENT_MARKER,
        this.comment(state, signal),
        state.commentId,
      );
    }
  }

  /**
   * Refresh the stack's public URLs from pstack, just before the comment that
   * shows them is written.
   *
   * Read at comment time rather than cached from the deploy because routers
   * are created as containers come up: a table read when the stack check was
   * still pending would be missing exactly the services the comment is about
   * to link. Failures leave the previous answer in place: a comment with a
   * stale URL column, or none, still carries the status the reviewer came for,
   * so this must not be able to sink the report it decorates.
   */
  private async refreshUrls(state: StackState): Promise<void> {
    if (!this.options.resolveUrls) return;
    try {
      const urls = await this.options.resolveUrls(state.stack, state.prNumber);
      if (urls && urls.size > 0) state.urls = urls;
    } catch (error) {
      this.options.logger.debug(
        { stack: state.stack, error: String(error) },
        'pstack: resolving preview URLs failed — keeping the previous ones',
      );
    }
  }

  /**
   * Create-or-update the three check runs, skipping any whose rendered content
   * has not moved. A single pstack event usually settles one of the three, and
   * rewriting the other two would spend GitHub API quota storing what is
   * already there.
   */
  private async writeChecks(state: StackState): Promise<void> {
    const stackCheck = checkFor(state.stackPhase, {
      pending:
        state.pendingTitle ??
        (state.stackDetail
          ? 'Deployment completed; checking readiness'
          : 'Preview stack deploying'),
      succeeded: 'Preview stack ready',
      failed: 'Preview stack did not come up',
    });
    const stackSummary = this.stackSummary(state);
    const stackRendered = `${stackCheck.status}:${stackCheck.conclusion ?? ''}:${stackSummary}`;
    if (state.stackRendered !== stackRendered) {
      state.stackCheckRunId = await upsertCheckRun(
        this.options.octokit,
        this.options.repo,
        {
          name: stackCheckName(),
          headSha: state.headSha,
          status: stackCheck.status,
          conclusion: stackCheck.conclusion,
          title: stackCheck.title,
          summary: stackSummary,
          detailsUrl: this.options.pstackBaseUrl,
          checkRunId: state.stackCheckRunId,
        },
      );
      state.stackRendered = stackRendered;
    }

    for (const [service, serviceState] of state.services) {
      const check = checkFor(serviceState.phase, {
        pending: `Waiting for ${service}`,
        succeeded: `${service} ready`,
        failed: `${service} did not become ready`,
      });
      const summary = serviceState.detail
        ? `\`${service}\` in \`${state.stack}\`: ${serviceState.detail}.`
        : `Waiting for \`${service}\` in \`${state.stack}\`.`;
      const rendered = `${check.status}:${check.conclusion ?? ''}:${summary}`;
      if (serviceState.rendered === rendered) continue;
      serviceState.checkRunId = await upsertCheckRun(
        this.options.octokit,
        this.options.repo,
        {
          name: serviceCheckName(service),
          headSha: state.headSha,
          status: check.status,
          conclusion: check.conclusion,
          title: check.title,
          summary,
          detailsUrl: this.options.pstackBaseUrl,
          checkRunId: serviceState.checkRunId,
        },
      );
      serviceState.rendered = rendered;
    }
  }

  private stackSummary(state: StackState): string {
    const detail = state.stackDetail ? ` — ${state.stackDetail}` : '';
    return `Preview stack \`${state.stack}\`${detail}.`;
  }

  /** Requirement 4: the tracked comment carrying status and details. */
  private comment(state: StackState, signal: PstackSignal): string {
    const rows: Array<[string, string]> = [
      // While a command runs, its title *is* the status — "Pending" alone
      // would leave a reviewer who just typed `@cloudybot redeploy` unable to
      // tell whether anything picked it up.
      [
        'Status',
        state.stackPhase === 'pending' && state.pendingTitle
          ? `🟡 ${state.pendingTitle}`
          : phaseBadge(state.stackPhase),
      ],
      ['Stack', `\`${state.stack}\``],
    ];
    if (state.stackDetail) rows.push(['Detail', state.stackDetail]);
    if (signal.containers !== undefined) {
      rows.push([
        'Containers',
        `${signal.readyCount ?? 0} of ${signal.containers} ready`,
      ]);
    }
    if (signal.durationMs !== undefined) {
      rows.push(['Duration', `${Math.round(signal.durationMs / 1000)}s`]);
    }
    if (this.options.pstackBaseUrl) {
      rows.push(['pstack', `[open](${this.options.pstackBaseUrl})`]);
    }

    const services = [...state.services.entries()].map(
      ([service, serviceState]) => {
        const link = this.serviceLinks(state, service, serviceState.phase);
        return `| ${phaseBadge(serviceState.phase)} | \`${service}\` | ${
          serviceState.detail ?? 'waiting'
        } | ${link} |`;
      },
    );

    // A stack routes hostnames the checks know nothing about — a `docs` or
    // `mail` surface behind its own router. They are what a reviewer opens, so
    // they are listed rather than dropped for not matching PSTACK_SERVICES.
    const extra = [...(state.urls?.entries() ?? [])]
      .filter(([service]) => !state.services.has(service))
      .map(
        ([service, urls]) =>
          `| ⚪ Routed | \`${service}\` | not watched | ${linkList(urls)} |`,
      );

    return [
      '### Preview stack',
      '',
      '| | |',
      '| --- | --- |',
      ...rows.map(([label, value]) => `| **${label}** | ${value} |`),
      '',
      '| Status | Service | Detail | URL |',
      '| --- | --- | --- | --- |',
      ...services,
      ...extra,
    ].join('\n');
  }

  /**
   * The URL cell for one service.
   *
   * Live routes win over the `<service>-<stack>.<domain>` pattern, because they
   * are what Traefik is actually serving: the pattern is pstack's *default*
   * router rule, and a spec that sets its own rule, port or domain makes the
   * reconstructed link a 404 that looks authoritative. The pattern stays as the
   * fallback for when the control-plane API is not configured.
   *
   * A URL is shown only once the service is up. Under HTTP-01 the certificate
   * for a hostname is issued on its first request and only once a container
   * answers, so advertising the link earlier hands a reviewer a TLS error.
   */
  private serviceLinks(
    state: StackState,
    service: string,
    phase: Phase,
  ): string {
    if (phase !== 'succeeded') return '—';
    const live = state.urls?.get(service);
    if (live && live.length > 0) return linkList(live);
    const url = previewUrlFor(service, state.stack, this.options.previewDomain);
    return url ? `[${url}](${url})` : '—';
  }
}

function linkList(urls: readonly string[]): string {
  return urls.map((url) => `[${url}](${url})`).join('<br>');
}

/** Snapshot of everything the GitHub side renders, for change detection. */
function snapshot(state: StackState): string {
  const services = [...state.services.entries()]
    .map(([name, s]) => `${name}:${s.phase}:${s.detail ?? ''}`)
    .join('|');
  return `${state.stackPhase}:${state.stackDetail ?? ''}:${state.pendingTitle ?? ''}:${services}`;
}

function checkFor(
  phase: Phase,
  titles: Record<Phase, string>,
): { status: CheckStatus; conclusion?: CheckConclusion; title: string } {
  switch (phase) {
    case 'succeeded':
      return {
        status: 'completed',
        conclusion: 'success',
        title: titles.succeeded,
      };
    case 'failed':
      return {
        status: 'completed',
        conclusion: 'failure',
        title: titles.failed,
      };
    default:
      return { status: 'in_progress', title: titles.pending };
  }
}

function phaseBadge(phase: Phase): string {
  switch (phase) {
    case 'succeeded':
      return '🟢 Ready';
    case 'failed':
      return '🔴 Failed';
    default:
      return '🟡 Pending';
  }
}
