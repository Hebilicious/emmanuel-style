/**
 * `@flamme/cli` — the codegen CLI (`spec/spec.md` §10.5): `generate`,
 * `check` and `init` over `@flamme/core`.
 *
 * The executable is `dist/bin.js` (see `package.json#bin`); embedders and tests
 * use {@link run}. Every name re-exported here documents itself at its
 * declaration site.
 */

export { EXIT_CODES, exitMessage, type ExitCode } from './exit-codes.js';
export {
  parseArgs,
  type CheckArgs,
  type CommandName,
  type ExplainArgs,
  type GenerateArgs,
  type InitArgs,
  type ParseResult,
  type ParsedArgs,
  type RefsArgs,
} from './args.js';
export { main, run, type RunOptions } from './main.js';
export type { CliIo } from './io.js';
export { formatCliDiagnostic, formatCliDiagnostics } from './diagnostics-output.js';
export { formatExplanation, formatReferences } from './inspect-output.js';
export { jsonDiagnostics, type JsonDiagnostic } from './commands/report.js';
export { createPipelineLock, type PipelineLock } from './pipeline.js';
export {
  WATCH_DEBOUNCE_MS,
  watchDirectory,
  type WatchFactory,
  type WatchHandle,
  type WatchOptions,
  type WatchSession,
} from './watch.js';
export { cliVersion } from './version.js';
