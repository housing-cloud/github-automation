/**
 * Tests for the pstack control-plane side: the live routing table that gives
 * the comment its real URLs, the readiness → signal projection the commands
 * settle checks with, and the client-backed webhook verification.
 *
 * The `Runtime` / `Readiness` fixtures are the shapes the pstack API documents
 * and the client's `.d.ts` declares, kept whole rather than reduced to the
 * fields under test, so a payload field that moves surfaces here.
 */

import { createHmac } from 'node:crypto';
import { noopLogger } from '@samyx/github-automation-suite';
import type { Readiness, Runtime } from '@samyx/preview-stacks-client';
import { describe, expect, it, vi } from 'vitest';
import {
  createPstackClient,
  readServiceUrls,
  serviceUrlsFromRuntime,
  signalFromJob,
  signalsFromReadiness,
  varsForPr,
  verifyDelivery,
} from './client';

function runtime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    stack: 'pr-16828',
    reachable: true,
    challenge: 'dns01',
    findings: [],
    containers: [
      {
        id: 'c1',
        name: 'pr-16828-web-1',
        service: 'web',
        image: 'web:pr',
        state: 'running',
        health: 'healthy',
        exitCode: null,
        restartCount: 0,
        networks: ['pstack'],
        ingressIp: '172.18.0.4',
        ports: [{ containerPort: 3000, protocol: 'tcp' }],
        traefikLabels: {},
      },
    ],
    routes: [
      {
        router: 'pr-16828-web',
        container: 'pr-16828-web-1',
        rule: 'Host(`web-pr-16828.preview.housing.cloud`)',
        hosts: ['web-pr-16828.preview.housing.cloud'],
        service: 'web',
        port: 3000,
        entrypoints: 'websecure',
        tls: true,
        certresolver: null,
        priority: null,
        target: null,
      },
    ],
    ...overrides,
  };
}

describe('serviceUrlsFromRuntime', () => {
  it('reads the public HTTPS URL Traefik actually serves', () => {
    expect(serviceUrlsFromRuntime(runtime()).get('web')).toEqual([
      'https://web-pr-16828.preview.housing.cloud',
    ]);
  });

  /**
   * The reason to read the routing table rather than rebuild the hostname: a
   * spec that sets its own router rule gets a hostname the
   * `<service>-<stack>.<domain>` pattern would never produce, and the
   * reconstructed link would be an authoritative-looking 404.
   */
  it('reports a custom router rule’s hostname, not the default pattern', () => {
    const urls = serviceUrlsFromRuntime(
      runtime({
        routes: [
          {
            router: 'pr-16828-app',
            container: 'pr-16828-web-1',
            rule: 'Host(`pr-16828.apps.housing.cloud`)',
            hosts: ['pr-16828.apps.housing.cloud'],
            service: 'web',
            port: 3000,
            entrypoints: 'websecure',
            tls: true,
            certresolver: null,
            priority: null,
            target: null,
          },
        ],
      }),
    );
    expect(urls.get('web')).toEqual(['https://pr-16828.apps.housing.cloud']);
  });

  it('recovers the service from the container when the route omits it', () => {
    const base = runtime();
    const urls = serviceUrlsFromRuntime({
      ...base,
      routes: [
        { ...(base.routes[0] as Runtime['routes'][number]), service: null },
      ],
    });
    expect(urls.get('web')).toEqual([
      'https://web-pr-16828.preview.housing.cloud',
    ]);
  });

  it('reports a non-TLS router honestly as http', () => {
    const base = runtime();
    const urls = serviceUrlsFromRuntime({
      ...base,
      routes: [
        { ...(base.routes[0] as Runtime['routes'][number]), tls: false },
      ],
    });
    expect(urls.get('web')).toEqual([
      'http://web-pr-16828.preview.housing.cloud',
    ]);
  });

  it('collects every hostname a service answers on, without duplicates', () => {
    const base = runtime();
    const route = base.routes[0] as Runtime['routes'][number];
    const urls = serviceUrlsFromRuntime({
      ...base,
      routes: [
        { ...route, hosts: ['web-pr-16828.preview.housing.cloud', 'alt.test'] },
        { ...route, router: 'dupe' },
      ],
    });
    expect(urls.get('web')).toEqual([
      'https://web-pr-16828.preview.housing.cloud',
      'https://alt.test',
    ]);
  });
});

