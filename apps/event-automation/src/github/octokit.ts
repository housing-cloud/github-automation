/**
 * Build the installation-scoped Octokit client the app shares between the
 * suite's GitHub plugin and the pstack reporter.
 *
 * The plugin can build its own from App credentials, but the reporter needs the
 * *same* authenticated client for endpoints the plugin does not expose (check
 * run updates, PR comments, PR head lookups). Building it here once and
 * injecting it into both keeps a single installation token in flight.
 */

import type { AppOctokit } from './checks';

export interface GithubAppCredentials {
  appId: string;
  privateKey: string;
  installationId: number;
}

export async function createOctokit(
  credentials: GithubAppCredentials,
): Promise<AppOctokit> {
  const { App } = await import('octokit');
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
  });
  return (await app.getInstallationOctokit(
    credentials.installationId,
  )) as unknown as AppOctokit;
}
