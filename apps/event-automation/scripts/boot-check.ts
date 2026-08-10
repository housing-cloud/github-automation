/**
 * Manual end-to-end boot check (not part of the vitest suite).
 *
 * Boots the real `createEventAutomationApp` on a real Bun HTTP server with a
 * fake GitHub client and a fake Dokploy instance, then drives it over real HTTP
 * to confirm the whole path works: webhook -> rule -> tracker -> check + comment.
 */
import { createHmac } from 'node:crypto';
import { createEventAutomationApp } from '../src/app';
import { loadEnv } from '../src/env';

const parsed = loadEnv({
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'x',
  GITHUB_APP_INSTALLATION_ID: '42',
  GITHUB_ORG: 'housing-cloud',
  GITHUB_ALLOWED_REPOS: 'repo-a',
  GITHUB_WEBHOOK_SECRET: 'gh-secret',
  DOKPLOY_BASE_URL: 'https://dokploy.test',
  DOKPLOY_API_KEY: 'k',
  DOKPLOY_WEBHOOK_TOKEN: 'dok-token',
  DOKPLOY_REPO_APPLICATION_MAP: 'repo-a:app-1:repo-a',
  PSTACK_WEBHOOK_SECRET: 'whsec_boot',
  PSTACK_REPO: 'repo-a',
  PSTACK_BASE_URL: 'https://pstack.test',
  PSTACK_PREVIEW_DOMAIN: 'preview.hou.test',
  PREVIEW_POLL_INTERVAL_MS: '1000',
  PREVIEW_TIMEOUT_MS: '8000',
  PORT: '8099',
} as NodeJS.ProcessEnv);

console.log('env OK:', parsed.dokployBaseUrl, [
  ...parsed.repoApplications.keys(),
]);

const octokit = {
  rest: {
    checks: {
      create: async (p: any) => {
        console.log('  CHECK create:', p.name, '|', p.status);
        return { data: { id: 1 } };
      },
      update: async (p: any) => {
        console.log(
          '  CHECK update:',
          p.status,
          '|',
          p.conclusion ?? '-',
          '|',
          p.output?.title ?? '',
        );
        return {};
      },
      listForRef: async () => ({ data: { check_runs: [] } }),
    },
    actions: { createWorkflowDispatch: async () => ({}) },
    repos: { createDispatchEvent: async () => ({}) },
    pulls: {
      get: async (p: any) => {
        console.log('  PR lookup: #' + p.pull_number, '-> head sha');
        return { data: { head: { sha: 'sha-of-pr-' + p.pull_number } } };
      },
    },
    issues: {
      listLabelsOnIssue: async () => ({ data: [] }),
      createComment: async (p: any) => {
        console.log('  COMMENT create on PR', p.issue_number);
        return { data: { id: 2 } };
      },
      updateComment: async (p: any) => {
        const line = String(p.body)
          .split('\n')
          .find((l: string) => l.includes('Status'));
        console.log('  COMMENT update:', line);
        const url = String(p.body)
          .split('\n')
          .find((l: string) => l.includes('Preview URL'));
        console.log('  COMMENT url   :', url);
        return {};
      },
      listComments: async () => ({ data: [] }),
    },
  },
};

let poll = 0;
const statuses = ['idle', 'running', 'done'];
const fakeFetch = async (url: any) => {
  const u = String(url);
  if (u.includes('previewDeployment.all')) {
    const s = statuses[Math.min(poll++, statuses.length - 1)];
    console.log('  dokploy poll ->', s);
    return new Response(
      JSON.stringify([
        {
          previewDeploymentId: 'p1',
          applicationId: 'app-1',
          appName: 'preview-xyz',
          branch: 'feature',
          pullRequestId: '1',
          pullRequestNumber: '3',
          pullRequestURL: 'u',
          pullRequestTitle: 't',
          previewStatus: s,
          createdAt: '2026-01-01',
          domain: { host: 'preview-xyz.hou.test', https: true },
        },
      ]),
      { status: 200 },
    );
  }
  if (u.includes('application.one')) {
    return new Response(
      JSON.stringify({
        environmentId: 'env-1',
        environment: { projectId: 'proj-1' },
      }),
      { status: 200 },
    );
  }
  return new Response('{}', { status: 200 });
};

const app = await createEventAutomationApp({
  env: parsed,
  octokit: octokit as any,
  fetch: fakeFetch as any,
});

const server = Bun.serve({ port: 8099, fetch: app.fetch });
console.log('server up on', server.port);

console.log(
  'GET /health ->',
  (await fetch('http://localhost:8099/health')).status,
);