describe('readServiceUrls', () => {
  function client(handler: (url: string) => Response) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      handler(String(input)),
    );
    return {
      client: createPstackClient({
        baseUrl: 'https://api.preview.housing.cloud',
        fetch: fetchMock as unknown as typeof fetch,
      }),
      fetchMock,
    };
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('sends the spec variables the stack name cannot be resolved without', async () => {
    const { client: c, fetchMock } = client(() => json(runtime()));
    await readServiceUrls(c, 'pr-16828', 16828, noopLogger);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.preview.housing.cloud/api/deployments/pr-16828/runtime?PR=16828',
    );
  });

  /**
   * `:id` is the registry id, and the stack name is all the reporter has. They
   * match by convention, so the fallback is only paid when they genuinely
   * differ.
   */
  it('falls back to the deployment whose resolved stack matches on a 404', async () => {
    const { client: c, fetchMock } = client((url) => {
      if (url.includes('/deployments/pr-16828/runtime'))
        return json({ error: 'unknown deployment' }, 404);
      if (url.includes('/deployments?'))
        return json({
          deployments: [
            {
              id: 'shopfront',
              stack: 'pr-16828',
              busy: false,
              running: true,
              kind: 'isolated',
            },
          ],
        });
      return json(runtime());
    });

    const urls = await readServiceUrls(c, 'pr-16828', 16828, noopLogger);
    expect(urls?.get('web')).toEqual([
      'https://web-pr-16828.preview.housing.cloud',
    ]);
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(
      '/api/deployments/shopfront/runtime',
    );
  });

  it('reports nothing rather than throwing when pstack is unreachable', async () => {
    const { client: c } = client(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      readServiceUrls(c, 'pr-16828', 16828, noopLogger),
    ).resolves.toBeUndefined();
  });
});

function readiness(overrides: Partial<Readiness> = {}): Readiness {
  return {
    stack: 'pr-16828',
    state: 'ready',
    startedAt: 1_000,
    endedAt: 5_000,
    reachable: true,
    timeoutMs: 180_000,
    containers: [
      {
        name: 'pr-16828-web-1',
        service: 'web',
        state: 'running',
        health: 'healthy',
        hasHealthcheck: true,
        exitCode: null,
        restartCount: 0,
        ready: true,
        failed: false,
      },
    ],
    ...overrides,
  };
}

describe('signalsFromReadiness', () => {
  it('projects a ready stack onto the same events the webhooks carry', () => {
    expect(signalsFromReadiness(readiness())).toEqual([
      {
        type: 'container.ready',
        stack: 'pr-16828',
        container: 'pr-16828-web-1',
        service: 'web',
        state: 'running',
        health: 'healthy',
        hasHealthcheck: true,
      },
      {
        type: 'stack.ready',
        stack: 'pr-16828',
        state: 'ready',
        containers: 1,
        readyCount: 1,
        failedContainers: [],
        pendingContainers: [],
        reachable: true,
        durationMs: 4_000,
      },
    ]);
  });

  it('carries a failing container’s reason through to the check', () => {
    const signals = signalsFromReadiness(
      readiness({
        state: 'failed',
        containers: [
          {
            name: 'pr-16828-web-1',
            service: 'web',
            state: 'exited',
            health: null,
            hasHealthcheck: false,
            exitCode: 1,
            restartCount: 0,
            ready: false,
            failed: true,
            reason: 'exited with code 1',
          },
        ],
      }),
    );
    expect(signals[0]).toMatchObject({
      type: 'container.start-failed',
      reason: 'exited with code 1',
      exitCode: 1,
    });
    expect(signals[1]).toMatchObject({
      type: 'stack.failed',
      failedContainers: ['pr-16828-web-1'],
    });
  });

  /**
   * A container that is neither ready nor failed was still converging when the
   * watch ended — which is exactly what `pendingContainers` means in a real
   * `stack.timedout` payload, and the only signal that names the culprit.
   */
  it('reports a still-converging container as pending on a timeout', () => {
    const signals = signalsFromReadiness(
      readiness({
        state: 'timedout',
        containers: [
          {
            name: 'pr-16828-web-1',
            service: 'web',
            state: 'running',
            health: 'starting',
            hasHealthcheck: true,
            exitCode: null,
            restartCount: 0,
            ready: false,
            failed: false,
          },
        ],
      }),
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      type: 'stack.timedout',
      pendingContainers: ['pr-16828-web-1'],
      readyCount: 0,
    });
  });

  it('preserves that an unprobed container was only running', () => {
    const signals = signalsFromReadiness(
      readiness({
        containers: [
          {
            name: 'pr-16828-db-seed-1',
            service: 'db-seed',
            state: 'exited',
            health: null,
            hasHealthcheck: false,
            exitCode: 0,
            restartCount: 0,
            ready: true,
            failed: false,
          },
        ],
      }),
    );
    expect(signals[0]).toMatchObject({ hasHealthcheck: false });
  });
});

