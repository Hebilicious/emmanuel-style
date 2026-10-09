/**
 * Diagnostic types, error classes and the stable ordering helpers every part of
 * the compiler reports through (spec §4.9).
 */

import { compareNames } from './naming.js';

/** Severity of a compiler diagnostic (`spec/spec.md` §4.9). */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** A 1-based source position; `file` is a posix path relative to `projectDir`. */
export interface SourceLocation {
  /** Posix path relative to `projectDir`, or an absolute path when outside it. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number. */
  readonly column: number;
  /** Length of the offending text, in UTF-16 code units. */
  readonly length: number;
}

/** A secondary location attached to a diagnostic (`FLM1004`, `FLM1002`, …). */
export interface RelatedInformation {
  /** Human-readable explanation of the related location. */
  readonly message: string;
  /** Where the related information lives. */
  readonly location: SourceLocation;
}

/** One compiler diagnostic. `code` is always `FLM` plus a number. */
export interface Diagnostic {
  /** Stable diagnostic code, e.g. `FLM1001`. */
  readonly code: `FLM${number}`;
  /** Whether the diagnostic fails the build. */
  readonly severity: DiagnosticSeverity;
  /** The full, user-facing message. */
  readonly message: string;
  /** The primary source position. */
  readonly location: SourceLocation;
  /** Secondary positions (the other declaration, the other list, …). */
  readonly related?: readonly RelatedInformation[];
  /** Optional actionable hint appended to the message. */
  readonly hint?: string;
}

/** Thrown by `compileProject`/`validateProject` when an error diagnostic exists. */
export class CompileError extends Error {
  /** Every diagnostic collected before the throw, stable-sorted. */
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    const sorted = sortDiagnostics(diagnostics);
    super(formatDiagnostics(sorted));
    this.name = 'CompileError';
    this.diagnostics = sorted;
  }
}

/** Thrown for an unusable configuration or a failed `config` plugin hook (`FLM2001`, `FLM2002`, `FLM2004`, `FLM2005`). */
export class ConfigError extends Error {
  /** Stable error code. */
  readonly code: 'FLM2001' | 'FLM2002' | 'FLM2004' | 'FLM2005';

  constructor(code: 'FLM2001' | 'FLM2002' | 'FLM2004' | 'FLM2005', message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/** Thrown when the schema cannot be loaded, parsed or indexed (`FLM2002`). */
export class SchemaError extends Error {
  /** Stable error code. */
  readonly code = 'FLM2002' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** Thrown when the generated tree cannot be written (`FLM2003`). */
export class EmitError extends Error {
  /** Stable error code. */
  readonly code = 'FLM2003' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EmitError';
  }
}

/** Builds a diagnostic, keeping optional fields absent rather than `undefined`. */
export function createDiagnostic(input: {
  readonly code: `FLM${number}`;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly location: SourceLocation;
  readonly related?: readonly RelatedInformation[];
  readonly hint?: string;
}): Diagnostic {
  return {
    code: input.code,
    severity: input.severity,
    message: input.message,
    location: input.location,
    ...(input.related === undefined ? {} : { related: input.related }),
    ...(input.hint === undefined ? {} : { hint: input.hint }),
  };
}

/** The message of an unknown thrown value, without asserting it is an `Error`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when at least one diagnostic has `severity: 'error'`. */
export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

/** Stable-sorts diagnostics by `(file, line, column, code)` so CI output is diffable. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...diagnostics].toSorted(
    (a, b) =>
      compareNames(a.location.file, b.location.file) ||
      a.location.line - b.location.line ||
      a.location.column - b.location.column ||
      compareNames(a.code, b.code),
  );
}

/** One-line rendering used by `CompileError` and by the CLI. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const { file, line, column } = diagnostic.location;
  const hint = diagnostic.hint === undefined ? '' : `\n  hint: ${diagnostic.hint}`;
  const related = (diagnostic.related ?? [])
    .map((entry) => `\n  ${entry.message}`)
    .join('');
  return `${file}:${line}:${column} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${related}${hint}`;
}

/** Joins diagnostics into one multi-line string. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map(formatDiagnostic).join('\n');
}
