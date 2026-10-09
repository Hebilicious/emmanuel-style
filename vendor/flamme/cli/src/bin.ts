#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runBin } from './bin-main.js';
import { ignoreBrokenPipes } from './pipe.js';

// Run only when this file is the process entry point, so importing the shim
// (tests, embedders) is side-effect free. `realpathSync` keeps the comparison
// true when the executable is reached through a `node_modules/.bin` symlink.
const invoked = process.argv[1];
if (invoked !== undefined && realpathSync(invoked) === fileURLToPath(import.meta.url)) {
  // `flamme generate | head -1` closes stdout early; that must end the
  // pipeline at exit 0, not as an unhandled EPIPE with a stack (A5).
  ignoreBrokenPipes();
  process.exitCode = await runBin(process.argv.slice(2));
}
