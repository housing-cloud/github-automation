import { consoleLogger } from '@samyx/github-automation-suite';
import { createEventAutomation } from './app';
import { loadEnv } from './env';

const env = loadEnv();
const automation = await createEventAutomation({
  env,
  logger: consoleLogger,
});
const { app } = automation;

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  consoleLogger.info({ signal }, 'event automation service stopping');
  try {
    await automation.dispose();
    process.exit(0);
  } catch (error) {
    consoleLogger.error({ signal, error }, 'graceful shutdown failed');
    process.exit(1);
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

consoleLogger.info(
  {
    port: env.port,
    repo: env.pstackRepo,
    services: [...env.pstackServices],
    pstack: env.pstackBaseUrl,
    flowRuns: env.flowRunDbPath,
  },
  'event automation service listening',
);

export default {
  port: env.port,
  fetch: app.fetch,
};