const doc: any = await (
  await fetch('http://localhost:8099/discovery.json')
).json();
console.log(
  'routes:',
  doc.routes.map((r: any) => r.method + ' ' + r.path).join(', '),
);

const body = JSON.stringify({
  action: 'opened',
  number: 3,
  pull_request: {
    head: {
      sha: 'deadbeefcafe',
      ref: 'feature',
      repo: {
        full_name: 'housing-cloud/repo-a',
        name: 'repo-a',
        owner: { login: 'housing-cloud' },
      },
    },
    base: { ref: 'main' },
    labels: [],
  },
  repository: {
    name: 'repo-a',
    full_name: 'housing-cloud/repo-a',
    owner: { login: 'housing-cloud' },
  },
});
const sig =
  'sha256=' + createHmac('sha256', 'gh-secret').update(body).digest('hex');
const res = await fetch('http://localhost:8099/webhooks/github', {
  method: 'POST',
  headers: {
    'x-github-event': 'pull_request',
    'x-github-delivery': 'd1',
    'x-hub-signature-256': sig,
    'content-type': 'application/json',
  },
  body,
});
console.log('POST /webhooks/github ->', res.status);

await new Promise((r) => setTimeout(r, 500));
console.log(
  'GET /previews ->',
  await (await fetch('http://localhost:8099/previews')).text(),
);

await new Promise((r) => setTimeout(r, 4000));
console.log(
  'GET /previews (settled) ->',
  await (await fetch('http://localhost:8099/previews')).text(),
);

const dokBody = JSON.stringify({
  title: 'Build Success',
  status: 'success',
  type: 'build',
  projectName: 'hou',
  applicationName: 'repo-a',
  buildLink: 'x',
  timestamp: 't',
});
console.log(
  'POST /webhooks/dokploy ->',
  (
    await fetch('http://localhost:8099/webhooks/dokploy', {
      method: 'POST',
      headers: {
        'x-webhook-token': 'dok-token',
        'content-type': 'application/json',
      },
      body: dokBody,
    })
  ).status,
);
console.log(
  'POST /webhooks/dokploy (bad token) ->',
  (
    await fetch('http://localhost:8099/webhooks/dokploy', {
      method: 'POST',
      headers: {
        'x-webhook-token': 'nope',
        'content-type': 'application/json',
      },
      body: dokBody,
    })
  ).status,
);

// ── pstack: the real captured sequence, over real signed HTTP ───────────────
console.log('\n--- pstack (preview-stacks) ---');

async function postPstack(event: string, data: unknown) {
  const at = Date.now();
  const envelope = JSON.stringify({
    id: `evt_${event}_${at}`,
    event,
    at,
    data,
  });
  const signature =
    'sha256=' +
    createHmac('sha256', 'whsec_boot')
      .update(`${at}.${envelope}`)
      .digest('hex');
  const res = await fetch('http://localhost:8099/webhooks/preview-stacks', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pstack-event': event,
      'x-pstack-delivery': `evt_${event}_${at}`,
      'x-pstack-timestamp': String(at),
      'x-pstack-signature': signature,
    },
    body: envelope,
  });
  console.log(`POST /webhooks/preview-stacks [${event}] ->`, res.status);
  await new Promise((r) => setTimeout(r, 120));
}

// The exact payloads captured from the live instance (stack pr-16828).
await postPstack('job.started', {
  jobId: 'up-pr-16828-1-j5cfw8',
  stack: 'pr-16828',
  action: 'up',
  startedAt: 1786378437511,
});
await postPstack('container.ready', {
  stack: 'pr-16828',
  container: 'pr-16828-db-seed-1',
  service: 'db-seed',
  state: 'exited',
  health: null,
  hasHealthcheck: false,
});
await postPstack('stack.timedout', {
  stack: 'pr-16828',
  state: 'timedout',
  containers: 4,
  ready: 3,
  failedContainers: [],
  pendingContainers: ['pr-16828-web-1'],
  durationMs: 181738,
  reachable: true,
});

// A bad signature must be rejected before any rule runs.
const badSig = await fetch('http://localhost:8099/webhooks/preview-stacks', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-pstack-event': 'stack.ready',
    'x-pstack-delivery': 'evt_forged',
    'x-pstack-timestamp': String(Date.now()),
    'x-pstack-signature': 'sha256=deadbeef',
  },
  body: JSON.stringify({
    id: 'evt_forged',
    event: 'stack.ready',
    at: Date.now(),
    data: { stack: 'pr-16828' },
  }),
});
console.log('POST /webhooks/preview-stacks (forged) ->', badSig.status);

console.log(
  'GET /previews ->',
  await (await fetch('http://localhost:8099/previews')).text(),
);

server.stop(true);
process.exit(0);
