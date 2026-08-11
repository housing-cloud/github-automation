/**
 * The pstack webhook ingress, verified with the **client's own**
 * `verifyWebhook`.
 *
 * The suite's `previewStacksPlugin` ships an equivalent HMAC check, so this
 * exists for what that one cannot express. `WebhookSource.verify` returns a
 * bare boolean, which throws away two things the receiver half of the pstack
 * contract actually reports:
 *
 * - **why** a delivery was rejected (`stale timestamp` vs `signature
 *   mismatch`). Those have different causes — a clock skew is not an attack —
 *   and without the reason an operator debugging a 401 has nothing to go on.
 * - **`x-pstack-redelivery: 1`**, the header pstack sets when an operator
 *   replays a past delivery from the Notifiers page. Delivery is at-least-once
 *   and the envelope `id` is stable across retries, so a replay is legitimate
 *   traffic that is worth logging as such rather than looking like a duplicate.
 *
 * Keeping the plugin's `parseEventType` / `normalize` means rules still read
 * `ctx.event.data.pstackStack` exactly as before: only the verification step is
 * this service's, and it is the step the client package exists to own.
 */

import type { Logger, Plugin } from '@samyx/github-automation-suite';
import {
  createPreviewStacksSource,
  type PreviewStacksPluginOptions,
} from '@samyx/gha-plugin-preview-stacks';
import { verifyDelivery } from './client';

export interface PreviewStacksIngressOptions
  extends Pick<PreviewStacksPluginOptions, 'secret' | 'path' | 'toleranceMs'> {
  logger: Logger;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * A drop-in replacement for `previewStacksPlugin` whose `verify` is the
 * client's `verifyWebhook`.
 */
export function previewStacksIngress(
  options: PreviewStacksIngressOptions,
): Plugin {
  const path = options.path ?? '/webhooks/preview-stacks';
  // Built for its `parseEventType` / `normalize`; `verify` is replaced below,
  // so this instance's own signature check never runs.
  const base = createPreviewStacksSource({
    path,
    secret: options.secret,
    toleranceMs: options.toleranceMs,
    now: options.now,
  });

  return {
    name: 'preview-stacks',
    setup(registry) {
      registry.addSource({
        ...base,
        async verify(rawBody, headers) {
          const result = await verifyDelivery({
            secret: options.secret,
            rawBody,
            headers,
            toleranceMs: options.toleranceMs,
            now: options.now,
          });
          if (!result.ok) {
            options.logger.warn(
              { reason: result.reason, event: headers['x-pstack-event'] },
              'pstack: rejected a webhook delivery',
            );
            return false;
          }
          if (result.redelivery) {
            // Not a problem — the engine dedupes on the envelope id, which is
            // stable across a replay — but an operator replaying deliveries
            // wants to see that they arrived.
            options.logger.info(
              {
                event: headers['x-pstack-event'],
                delivery: headers['x-pstack-delivery'],
              },
              'pstack: accepted a replayed webhook delivery',
            );
          }
          return true;
        },
      });
    },
  };
}
