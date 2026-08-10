import { consoleLogger } from '@samyx/github-automation-suite';
import { createEventAutomationApp } from './app';
import { loadEnv } from './env';

const env = loadEnv();
const app = await createEventAutomationApp({ env, logger: consoleLogger });

consoleLogger.info(
  {
    port: env.port,
    repo: env.pstackRepo,
    services: [...env.pstackServices],
    pstack: env.pstackBaseUrl,
  },
  'event automation service listening',
);

export default {
  port: env.port,
  fetch: app.fetch,
};
