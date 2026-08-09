import { describe, expect, it, vi } from 'vitest';
import { DokployClient, previewUrl } from './client';

/**
 * These tests pin the wire format the Dokploy instance actually serves:
 * tRPC-over-REST at `<base>/api/<router>.<action>`, `x-api-key` auth, queries
 * as `GET` with query-string input. Everything above this file mocks the
 * client, so this is the only place the HTTP contract is checked.
 */

interface Call {
  url: string;
  init: RequestInit;
}

function recordingFetch(response: unknown, status = 200) {
  const calls: Call[] = [];
  const impl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  );
  return { calls, impl: impl as unknown as typeof fetch };
}

function client(fetchImpl: typeof fetch) {
  return new DokployClient({
    baseUrl: 'https://dokploy.test/',
    apiKey: 'key-123',
    fetch: fetchImpl,
  });
}

describe('DokployClient', () => {
  it('lists preview deployments as a GET with the applicationId in the query', async () => {
    const { calls, impl } = recordingFetch([
      { previewDeploymentId: 'p1', pullRequestNumber: '7' },
    ]);

    const rows = await client(impl).listPreviewDeployments('app-1');

    expect(rows).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://dokploy.test/api/previewDeployment.all?applicationId=app-1',
    );
    expect(calls[0]?.init.method).toBe('GET');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('key-123');
  });

  it('trims a trailing slash off the base URL', async () => {
    const { calls, impl } = recordingFetch([]);
    await client(impl).listPreviewDeployments('app-1');
    expect(calls[0]?.url.startsWith('https://dokploy.test/api/')).toBe(true);
  });

  it('tolerates a non-array response', async () => {
    const { impl } = recordingFetch({ message: 'Unauthorized' });
    await expect(client(impl).listPreviewDeployments('app-1')).resolves.toEqual(
      [],
    );
  });

  it('throws with the status and body on a failed call', async () => {
    const { impl } = recordingFetch({ message: 'nope' }, 403);
    await expect(client(impl).listPreviewDeployments('app-1')).rejects.toThrow(
      /previewDeployment.all failed with 403/,
    );
  });

  it('redeploys a preview as a POST with a JSON body', async () => {
    const { calls, impl } = recordingFetch({ ok: true });
    await client(impl).redeployPreview('prev-9');
    expect(calls[0]?.url).toBe(
      'https://dokploy.test/api/previewDeployment.redeploy',
    );
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      previewDeploymentId: 'prev-9',
    });
  });

  it('builds the dashboard deep link from the application’s project + environment', async () => {
    const { impl } = recordingFetch({
      applicationId: 'app-1',
      environmentId: 'env-1',
      environment: { projectId: 'proj-1' },
    });

    await expect(client(impl).applicationUrl('app-1')).resolves.toBe(
      'https://dokploy.test/dashboard/project/proj-1/environment/env-1/services/application/app-1?tab=previewDeployments',
    );
  });

  it('caches the deep link so the 30s poll does not refetch it', async () => {
    const { calls, impl } = recordingFetch({
      environmentId: 'env-1',
      environment: { projectId: 'proj-1' },
    });

    const dokploy = client(impl);
    await dokploy.applicationUrl('app-1');
    await dokploy.applicationUrl('app-1');
    expect(calls).toHaveLength(1);
  });

  it('falls back to /dashboard when the deep link cannot be resolved', async () => {
    const { impl } = recordingFetch({ message: 'boom' }, 500);
    await expect(client(impl).applicationUrl('app-1')).resolves.toBe(
      'https://dokploy.test/dashboard',
    );
  });

  it('derives the preview URL from the domain, honouring https', () => {
    expect(
      previewUrl({ domain: { host: 'a.test', https: true } } as never),
    ).toBe('https://a.test');
    expect(
      previewUrl({ domain: { host: 'a.test', https: false } } as never),
    ).toBe('http://a.test');
    expect(previewUrl({ domain: null } as never)).toBeUndefined();
  });
});
