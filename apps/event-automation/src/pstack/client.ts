/**
 * The pstack **control-plane** side of this service.
 *
 * Everything else here is push-driven: pstack signs an event, the reporter
 * mirrors it onto GitHub. The `@cloudybot` commands are the opposite direction
 * — this service asks pstack to do something and then has to find out how it
 * went — so they need the HTTP API, which is what
 * `@samyx/preview-stacks-client` wraps.
 *
 * Using the published client rather than hand-rolled `fetch` calls buys three
 * things that are each easy to get subtly wrong:
 *
 * - **`waitForJob`** polls with a terminal-state list, instead of guessing
 *   which of `ok` / `failed` / `leaked` / `cancelled` means "stop asking".
 * - **`waitForReady`** treats `readiness.state === 'watching'` as "ask again"
 *   rather than as an error, and long-polls (`?wait=30`) instead of spinning.
 * - **`verifyWebhook`** hashes the raw bytes and enforces the signed
 *   timestamp's freshness — see `verifyDelivery` at the bottom of this file.
 *
 * Both waiters *return* a failed job or an unready stack rather than throwing;
 * the state is the answer. They throw only when the wait itself fails.
 */

import {
  createClient,
  PstackError,
  type Job,
  type Readiness,
  type Runtime,
  type Vars,
  verifyWebhook,
} from '@samyx/preview-stacks-client';
import type { Logger } from '@samyx/github-automation-suite';
import type { PstackSignal } from './reporter';

export { PstackError };
export type { Job, Readiness, Runtime };

/** The subset of the client this service uses. */
export type PstackControlClient = ReturnType<typeof createClient>;

export interface PstackClientOptions {
  /** pstack API base URL, e.g. `https://api.preview.housing.cloud`. */
  baseUrl: string;
  /** `PSTACK_TOKEN` or a personal `pstack_pat_…`. Required for POSTs. */
  token?: string;
  /** Swap in for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout. Bounds the HTTP call, never the deploy. */
  timeoutMs?: number;
}

