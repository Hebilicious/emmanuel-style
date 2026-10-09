/**
 * The CLI entry point: parse argv, dispatch to a command, and turn every
 * expected failure into one clear line plus an exit code. Only exit code `4`
 * (an internal error) is allowed to print a stack trace.
 */

import { CompileError, ConfigError, SchemaError } from '@flamme/core';

import { parseArgs, usageLines, type CommandName, type ParsedArgs } from './args.js';
import { runCheck } from './commands/check.js';
import { runExplain } from './commands/explain.js';
import { runGenerate } from './commands/generate.js';
import { runInit } from './commands/init.js';
import { runRefs } from './commands/refs.js';
import { jsonDiagnostics, jsonFailure } from './commands/report.js';
import { formatCliDiagnostics } from './diagnostics-output.js';
import { errorText } from './errors.js';
import { EXIT_CODES, type ExitCode } from './exit-codes.js';
import { resolveIo, type CliIo, type ResolvedIo } from './io.js';
import { cliVersion } from './version.js';

/** Optional behaviour of a run; currently only the `--watch` abort seam. */
export interface RunOptions {
  /** Aborts a `--watch` session, which then settles with the last exit code. */
  readonly signal?: AbortSignal | undefined;
}

/** Prints the `--help`/usage text for a command (or for the whole CLI). */
function printUsage(write: (line: string) => void, command: CommandName | undefined): void {
  for (const line of usageLines(command)) {
    write(line);
  }
}

/**
 * Maps a thrown error to its exit code. `CompileError` and the config errors
 * print one clear line; anything else is an internal error and prints its stack.
 *
 * With `json` (the invocation asked for `--json`), a failure that stops the run
 * before it can report also prints exactly one JSON value on stdout: the
 * diagnostics array for a compile error, and {@link jsonFailure} for a config or
 * schema error. The human line stays on stderr, so the two channels keep their
 * jobs and stdout stays parseable whichever way the run ends.
 */
export function reportFailure(error: unknown, io: ResolvedIo, json = false): ExitCode {
  if (error instanceof CompileError) {
    if (json) {
      io.stdout(JSON.stringify(jsonDiagnostics(error.diagnostics), null, 2));
    }
    for (const line of formatCliDiagnostics(error.diagnostics)) {
      io.stderr(line);
    }
    const errors = error.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
    io.stderr(`flamme: ${errors} error diagnostic(s); nothing was written.`);
    return EXIT_CODES.compileError;
  }
  if (error instanceof ConfigError) {
    if (json) {
      io.stdout(jsonFailure(error.code, error.message));
    }
    io.stderr(`flamme: ${error.code}: ${error.message}`);
    return error.code === 'FLM2002' ? EXIT_CODES.schemaError : EXIT_CODES.configError;
  }
  if (error instanceof SchemaError) {
    if (json) {
      io.stdout(jsonFailure('FLM2002', error.message));
    }
    io.stderr(`flamme: FLM2002: ${error.message}`);
    return EXIT_CODES.schemaError;
  }
  io.stderr(`flamme: internal error: ${errorText(error)}`);
  io.stderr(error instanceof Error && error.stack !== undefined ? error.stack : String(error));
  return EXIT_CODES.internalError;
}

/** True when a parsed command carries the `--json` flag (only check/explain/refs accept it). */
function wantsJson(args: ParsedArgs): boolean {
  if (args.command === 'check' || args.command === 'explain' || args.command === 'refs') {
    return args.json;
  }
  return false;
}

/** Runs one parsed command, mapping expected failures to exit codes. */
async function dispatch(args: ParsedArgs, io: ResolvedIo, options: RunOptions): Promise<ExitCode> {
  try {
    if (args.command === 'generate') {
      return await runGenerate({
        io,
        configFile: args.configFile,
        watch: args.watch,
        force: args.force,
        silent: args.silent,
        persisted: args.persisted,
        signal: options.signal,
      });
    }
    if (args.command === 'check') {
      return await runCheck({
        io,
        configFile: args.configFile,
        json: args.json,
        persisted: args.persisted,
      });
    }
    if (args.command === 'explain') {
      return await runExplain({
        io,
        configFile: args.configFile,
        document: args.document,
        fragment: args.fragment,
        json: args.json,
      });
    }
    if (args.command === 'refs') {
      return await runRefs({
        io,
        configFile: args.configFile,
        fragment: args.fragment,
        json: args.json,
      });
    }
    return await runInit({ io, dryRun: args.dryRun });
  } catch (error) {
    return reportFailure(error, io, wantsJson(args));
  }
}

/** Parses argv (without `node` and the script path) and runs the command. */
export async function main(
  argv: readonly string[],
  io: CliIo = {},
  options: RunOptions = {},
): Promise<ExitCode> {
  const resolved = resolveIo(io);
  try {
    const parsed = parseArgs(argv);
    if (parsed.kind === 'help') {
      printUsage(resolved.stdout, parsed.command);
      return EXIT_CODES.success;
    }
    if (parsed.kind === 'version') {
      resolved.stdout(cliVersion());
      return EXIT_CODES.success;
    }
    if (parsed.kind === 'usage-error') {
      // A caller that asked for `--json` gets one JSON error value on stdout even for a usage
      // error; the usage text stays on stderr, and a line that was malformed before the flag was
      // reached (the parser stops at the first bad token) keeps stdout empty.
      if (parsed.json) {
        resolved.stdout(jsonFailure('FLM2001', parsed.message));
      }
      resolved.stderr(parsed.message);
      printUsage(resolved.stderr, parsed.command);
      return EXIT_CODES.configError;
    }
    return await dispatch(parsed.args, resolved, options);
  } catch (error) {
    return reportFailure(error, resolved);
  }
}

/** Programmatic alias of {@link main}, used by tests and embedders. */
export const run = main;
