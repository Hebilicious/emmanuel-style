/**
 * `flamme explain <Document|--fragment Name>` (`research/answers-report.md` Q1):
 * the compiler's own view of one document as text.
 *
 * Read-only, like `check`: it compiles the project, writes nothing, prints the
 * diagnostics it found, and then either the explanation or a "no such document"
 * line naming what does exist.
 */

import { explainDocumentOf, type ExplainResult } from '@flamme/core';

import { formatCliDiagnostics } from '../diagnostics-output.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { formatExplanation } from '../inspect-output.js';
import type { ResolvedIo } from '../io.js';
import { loadProjectConfig } from './project.js';
import { hasSchemaFailure, jsonExplanation, reportSchemaFailure } from './report.js';

/** Everything `explain` needs from the parsed command line. */
export interface ExplainContext {
  /** Resolved output sinks and working directory. */
  readonly io: ResolvedIo;
  /** Explicit `--config` path, if any. */
  readonly configFile: string | undefined;
  /** Document name given positionally, or `undefined` with `--fragment`. */
  readonly document: string | undefined;
  /** Fragment name given through `--fragment`, or `undefined`. */
  readonly fragment: string | undefined;
  /** `--json`: one machine-readable report on stdout instead of the human text. */
  readonly json: boolean;
}

/**
 * The exit code both output modes share: a schema failure is `3` (the same code `check` returns for
 * `FLM2002`), any other error diagnostic is `1`, a project that compiled but has no such document is
 * `2`, and a reported document is `0`.
 */
function explainExitCode(result: ExplainResult): ExitCode {
  if (hasSchemaFailure(result.diagnostics)) {
    return EXIT_CODES.schemaError;
  }
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return EXIT_CODES.compileError;
  }
  if (result.explanation === undefined) {
    return EXIT_CODES.configError;
  }
  return EXIT_CODES.success;
}

/** Runs `flamme explain` and returns its exit code. */
export async function runExplain(context: ExplainContext): Promise<ExitCode> {
  const config = await loadProjectConfig(context.io, context.configFile);
  const name = context.fragment ?? context.document ?? '';
  const result = await explainDocumentOf(config, name, {
    fragment: context.fragment !== undefined,
  });

  // `--json` prints one JSON object on stdout and nothing else, so a caller parses one value
  // whichever way the run ends. The exit code carries the same meaning as the human path.
  if (context.json) {
    context.io.stdout(JSON.stringify(jsonExplanation(result), null, 2));
    return explainExitCode(result);
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

  if (result.explanation === undefined) {
    const what = context.fragment === undefined ? 'document' : 'fragment';
    context.io.stderr(`flamme: no ${what} named "${name}".`);
    context.io.stderr(`flamme: ${what}s: ${result.names.length === 0 ? '(none)' : result.names.join(', ')}`);
    return EXIT_CODES.configError;
  }
  for (const text of formatExplanation(result.explanation)) {
    context.io.stdout(text);
  }
  return EXIT_CODES.success;
}