export function createPstackClient(
  options: PstackClientOptions,
): PstackControlClient {
  return createClient({
    baseUrl: options.baseUrl,
    token: options.token,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
}

/**
 * Spec variables sent with every call for a stack.
 *
 * **`down` needs the same variables as `up`**, and so does every read: a spec
 * that interpolates `${PR}` cannot resolve its own stack name without them, and
 * the API answers `stack: null` + `unresolved` rather than guessing. Our
 * deployments are named `pr-<n>` / `<prefix>-pr-<n>`, so `PR` is recoverable
 * from the stack name and is always supplied.
 */
export function varsForPr(prNumber: number): Vars {
  return { PR: String(prNumber) };
}

/**
 * The public HTTPS URLs Traefik actually serves for a stack, read from pstack.
 *
 * `GET /api/deployments/:id/runtime` returns the parsed router rules — the
 * `hosts` a request must arrive with to reach each container — so this is the
 * routing table itself rather than a hostname pattern reconstructed from a
 * template. That distinction is the whole reason to make the call: a service
 * whose router carries a custom rule, or a stack on a second domain, is
 * reported correctly here and would be silently wrong if guessed.
 *
 * Returned per compose service, since that is what the checks and the comment
 * are keyed on. `tls === false` routers are still reported, as `http://` — an
 * honest plain-HTTP URL beats an `https://` one that will not connect.
 */
export function serviceUrlsFromRuntime(
  runtime: Runtime,
): Map<string, string[]> {
  const byContainer = new Map<string, string>();
  for (const container of runtime.containers) {
    if (container.service) byContainer.set(container.name, container.service);
  }

  const urls = new Map<string, string[]>();
  for (const route of runtime.routes) {
    // `route.service` is the compose service when pstack could resolve it;
    // otherwise the container it routes to still identifies one.
    const service =
      route.service ??
      (route.container ? byContainer.get(route.container) : undefined);
    if (!service) continue;
    const scheme = route.tls === false ? 'http' : 'https';
    for (const host of route.hosts) {
      if (!host) continue;
      const url = `${scheme}://${host}`;
      const existing = urls.get(service);
      if (!existing) urls.set(service, [url]);
      else if (!existing.includes(url)) existing.push(url);
    }
  }
  return urls;
}

/**
 * Read the live routing table for a stack, or `undefined` if it cannot be read.
 *
 * **The API is keyed on the registry id, not the stack name**, and those are
 * only the same by convention (`pr-123` deploys the stack `pr-123`). The stack
 * name is all the reporter has, so it is tried first and a 404 falls back to
 * finding the deployment whose *resolved stack* matches — one extra call, and
 * only in the case where the two genuinely differ.
 *
 * Never throws: the URLs are an enrichment of a comment that must still be
 * posted when pstack is unreachable, mid-teardown, or configured without an
 * API token.
 */
export async function readServiceUrls(
  client: PstackControlClient,
  stack: string,
  prNumber: number,
  logger: Logger,
): Promise<Map<string, string[]> | undefined> {
  try {
    const vars = varsForPr(prNumber);
    let runtime: Runtime;
    try {
      runtime = await client.deployments.runtime(stack, vars);
    } catch (error) {
      if (!(error instanceof PstackError) || error.status !== 404) throw error;
      const rows = await client.deployments.list(vars);
      const match = rows.find((row) => row.stack === stack);
      if (!match) return undefined;
      runtime = await client.deployments.runtime(match.id, vars);
    }
    // Docker not answering means the routes are last-known, not current, but a
    // last-known URL is still the right one to show — the router outlives a
    // blip in the container list.
    return serviceUrlsFromRuntime(runtime);
  } catch (error) {
    logger.debug(
      { stack, error: String(error) },
      'pstack: could not read the live routing table',
    );
    return undefined;
  }
}

/**
 * Project a settled `Readiness` onto the reporter's signals.
 *
 * A command-driven wait produces the same verdict the webhooks would have
 * carried, so it is expressed in exactly the same vocabulary rather than as a
 * second, parallel way to settle a check. That is what lets `@cloudybot
 * recheck` fix a check left pending by a missed delivery: the reducer cannot
 * tell the two apart, because there is nothing to tell apart.
 *
 * Emits the per-container events first, then the terminal `stack.*` — the
 * order the readiness watch itself uses, and the order the reducer's
 * "settle anything still pending" logic assumes.
 */
export function signalsFromReadiness(readiness: Readiness): PstackSignal[] {
  const signals: PstackSignal[] = [];
  for (const container of readiness.containers) {
    if (container.ready) {
      signals.push({
        type: 'container.ready',
        stack: readiness.stack,
        container: container.name,
        service: container.service ?? undefined,
        state: container.state,
        health: container.health,
        hasHealthcheck: container.hasHealthcheck,
      });
    } else if (container.failed) {
      signals.push({
        type: 'container.start-failed',
        stack: readiness.stack,
        container: container.name,
        service: container.service ?? undefined,
        state: container.state,
        exitCode: container.exitCode,
        reason: container.reason,
      });
    }
  }

  const ready = readiness.containers.filter((c) => c.ready);
  const failed = readiness.containers.filter((c) => c.failed);
  // Neither ready nor failed = still converging when the watch ended, which is
  // exactly what `pendingContainers` means in a `stack.timedout` payload.
  const pending = readiness.containers.filter((c) => !c.ready && !c.failed);

  signals.push({
    type:
      readiness.state === 'ready'
        ? 'stack.ready'
        : readiness.state === 'failed'
          ? 'stack.failed'
          : 'stack.timedout',
    stack: readiness.stack,
    state: readiness.state,
    containers: readiness.containers.length,
    readyCount: ready.length,
    failedContainers: failed.map((c) => c.name),
    pendingContainers: pending.map((c) => c.name),
    reachable: readiness.reachable,
    durationMs:
      readiness.endedAt === undefined
        ? undefined
        : readiness.endedAt - readiness.startedAt,
  });
  return signals;
}

/** The reporter signal a finished (non-`ok`) job maps to. */
export function signalFromJob(job: Job): PstackSignal {
  return {
    type: `job.${job.state === 'ok' ? 'succeeded' : job.state}`,
    stack: job.stack,
    action: job.action,
    state: job.state,
    error: job.error,
    durationMs:
      job.endedAt === undefined ? undefined : job.endedAt - job.startedAt,
  };
}

/**
 * Verify a pstack delivery with the client's own `verifyWebhook`.
 *
 * The plugin ships an equivalent check, but this is the receiver half the
 * pstack authors maintain in lockstep with the sender, and it additionally
 * reports **`redelivery`** — the `x-pstack-redelivery: 1` header a replayed
 * delivery carries, which the plugin's boolean-only `verify` cannot express.
 *
 * `rawBody` is decoded from the untouched bytes the engine hands the source.
 * Re-serializing the parsed JSON would change them and fail a perfectly good
 * signature, which is the mistake this function exists to prevent.
 */
export async function verifyDelivery(args: {
  secret: string;
  rawBody: ArrayBuffer;
  headers: Readonly<Record<string, string>>;
  toleranceMs?: number;
  now?: () => number;
}): Promise<{ ok: boolean; reason?: string; redelivery: boolean }> {
  const result = await verifyWebhook({
    secret: args.secret,
    rawBody: new TextDecoder().decode(args.rawBody),
    headers: args.headers,
    toleranceMs: args.toleranceMs,
    now: args.now?.(),
  });
  return {
    ok: result.ok,
    reason: result.reason,
    redelivery: result.redelivery,
  };
}
