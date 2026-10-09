/**
 * Range-aware document scanning for the transform (`spec/spec.md` §4.3 step 5).
 *
 * Binding resolution is not duplicated here: `scanCode` from `@flamme/core`
 * decides which `graphql` identifiers belong to us, and this module recovers the
 * exact source ranges (`graphql\`…\``, `graphql(…)`, `GraphQL<\`…\`>`) that the
 * rewrite has to replace. The ranges are found textually around the candidate
 * offsets the scanner reports, so both halves can never disagree about which
 * occurrences exist.
 */

import { scanCode, type Diagnostic } from '@flamme/core';

/** A document occurrence and the exact source range the rewrite replaces. */
export interface DocumentRange {
  /** Absolute offset of the first character to replace. */
  readonly start: number;
  /** Absolute offset just past the last character to replace. */
  readonly end: number;
  /** The document text, as `scanCode` unescaped it. */
  readonly text: string;
  /** Which syntactic form the occurrence has. */
  readonly kind: 'tag' | 'call';
  /** Whether the literal is a template literal or a plain string. */
  readonly form: 'template' | 'string';
}

/** A document import whose specifier can be rewritten. */
export interface ImportRange {
  /** The specifier as written. */
  readonly specifier: string;
  /** Absolute offset of the specifier's first character (inside the quotes). */
  readonly start: number;
  /** Absolute offset just past the specifier. */
  readonly end: number;
  /** Absolute path the specifier resolves to, when it is not lexical. */
  readonly resolved: string | undefined;
  /** Project-relative posix path of the importing file. */
  readonly relativePath: string;
}

/** Everything one script block contributes to the rewrite. */
export interface BlockScan {
  /** Document occurrences, in source order. */
  readonly ranges: readonly DocumentRange[];
  /** Document imports with a rewritable specifier. */
  readonly imports: readonly ImportRange[];
  /** Diagnostics `scanCode` produced (FLM1011, the unbound-tag warning). */
  readonly diagnostics: readonly Diagnostic[];
}

/** Arguments for {@link scanBlock}; `offset` is the block's absolute file offset. */
export interface ScanBlockArgs {
  /** The script text (for a `.ts` file, the whole file). */
  readonly code: string;
  /** Absolute path of the file the block lives in. */
  readonly file: string;
  /** Project-relative posix path of that file. */
  readonly relativePath: string;
  /** Absolute offset of `code[0]` in the file. */
  readonly offset: number;
  /** The whole file text (used for diagnostics and for range recovery). */
  readonly source: string;
  /** The block's language. */
  readonly lang: 'js' | 'jsx' | 'ts' | 'tsx';
  /** The document extensions in effect (`routing.documentExtensions`); the default pair without. */
  readonly documentExtensions?: readonly string[];
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const WHITESPACE = /\s/;

/** `true` when the character at `index` is a JS string/template delimiter. */
function quoteAt(source: string, index: number): '`' | '"' | "'" | undefined {
  const character = source[index];
  return character === '`' || character === '"' || character === "'" ? character : undefined;
}

/** Index of the first unescaped `quote` at or after `from`, or `undefined`. */
export function closingQuote(source: string, from: number, quote: string): number | undefined {
  let index = from;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === quote) {
      return index;
    }
    index += 1;
  }
  return undefined;
}

/** Index of the last non-whitespace character at or before `from`. */
function skipBack(source: string, from: number): number {
  let index = from;
  while (index >= 0 && WHITESPACE.test(source[index] ?? '')) {
    index -= 1;
  }
  return index;
}

/** Start index of the identifier that ends at `end`, or `undefined`. */
export function identifierStart(source: string, end: number): number | undefined {
  let index = end;
  while (index >= 0 && IDENTIFIER.test(source[index] ?? '') && source[index] !== undefined) {
    index -= 1;
  }
  const start = index + 1;
  if (start > end) {
    return undefined;
  }
  const name = source.slice(start, end + 1);
  return IDENTIFIER.test(name) ? start : undefined;
}

/** Recovers the full replacement range for one scanned document candidate. */
export function rangeFor(source: string, offset: number, text: string): DocumentRange | undefined {
  const quote = quoteAt(source, offset - 1);
  if (quote === undefined) {
    return undefined;
  }
  const close = closingQuote(source, offset, quote);
  if (close === undefined) {
    return undefined;
  }
  const form: DocumentRange['form'] = quote === '`' ? 'template' : 'string';
  let after = close + 1;
  while (after < source.length && WHITESPACE.test(source[after] ?? '')) {
    after += 1;
  }
  const beforeQuote = skipBack(source, offset - 2);
  const next = source[after];

  // `graphql(\`…\`)`
  if (next === ')' && source[beforeQuote] === '(') {
    const identEnd = skipBack(source, beforeQuote - 1);
    const identStart = identifierStart(source, identEnd);
    if (identStart === undefined) {
      return undefined;
    }
    return { start: identStart, end: after + 1, text, kind: 'call', form };
  }

  // NOTE: the `GraphQL<\`…\`>` type form has no branch here. `scanCode` in
  // `@flamme/core` reports no candidate for it, so the vite slice cannot
  // name an artifact for it; see `research/slice5-report.md` for the finding.

  // `graphql\`…\``
  const identEnd = beforeQuote;
  // A call or member expression was already excluded by `scanCode`; bail out
  // rather than rewrite a shape this simpler range recovery cannot express.
  const identStart = identifierStart(source, identEnd);
  if (identStart === undefined) {
    return undefined;
  }
  const preceding = skipBack(source, identStart - 1);
  if (source[preceding] === '(' || source[preceding] === '.') {
    return undefined;
  }
  return { start: identStart, end: close + 1, text, kind: 'tag', form };
}

/** Finds the source range of an import's module specifier. */
export function specifierRange(
  source: string,
  declarationStart: number,
  specifier: string,
): { start: number; end: number } | undefined {
  const pattern = /\bfrom\s*(['"])([^'"]*)\1/g;
  pattern.lastIndex = declarationStart;
  const match = pattern.exec(source);
  if (match === null || match.index > declarationStart + 2000 || match[2] !== specifier) {
    return undefined;
  }
  const start = match.index + match[0].length - 1 - specifier.length;
  return { start, end: start + specifier.length };
}

/** Scans one script block for documents and document imports (§4.3 step 5). */
export function scanBlock(args: ScanBlockArgs): BlockScan {
  const scanned = scanCode(
    args.code,
    args.file,
    args.relativePath,
    args.offset,
    args.source,
    args.lang,
    args.documentExtensions,
  );
  const ranges: DocumentRange[] = [];
  for (const candidate of scanned.candidates) {
    const range = rangeFor(args.source, candidate.offset, candidate.text);
    if (range !== undefined) {
      ranges.push(range);
    }
  }
  const imports: ImportRange[] = [];
  for (const entry of scanned.imports) {
    const range = specifierRange(args.source, entry.offset, entry.specifier);
    if (range !== undefined) {
      imports.push({
        specifier: entry.specifier,
        start: range.start,
        end: range.end,
        resolved: entry.resolved,
        relativePath: entry.relativePath,
      });
    }
  }
  return { ranges, imports, diagnostics: scanned.diagnostics };
}
