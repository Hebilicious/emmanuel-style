/**
 * Diagnostic rendering for the CLI. The line format is the one `spec/spec.md`
 * §10.5 and §12.1 show: `file:line:col  FLMxxxx  message`, with the diagnostics
 * ordered exactly like a `CompileError` orders them.
 */

import { sortDiagnostics, type Diagnostic } from '@flamme/core';

/**
 * Renders one diagnostic as `file:line:col  FLMxxxx  message`.
 *
 * Core's `formatDiagnostic` adds the severity and a colon
 * (`file:line:col error FLM1005: …`); the CLI deliberately prints the spec's
 * terse form instead, and reports the severity through the exit code.
 */
export function formatCliDiagnostic(diagnostic: Diagnostic): string {
  const { file, line, column } = diagnostic.location;
  return `${file}:${line}:${column}  ${diagnostic.code}  ${diagnostic.message}`;
}

/** Renders diagnostics sorted by `(file, line, column, code)`. */
export function formatCliDiagnostics(diagnostics: readonly Diagnostic[]): readonly string[] {
  return sortDiagnostics(diagnostics).map(formatCliDiagnostic);
}
