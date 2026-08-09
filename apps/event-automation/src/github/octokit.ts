/**
 * Build the installation-scoped Octokit client the app shares between the
 * suite's GitHub plugin and the preview tracker.
 *
 * The plugin can build its own from App credentials, but the tracker needs the
 * *same* authenticated client for endpoints the plugin does not expose (check
 * run updates, PR comments). Building it here once and injecting it into both
 * keeps a single installation token in flight instead of two.
 */

import type { TrackerOctokit } from './checks';

export interface GithubAppCredentials {
  appId: string;
  privateKey: string;
  installationId: number;
}

export async function createOctokit(
  credentials: GithubAppCredentials,
): Promise<TrackerOctokit> {
  const { App } = await import('octokit');
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
  });
  return (await app.getInstallationOctokit(
    credentials.installationId,
  )) as unknown as TrackerOctokit;
}