describe('signalFromJob', () => {
  it('maps each non-ok job state onto its pstack event name', () => {
    for (const state of ['failed', 'leaked', 'cancelled'] as const) {
      expect(
        signalFromJob({
          id: 'j1',
          stack: 'pr-16828',
          action: 'up',
          state,
          startedAt: 0,
          endedAt: 2_000,
          error: 'boom',
        }),
      ).toMatchObject({
        type: `job.${state}`,
        error: 'boom',
        durationMs: 2_000,
      });
    }
  });
});

describe('varsForPr', () => {
  it('supplies the PR variable a templated stack name needs to resolve', () => {
    expect(varsForPr(16828)).toEqual({ PR: '16828' });
  });
});

describe('verifyDelivery', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({
    id: 'evt_1',
    event: 'stack.ready',
    at: 1,
    data: {},
  });

  function headers(
    timestamp: number,
    overrides: Record<string, string> = {},
    rawBody = body,
  ): Record<string, string> {
    return {
      'x-pstack-event': 'stack.ready',
      'x-pstack-timestamp': String(timestamp),
      'x-pstack-signature': `sha256=${createHmac('sha256', secret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex')}`,
      ...overrides,
    };
  }

  const bytes = (text: string) =>
    new TextEncoder().encode(text).buffer as ArrayBuffer;

  it('accepts a delivery signed over the raw bytes', async () => {
    const now = Date.now();
    await expect(
      verifyDelivery({
        secret,
        rawBody: bytes(body),
        headers: headers(now),
        now: () => now,
      }),
    ).resolves.toEqual({ ok: true, reason: undefined, redelivery: false });
  });

  it('rejects a forged signature', async () => {
    const now = Date.now();
    const result = await verifyDelivery({
      secret,
      rawBody: bytes(body),
      headers: headers(now, { 'x-pstack-signature': 'sha256=deadbeef' }),
      now: () => now,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature mismatch');
  });

  /**
   * The timestamp is inside the signed material, so a captured delivery cannot
   * claim a fresh one — which is what makes this check genuinely bound replay
   * rather than merely inconvenience it.
   */
  it('rejects a stale delivery and says why', async () => {
    const now = Date.now();
    const result = await verifyDelivery({
      secret,
      rawBody: bytes(body),
      headers: headers(now - 60 * 60_000),
      now: () => now,
    });
    expect(result).toMatchObject({ ok: false, reason: 'stale timestamp' });
  });

  it('reports an operator-replayed delivery as a redelivery', async () => {
    const now = Date.now();
    const result = await verifyDelivery({
      secret,
      rawBody: bytes(body),
      headers: headers(now, { 'x-pstack-redelivery': '1' }),
      now: () => now,
    });
    expect(result).toMatchObject({ ok: true, redelivery: true });
  });

  it('fails a body that was re-serialized rather than passed through', async () => {
    const now = Date.now();
    // The signature covers the exact bytes; re-stringifying changes them even
    // when the parsed value is identical.
    const reserialized = JSON.stringify(JSON.parse(body), null, 2);
    const result = await verifyDelivery({
      secret,
      rawBody: bytes(reserialized),
      headers: headers(now),
      now: () => now,
    });
    expect(result.ok).toBe(false);
  });
});
