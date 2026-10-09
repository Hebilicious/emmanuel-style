/**
 * Offset arithmetic, isolated in one module so every other module works in
 * absolute file offsets and never re-derives line/column itself
 * (`research/extraction-and-vite.md` A.1).
 */

import type { SourceLocation } from './diagnostics.js';

export type { SourceLocation };

/** Converts a possibly-win32 path to posix separators. */
export function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * Offsets of every line start, with a leading `0`. `lineIndex[i]` is the offset
 * of line `i + 1`; the array is sorted ascending so lookups can binary-search.
 */
export function buildLineIndex(text: string): readonly number[] {
  const starts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // LF, CRLF and a lone CR are all line terminators (JavaScript and GraphQL
    // agree on this), so a file saved with classic-Mac endings still reports the
    // line the token is on (F2).
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) {
        index += 1;
      }
      starts.push(index + 1);
    } else if (code === 10) {
      starts.push(index + 1);
    }
  }
  return starts;
}

/** The 1-based line containing `offset`. Offsets past the end clamp to the last line. */
export function lineAt(lineIndex: readonly number[], offset: number): number {
  let low = 0;
  let high = lineIndex.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const start = lineIndex[middle] ?? 0;
    if (start <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
}

/** The 1-based column of `offset` within `text`. */
export function columnAt(lineIndex: readonly number[], offset: number): number {
  const line = lineAt(lineIndex, offset);
  const start = lineIndex[line - 1] ?? 0;
  return offset - start + 1;
}

/**
 * Maps an absolute offset in `text` to a `SourceLocation`. This is the single
 * place offset arithmetic happens; `file` is used verbatim (callers pass the
 * project-relative posix path).
 */
export function locationAt(
  text: string,
  file: string,
  offset: number,
  length = 1,
): SourceLocation {
  const lineIndex = buildLineIndex(text);
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  return {
    file,
    line: lineAt(lineIndex, safeOffset),
    column: columnAt(lineIndex, safeOffset),
    length: Math.max(1, length),
  };
}

/** Offsets of the start/end of a GraphQL AST node inside `text`, clamped to `text`. */
export function nodeRange(
  node: { readonly loc?: { readonly start: number; readonly end: number } | undefined },
  text: string,
): { readonly start: number; readonly end: number } {
  const rawStart = node.loc?.start ?? 0;
  const rawEnd = node.loc?.end ?? rawStart;
  const start = Math.max(0, Math.min(rawStart, text.length));
  return { start, end: Math.max(start, Math.min(rawEnd, text.length)) };
}
