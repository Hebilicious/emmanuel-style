/**
 * Turning a codegen result into output and an exit code. `generate` logs to
 * stderr because it fails builds; `check` reports to stdout because it is a
 * read-only report.
 */

import { join } from 'node:path';
import {
  runtimeDirRelative,
  sortDiagnostics,
  toPosix,
  type CodegenResult,
  type Diagnostic,
  type DocumentExplanation,
  type ExplainResult,
  type FragmentDefinitionSite,
  type FragmentSpreadSite,
  type ReferencesResult,
  type ResolvedConfig,
} from '@flamme/core';

import { formatCliDiagnostics } from '../diagnostics-output.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import type { ResolvedIo } from '../io.js';

/** Which command is reporting; it decides the destination of the diagnostics. */
export type ReportMode = 'generate' | 'check';

/**
 * True when a diagnostic reports a failure to write the generated tree
 * (`FLM2003`). Such a run can leave a half-updated tree behind, so the summary
 * must not promise that nothing was written (A2).
 */
function isWriteFailure(diagnostic: Diagnostic): boolean {
  return diagnostic.code === 'FLM2003';
}

/** One diagnostic in the `--json` shape; `hint` is always present, `null` when absent. */
export interface JsonDiagnostic {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly hint: string | null;
}

/**
 * The one JSON value a `--json` run prints when it stops before it can report: the command line was
 * unusable, or the config or schema could not be loaded. It is deliberately not a diagnostic record:
 * a usage error has no file or position, and inventing one would break the location contract.
 */
export interface JsonFailure {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

/** One line of JSON carrying {@link JsonFailure}, ready for stdout. */
export function jsonFailure(code: string, message: string): string {
  const failure: JsonFailure = { error: { code, message } };
  return JSON.stringify(failure, null, 2);
}

/**
 * True when the diagnostics carry the schema load failure `FLM2002`, which is exit code `3`
 * whichever command reported it.
 */
export function hasSchemaFailure(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.code === 'FLM2002');
}

/** The one stderr line every human path prints for a schema failure, then returns `3`. */
export function reportSchemaFailure(io: ResolvedIo): ExitCode {
  io.stderr('flamme: the GraphQL schema could not be loaded (FLM2002).');
  return EXIT_CODES.schemaError;
}

/** Maps the diagnostics of one run to the machine-readable `--json` shape. */
export function jsonDiagnostics(diagnostics: readonly Diagnostic[]): readonly JsonDiagnostic[] {
  return sortDiagnostics(diagnostics).map((diagnostic) => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    file: diagnostic.location.file,
    line: diagnostic.location.line,
    column: diagnostic.location.column,
    hint: diagnostic.hint ?? null,
  }));
}

/**
 * The `check --json` report: one JSON array on stdout, nothing else, and the
 * same exit codes as the human format (schema failure `3`, any other error `1`).
 */
export function reportJson(result: CodegenResult, io: ResolvedIo): ExitCode {
  io.stdout(JSON.stringify(jsonDiagnostics(result.diagnostics), null, 2));
  if (hasSchemaFailure(result.diagnostics)) {
    return EXIT_CODES.schemaError;
  }
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return EXIT_CODES.compileError;
  }
  return EXIT_CODES.success;
}

/**
 * One `explain --json` report. `document` is `null` when the project has no such document (or when
 * it does not compile), which keeps every key present whichever way the run ends; `names` is the
 * same "did you mean" list the human output prints.
 */
export interface JsonExplanation {
  readonly document: DocumentExplanation | null;
  readonly names: readonly string[];
  readonly diagnostics: readonly JsonDiagnostic[];
}

/** Maps one `flamme explain` result to its `--json` report. */
export function jsonExplanation(result: ExplainResult): JsonExplanation {
  return {
    document: result.explanation ?? null,
    names: result.names,
    diagnostics: jsonDiagnostics(result.diagnostics),
  };
}

/** One `refs --json` report; `definition` is `null` when no document defines the fragment. */
export interface JsonReferences {
  readonly fragment: string;
  readonly definition: FragmentDefinitionSite | null;
  readonly references: readonly FragmentSpreadSite[];
  readonly diagnostics: readonly JsonDiagnostic[];
}

/** Maps one `flamme refs` result to its `--json` report. */
export function jsonReferences(result: ReferencesResult): JsonReferences {
  return {
    fragment: result.fragment,
    definition: result.definition ?? null,
    references: result.references,
    diagnostics: jsonDiagnostics(result.diagnostics),
  };
}

/**
 * Prints every diagnostic and returns the exit code: `3` for a schema failure
 * (`FLM2002`), `1` for any other error diagnostic, `0` otherwise. In `generate`
 * mode a clean run also lists the written files, unless `silent`.
 */
export function reportResult(
  result: CodegenResult,
  config: ResolvedConfig,
  io: ResolvedIo,
  mode: ReportMode,
  silent: boolean,
): ExitCode {
  const diagnostics = sortDiagnostics(result.diagnostics);
  const sink = mode === 'check' ? io.stdout : io.stderr;
  for (const line of formatCliDiagnostics(diagnostics)) {
    sink(line);
  }

  if (hasSchemaFailure(diagnostics)) {
    return reportSchemaFailure(io);
  }

  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  if (errors > 0) {
    // A write failure (`FLM2003`) may have rewritten part of the tree before it
    // failed, and an `afterEmit` failure is reported after the whole write, so only
    // a run that wrote nothing can say that "nothing was written".
    if (mode !== 'generate') {
      sink(`flamme: ${errors} error diagnostic(s).`);
    } else if (result.written.length > 0) {
      // The only hook after the write is `afterEmit`, so this failure must not read
      // like a run that never reached the emitter.
      sink(
        `flamme: ${errors} error diagnostic(s); the generated tree was written, but a plugin failed afterwards.`,
      );
    } else if (diagnostics.some(isWriteFailure)) {
      sink(`flamme: ${errors} error diagnostic(s); the generated tree may be incomplete.`);
    } else {
      sink(`flamme: ${errors} error diagnostic(s); nothing was written.`);
    }
    return EXIT_CODES.compileError;
  }

  if (mode === 'generate' && !silent) {
    const directory = runtimeDirRelative(config);
    for (const file of result.written) {
      io.stdout(toPosix(join(directory, file)));
    }
  }
  return EXIT_CODES.success;
}
