/**
 * The body of the `flamme` executable, split out of `bin.ts` so tests can
 * call it in-process: run the CLI and print the exit code's message on failure.
 */

import { exitMessage, EXIT_CODES } from './exit-codes.js';
import { resolveIo, type CliIo } from './io.js';
import { main, type RunOptions } from './main.js';

/** Runs the CLI for a real process and returns the process exit code. */
export async function runBin(
  argv: readonly string[],
  io: CliIo = {},
  options: RunOptions = {},
): Promise<number> {
  const code = await main(argv, io, options);
  if (code !== EXIT_CODES.success) {
    resolveIo(io).stderr(exitMessage(code));
  }
  return code;
}
