/**
 * Pure helpers for reading pstack (`@samyx/preview-stacks`) identity out of the
 * fields its webhooks actually carry.
 *
 * **The load-bearing detail.** The plugin's `prNumber` is parsed from the
 * envelope's `data.id` / `data.deployment`, and only `deployment.*` and the
 * operator-driven `container.*` events carry that field. Every event this
 * service reports on — `job.*`, `stack.*`, `container.ready`,
 * `container.start-failed`, `healthcheck.*` — carries only `stack`, so
 * `ctx.event.data.prNumber` is `undefined` for them. Verified against the real
 * payloads: `{"event":"stack.timedout","data":{"stack":"pr-16828", ...}}` has no
 * id at all. So the PR number is derived here, from the **stack name**.
 */

/** A stack whose name identifies a pull request. */
export interface StackIdentity {
  /** The PR the stack belongs to. */
  prNumber: number;
  /** Text before the `pr-N` suffix, e.g. `web` in `web-pr-12`. Empty for `pr-12`. */
  prefix: string;
}

/**
 * `pr-16828` -> 16828, `web-pr-12` -> 12 (prefix `web`).
 *
 * Anchored at the end so an unrelated stack that merely contains digits is not
 * mistaken for a PR, and case-insensitive because the deployment id is
 * operator-typed.
 */
export function parseStackIdentity(
  stack: string | undefined,
): StackIdentity | undefined {
  if (!stack) return undefined;
  const match = /^(.*?)(?:^|-)pr[-_]?(\d+)$/i.exec(stack);
  if (!match) return undefined;
  const prNumber = Number(match[2]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) return undefined;
  return { prNumber, prefix: match[1] ?? '' };
}

/**
 * Recover the compose service from a container name, for the payloads that
 * carry names but no service.
 *
 * `stack.timedout` reports `pendingContainers: ["pr-16828-web-1"]` — names
 * only — and that list is the *only* signal that `web` never came up, so
 * without this the web check would hang `in_progress` forever on the exact
 * payload provided.
 *
 * Compose names containers `<project>-<service>-<replica>`, so stripping the
 * stack prefix and the replica suffix leaves the service.
 */
export function serviceFromContainer(
  container: string,
  stack: string | undefined,
): string | undefined {
  let rest = container;
  if (stack && rest.startsWith(`${stack}-`))
    rest = rest.slice(stack.length + 1);
  // Compose appends `-<n>`; a service name itself may contain dashes.
  const trimmed = rest.replace(/-\d+$/, '');
  return trimmed || undefined;
}

/** The check-run name for the whole-stack check (requirement 1). */
export function stackCheckName(): string {
  return 'pstack/stack';
}

/** The check-run name for one service (requirements 2 and 3). */
export function serviceCheckName(service: string): string {
  return `pstack/${service}`;
}

/**
 * The hostname pstack's generated Traefik router serves for a service, when a
 * preview domain is configured: `<service>-<stack>.<domain>`, matching
 * pstack's own `${z.name}-${t.stack}.${M}` router rule.
 */
export function previewUrlFor(
  service: string,
  stack: string,
  domain: string | undefined,
): string | undefined {
  if (!domain) return undefined;
  return `https://${service}-${stack}.${domain}`;
}
