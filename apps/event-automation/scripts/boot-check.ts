/**
 * Manual end-to-end boot check (not part of the vitest suite).
 *
 * Boots the real `createEventAutomation` on a real Bun HTTP server with a
 * fake GitHub client, then drives it over real HTTP to confirm the whole path
 * works: signed pstack webhook -> rule -> reporter -> check runs + PR comment.
 */
import { createHmac } from 'node:crypto';
import { createEventAutomation } from '../src/app';
import { loadEnv } from '../src/env';

const parsed = loadEnv({
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'x',
  GITHUB_APP_INSTALLATION_ID: '42',
  GITHUB_ORG: 'housing-cloud',
  GITHUB_ALLOWED_REPOS: 'repo-a',
  GITHUB_WEBHOOK_SECRET: 'gh-secret',
  PSTACK_WEBHOOK_SECRET: 'whsec_boot',
  PSTACK_CHECKS_WEBHOOK_SECRET: 'checks-secret',
  PSTACK_REPO: 'repo-a',
  PSTACK_BASE_URL: 'https://pstack.test',
  PSTACK_PREVIEW_DOMAIN: 'preview.hou.test',
  FLOW_RUN_DB_PATH: ':memory:',
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
      list: async () => ({ data: [] }),
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

const automation = await createEventAutomation({
  env: parsed,
  octokit: octokit as any,
});
const { app } = automation;

const server = Bun.serve({ port: 8099, fetch: app.fetch });
console.log('server up on', server.port);

console.log(
  'GET /health ->',
  (await fetch('http://localhost:8099/health')).status,
);
console.log(
  'GET /dashboard/api/flow-runs ->',
  await (await fetch('http://localhost:8099/dashboard/api/flow-runs')).text(),
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
await postPstack('job.succeeded', {
  jobId: 'up-pr-16828-2-zhhhxy',
  stack: 'pr-16828',
  action: 'up',
  state: 'ok',
  startedAt: 1786404404604,
  endedAt: 1786405882579,
  durationMs: 1477975,
  leakedAxes: [],
  verified: null,
  unverifiable: 0,
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
await automation.dispose();

// ── @cloudybot commands, against a stub pstack API over real HTTP ──────────
//
// A second instance, because the commands only exist when PSTACK_API_URL is
// set. Everything here is real except pstack itself and GitHub: a signed
// GitHub webhook goes in, and the pstack API calls plus check runs come out.
console.log('\n--- @cloudybot commands ---');

const pstackCalls: string[] = [];
const pstackApi = Bun.serve({
  port: 8098,
  fetch(request) {
    const url = new URL(request.url);
    pstackCalls.push(`${request.method} ${url.pathname}`);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/api/deployments') {
      return json({
        deployments: [
          {
            id: 'pr-16828',
            stack: 'pr-16828',
            kind: 'isolated',
            busy: false,
            running: true,
          },
        ],
      });
    }
    if (url.pathname.endsWith('/up')) {
      return json({
        job: {
          id: 'job-boot',
          stack: 'pr-16828',
          action: 'up',
          state: 'running',
          startedAt: 0,
        },
      });
    }
    if (url.pathname.startsWith('/api/jobs/')) {
      return json({
        job: {
          id: 'job-boot',
          stack: 'pr-16828',
          action: 'up',
          state: 'ok',
          startedAt: 0,
          endedAt: 1000,
        },
      });
    }
    if (url.pathname.endsWith('/restart')) {
      return json({
        container: 'pr-16828-web-1',
        action: 'restart',
        note: 'ok',
      });
    }
    if (url.pathname.endsWith('/runtime')) {
      return json({
        stack: 'pr-16828',
        reachable: true,
        challenge: 'dns01',
        findings: [],
        containers: [
          {
            id: 'c1',
            name: 'pr-16828-web-1',
            service: 'web',
            image: 'web',
            state: 'running',
            health: 'healthy',
            exitCode: null,
            restartCount: 0,
            networks: [],
            ingressIp: null,
            ports: [],
            traefikLabels: {},
          },
        ],
        routes: [
          {
            router: 'r-web',
            container: 'pr-16828-web-1',
            rule: 'Host(`shop-pr-16828.hou.test`)',
            hosts: ['shop-pr-16828.hou.test'],
            service: 'web',
            port: 3000,
            entrypoints: 'websecure',
            tls: true,
            certresolver: null,
            priority: null,
            target: null,
          },
        ],
      });
    }
    if (url.pathname.endsWith('/readiness')) {
      return json({
        id: 'pr-16828',
        stack: 'pr-16828',
        state: 'ready',
        startedAt: 0,
        endedAt: 2000,
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
      });
    }
    return new Response('{}', { status: 404 });
  },
});

const commandEnv = loadEnv({
  GITHUB_APP_ID: '1',
  GITHUB_APP_PRIVATE_KEY: 'x',
  GITHUB_APP_INSTALLATION_ID: '42',
  GITHUB_ORG: 'housing-cloud',
  GITHUB_ALLOWED_REPOS: 'repo-a',
  GITHUB_WEBHOOK_SECRET: 'gh-secret',
  PSTACK_WEBHOOK_SECRET: 'whsec_boot',
  PSTACK_CHECKS_WEBHOOK_SECRET: 'checks-secret',
  PSTACK_REPO: 'repo-a',
  PSTACK_PREVIEW_DOMAIN: 'preview.hou.test',
  PSTACK_API_URL: `http://localhost:${pstackApi.port}`,
  PSTACK_API_TOKEN: 'pstack_pat_boot',
  FLOW_RUN_DB_PATH: ':memory:',
  PORT: '8097',
} as NodeJS.ProcessEnv);

const removedLabels: string[] = [];
const commandOctokit = {
  rest: {
    ...octokit.rest,
    issues: {
      ...octokit.rest.issues,
      removeLabel: async (p: any) => {
        removedLabels.push(p.name);
        console.log('  LABEL remove:', p.name);
        return {};
      },
      createComment: async (p: any) => {
        const kind = String(p.body).includes('Preview stack bot')
          ? 'help'
          : 'status';
        console.log(`  COMMENT create (${kind}) on PR`, p.issue_number);
        return { data: { id: 3 } };
      },
    },
  },
};

const commandApp = await createEventAutomation({
  env: commandEnv,
  octokit: commandOctokit as any,
  // Without this the reporter and the command runner log to `noopLogger`, and a
  // command that failed would look identical to one that worked.
  logger: {
    trace: () => {},
    debug: (v: any, m?: string) => console.log('  debug:', m ?? '', v),
    info: (v: any, m?: string) => console.log('  info:', m ?? '', v),
    warn: (v: any, m?: string) => console.log('  warn:', m ?? '', v),
    error: (v: any, m?: string) => console.log('  ERROR:', m ?? '', v),
  },
});
const commandServer = Bun.serve({ port: 8097, fetch: commandApp.app.fetch });
console.log('commands enabled:', commandApp.commands !== undefined);

async function postGithub(event: string, body: string, delivery: string) {
  const res = await fetch('http://localhost:8097/webhooks/github', {
    method: 'POST',
    headers: {
      'x-github-event': event,
      'x-github-delivery': delivery,
      'content-type': 'application/json',
      'x-hub-signature-256':
        'sha256=' +
        createHmac('sha256', 'gh-secret').update(body).digest('hex'),
    },
    body,
  });
  console.log(`POST /webhooks/github [${event}] ->`, res.status);
  // The command runs detached; drain it rather than sleeping on a guess.
  await commandApp.commands?.drain();
}

await postGithub(
  'issue_comment',
  JSON.stringify({
    action: 'created',
    issue: { number: 16828, pull_request: { url: 'x' } },
    comment: {
      id: 1,
      body: '@cloudybot redeploy',
      user: { login: 'alice', type: 'User' },
    },
    repository: {
      name: 'repo-a',
      full_name: 'housing-cloud/repo-a',
      owner: { login: 'housing-cloud' },
    },
  }),
  'd-comment-cmd',
);

await postGithub(
  'pull_request',
  JSON.stringify({
    action: 'labeled',
    number: 16828,
    label: { name: 'cloudy-restart' },
    sender: { login: 'alice' },
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
      labels: [{ name: 'cloudy-restart' }],
    },
    repository: {
      name: 'repo-a',
      full_name: 'housing-cloud/repo-a',
      owner: { login: 'housing-cloud' },
    },
  }),
  'd-label-cmd',
);

console.log('pstack API calls:', pstackCalls.join(', '));
console.log('labels removed:', removedLabels.join(', ') || '(none)');

commandServer.stop(true);
pstackApi.stop(true);
await commandApp.dispose();

// ── PR_OPENED_COMMENT: the preview-labels explainer ────────────────────────
console.log('\n--- PR opened explainer ---');

const openedComments: string[] = [];
const openedOctokit = {
  rest: {
    ...octokit.rest,
    issues: {
      ...octokit.rest.issues,
      createComment: async (p: any) => {
        openedComments.push(String(p.body));
        console.log('  COMMENT create on PR', p.issue_number);
        return { data: { id: 9 } };
      },
    },
  },
};

const openedApp = await createEventAutomation({
  env: loadEnv({
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'x',
    GITHUB_APP_INSTALLATION_ID: '42',
    GITHUB_ORG: 'housing-cloud',
    GITHUB_ALLOWED_REPOS: 'repo-a',
    GITHUB_WEBHOOK_SECRET: 'gh-secret',
    PSTACK_WEBHOOK_SECRET: 'whsec_boot',
    PSTACK_CHECKS_WEBHOOK_SECRET: 'checks-secret',
    PSTACK_REPO: 'repo-a',
    PSTACK_BASE_URL: 'https://pstack.test',
    PR_OPENED_COMMENT: 'true',
    FLOW_RUN_DB_PATH: ':memory:',
    PORT: '8096',
  } as NodeJS.ProcessEnv),
  octokit: openedOctokit as any,
});
const openedServer = Bun.serve({ port: 8096, fetch: openedApp.app.fetch });

const openedBody = JSON.stringify({
  action: 'opened',
  number: 4242,
  pull_request: {
    number: 4242,
    head: {
      sha: 'abc1234567890',
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
const opened = await fetch('http://localhost:8096/webhooks/github', {
  method: 'POST',
  headers: {
    'x-github-event': 'pull_request',
    'x-github-delivery': 'd-opened',
    'content-type': 'application/json',
    'x-hub-signature-256':
      'sha256=' +
      createHmac('sha256', 'gh-secret').update(openedBody).digest('hex'),
  },
  body: openedBody,
});
console.log('POST /webhooks/github [opened] ->', opened.status);
await new Promise((r) => setTimeout(r, 150));

const explainer = openedComments[0] ?? '';
console.log(
  'labels explained:',
  ['preview', 'no-preview', 'preserve-preview']
    .filter((label) => explainer.includes('`' + label + '`'))
    .join(', ') || '(none)',
);

openedServer.stop(true);
await openedApp.dispose();
