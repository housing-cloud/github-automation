/**
 * Manual end-to-end boot check (not part of the vitest suite).
 *
 * Boots the real `createEventAutomationApp` on a real Bun HTTP server with a
 * fake GitHub client, then drives it over real HTTP to confirm the whole path
 * works: signed pstack webhook -> rule -> reporter -> check runs + PR comment.
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
  PSTACK_WEBHOOK_SECRET: 'whsec_boot',
  PSTACK_REPO: 'repo-a',
  PSTACK_BASE_URL: 'https://pstack.test',
  PSTACK_PREVIEW_DOMAIN: 'preview.hou.test',
  PORT: '8099',
} as NodeJS.ProcessEnv);

console.log('env OK:', parsed.pstackRepo, [...parsed.pstackServices]);

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
        const status = String(p.body)
          .split('\n')
          .find((l: string) => l.includes('Status'));
        console.log('  COMMENT update:', status);
        return {};
      },
      listComments: async () => ({ data: [] }),
    },
  },
};

const app = await createEventAutomationApp({
  env: parsed,
  octokit: octokit as any,
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

// ── GitHub: closing the PR releases the stack's in-memory state ─────────────
console.log('\n--- github ---');

const prBody = JSON.stringify({
  action: 'closed',
  number: 16828,
  pull_request: {
    number: 16828,
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
  'sha256=' + createHmac('sha256', 'gh-secret').update(prBody).digest('hex');
const closed = await fetch('http://localhost:8099/webhooks/github', {
  method: 'POST',
  headers: {
    'x-github-event': 'pull_request',
    'x-github-delivery': 'd-close',
    'x-hub-signature-256': sig,
    'content-type': 'application/json',
  },
  body: prBody,
});
console.log('POST /webhooks/github [closed] ->', closed.status);
await new Promise((r) => setTimeout(r, 150));
console.log(
  'GET /previews (after close) ->',
  await (await fetch('http://localhost:8099/previews')).text(),
);

// The Dokploy ingress is gone.
console.log(
  'POST /webhooks/dokploy ->',
  (
    await fetch('http://localhost:8099/webhooks/dokploy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  ).status,
  '(expected 404)',
);

server.stop(true);
process.exit(0);
