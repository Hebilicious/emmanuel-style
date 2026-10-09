/**
 * `flamme refs <Fragment>` (`research/answers-report.md` Q1): the reverse spread
 * index, the "go to references" an agent cannot get from an LSP.
 *
 * Read-only: it compiles the project, writes nothing, and prints every document
 * and position that spreads the fragment, plus where the fragment is defined.
 */

import { findReferences, type ReferencesResult } from '@flamme/core';

import { formatCliDiagnostics } from '../diagnostics-output.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { formatReferences } from '../inspect-output.js';
import type { ResolvedIo } from '../io.js';
import { loadProjectConfig } from './project.js';
import { hasSchemaFailure, jsonReferences, reportSchemaFailure } from './report.js';

/** Everything `refs` needs from the parsed command line. */
export interface RefsContext {
  /** Resolved output sinks and working directory. */
  readonly io: ResolvedIo;
  /** Explicit `--config` path, if any. */
  readonly configFile: string | undefined;
  /** The fragment name to find spreaders of. */
  readonly fragment: string;
  /** `--json`: one machine-readable report on stdout instead of the human text. */
  readonly json: boolean;
}

/**
 * The exit code both output modes share: a schema failure is `3` (the same code `check` returns for
 * `FLM2002`), any other error diagnostic is `1`, a project that compiled but defines no such
 * fragment is `2`, and a resolved fragment is `0`.
 */
function refsExitCode(result: ReferencesResult): ExitCode {
  if (hasSchemaFailure(result.diagnostics)) {
    return EXIT_CODES.schemaError;
  }
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return EXIT_CODES.compileError;
  }
  if (result.definition === undefined) {
    return EXIT_CODES.configError;
  }
  return EXIT_CODES.success;
}

/** Runs `flamme refs` and returns its exit code. */
export async function runRefs(context: RefsContext): Promise<ExitCode> {
  const config = await loadProjectConfig(context.io, context.configFile);
  const result = await findReferences(config, context.fragment);

  // `--json` prints one JSON object on stdout and nothing else; `definition: null` is how a caller
  // tells "no such fragment" from a parse failure, which is what the exit code `2` means.
  if (context.json) {
    context.io.stdout(JSON.stringify(jsonReferences(result), null, 2));
    return refsExitCode(result);
  }

  for (const diagnostic of formatCliDiagnostics(result.diagnostics)) {
    context.io.stdout(diagnostic);
  }
  if (hasSchemaFailure(result.diagnostics)) {
    return reportSchemaFailure(context.io);
  }
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    const errors = result.diagnostics.filter((entry) => entry.severity === 'error').length;
    context.io.stdout(`flamme: ${errors} error diagnostic(s).`);
    return EXIT_CODES.compileError;
  }

  if (result.definition === undefined) {
    context.io.stderr(`flamme: no fragment named "${context.fragment}".`);
    return EXIT_CODES.configError;
  }
  for (const text of formatReferences(result)) {
    context.io.stdout(text);
  }
  return EXIT_CODES.success;
}
