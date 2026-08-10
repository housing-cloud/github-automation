import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envSchema, loadEnv } from './env';

/**
 * Guards `.env.example` against drift.
 *
 * A stale example is worse than none: it is the first thing an operator copies,
 * and a missing key surfaces as a startup crash in production rather than at
 * review time. So the example is parsed as a real environment and fed through
 * the real `loadEnv`.
 */

const examplePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.env.example',
);

const readExample = () => readFileSync(examplePath, 'utf8');

/** Minimal dotenv reader: `KEY=value`, optional quotes, `#` comments. */
function parseDotenv(text: string): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env as NodeJS.ProcessEnv;
}

describe('.env.example', () => {
  it('exists', () => {
    expect(existsSync(examplePath)).toBe(true);
  });

  it('boots the real env loader with only its uncommented values', () => {
    const text = readExample();
    const env = loadEnv(parseDotenv(text));

    expect(env.githubOrg).toBe('housing-cloud');
    expect(env.dokployBaseUrl).toBe('https://dokploy.housing.cloud');
    // Every repo in the application map must be an allowed repo — loadEnv
    // enforces this, so reaching here proves the example is self-consistent.
    expect([...env.repoApplications.keys()]).toEqual(['web', 'api']);
    expect(env.repoApplications.get('web')).toEqual({
      applicationId: 'kZ8sq2Lm-abc',
      name: 'web-app',
    });
    // Commented-out optionals fall back to their documented defaults.
    expect(env.previewPollIntervalMs).toBe(30_000);
    expect(env.previewTimeoutMs).toBe(30 * 60_000);
    expect(env.port).toBe(8080);
  });

  it('decodes the escaped-newline private key example', () => {
    const text = readExample();
    expect(loadEnv(parseDotenv(text)).githubAppPrivateKey).toContain(
      '-----BEGIN RSA PRIVATE KEY-----\n',
    );
  });

  it('documents every variable the loader reads', () => {
    const text = readExample();
    const documented = new Set(
      [...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(
        (match) => match[1] as string,
      ),
    );
    // Derived from the schema rather than a hand-kept list, so a variable added
    // to the loader cannot be forgotten here.
    for (const key of Object.keys(envSchema.shape)) {
      expect(documented).toContain(key);
    }
  });

  it('carries no leftover Vercel configuration', () => {
    const text = readExample();
    expect(text).not.toContain('VERCEL');
  });
});
