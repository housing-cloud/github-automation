#!/usr/bin/env node

/**
 * Thin launcher for `tsgo` from `@typescript/native-preview`.
 *
 * The upstream package renamed its entrypoint from `bin/tsgo.js` to `bin/tsgo`
 * partway through the 7.0.0-dev line, so both names are probed rather than
 * pinning the shim to whichever one today's catalog version happens to ship.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = dirname(
  require.resolve('@typescript/native-preview/package.json'),
);

const entrypoint = ['bin/tsgo.js', 'bin/tsgo']
  .map((candidate) => join(packageRoot, candidate))
  .find((candidate) => existsSync(candidate));

if (!entrypoint) {
  console.error(
    `tsgo: no bin/tsgo(.js) entrypoint found in ${packageRoot}. ` +
      'Reinstall @typescript/native-preview.',
  );
  process.exit(1);
}

await import(pathToFileURL(entrypoint).href);
