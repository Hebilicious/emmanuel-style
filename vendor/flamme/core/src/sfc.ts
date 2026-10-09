/**
 * SFC analysis (`spec/spec.md` §4.3 step 2), reached through the `SfcAnalyzer`
 * interface so `@vizejs/native` can back it later. This module uses
 * `@vue/compiler-sfc`'s `parse()` and never `compileScript`: `parse()` gives
 * `innerLoc`-based offsets, which is exactly the offset basis §4.3 requires, and
 * it also does not populate `scriptAst`/`scriptSetupAst`.
 */

import { parse as parseSfc } from '@vue/compiler-sfc';

/** The 1-based position an SFC parse error points at, without asserting its shape. */
function sfcErrorPosition(error: unknown): { readonly line: number; readonly column: number } {
  if (typeof error !== 'object' || error === null || !('loc' in error)) {
    return { line: 1, column: 1 };
  }
  const loc = error.loc;
  if (typeof loc !== 'object' || loc === null || !('start' in loc)) {
    return { line: 1, column: 1 };
  }
  const start = loc.start;
  if (typeof start !== 'object' || start === null) {
    return { line: 1, column: 1 };
  }
  const line = 'line' in start ? start.line : undefined;
  const column = 'column' in start ? start.column : undefined;
  return {
    line: typeof line === 'number' ? line : 1,
    column: typeof column === 'number' ? column : 1,
  };
}

/** An SFC that does not parse, with the position of the offending tag (F6). */
export class SfcParseError extends Error {
  /** 1-based line of the offending tag in the `.vue` file. */
  readonly line: number;
  /** 1-based column of the offending tag in the `.vue` file. */
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = 'SfcParseError';
    this.line = line;
    this.column = column;
  }
}

/** One `<script>`/`<script setup>` block, in the form the scanner needs. */
export interface SfcScriptBlock {
  /** Which block this is. */
  readonly kind: 'setup' | 'script';
  /** The script text, identical to `source.slice(loc.start.offset, loc.end.offset)`. */
  readonly content: string;
  /** Absolute offset of `content[0]` in the `.vue` file. */
  readonly offset: number;
  /** The block's language, from its `lang` attribute (`ts` when absent in the PoC). */
  readonly lang: 'js' | 'jsx' | 'ts' | 'tsx';
  /** Every attribute on the tag, normalized to `string | true`. */
  readonly attrs: Readonly<Record<string, string | true>>;
  /** The `src` attribute, when the block's content lives in another file. */
  readonly src?: string;
}

/** Everything the scanner needs from one `.vue` file. */
export interface SfcAnalysis {
  /** Every script block that carries content, `<script setup>` first. */
  readonly scripts: readonly SfcScriptBlock[];
}

/** Which SFC analysis backend produced an `SfcAnalysis`. */
export type SfcAnalyzerName = 'vize' | 'vue-compiler-sfc';

/** The backend-neutral SFC analysis seam (`@flamme/core/sfc`). */
export interface SfcAnalyzer {
  /** Backend identifier, reported by the Vite plugin's analyzer choice. */
  readonly name: SfcAnalyzerName;
  /** Parses one SFC; `filename` is required and is used for diagnostics. */
  analyze(source: string, filename: string): SfcAnalysis;
}

function normalizeAttrs(attrs: Readonly<Record<string, string | true>>): Record<string, string | true> {
  const normalized: Record<string, string | true> = {};
  for (const [name, value] of Object.entries(attrs)) {
    normalized[name] = value === '' ? true : value;
  }
  return normalized;
}

function blockLang(attrs: Readonly<Record<string, string | true>>): 'js' | 'jsx' | 'ts' | 'tsx' {
  const lang = attrs['lang'];
  if (lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx') {
    return lang;
  }
  return 'js';
}

/**
 * Analyzes one SFC with `@vue/compiler-sfc`. `parse()` is called without the
 * `pad` option on purpose: with padding enabled `content` no longer starts at
 * `loc.start.offset` and every offset in this compiler would silently break
 * (`research/extraction-and-vite.md` A.2).
 *
 * Custom blocks are not a document surface (`spec/spec.md` §4.3): a `<gql>`
 * block is parsed by `@vue/compiler-sfc` into `descriptor.customBlocks` and
 * ignored, so `SfcAnalysis` carries script blocks only.
 */
export function analyzeVueSfc(source: string, filename: string): SfcAnalysis {
  const { descriptor, errors } = parseSfc(source, { filename });
  if (errors.length > 0) {
    const first = errors[0];
    // Report the offending tag, not an I/O failure at 1:1 with the absolute path
    // (F6): the SFC error carries its own source position.
    const at = sfcErrorPosition(first);
    throw new SfcParseError(first?.message ?? 'invalid SFC', at.line, at.column);
  }

  const scripts: SfcScriptBlock[] = [];
  const blocks = [descriptor.scriptSetup, descriptor.script];
  for (const block of blocks) {
    if (block === undefined || block === null) {
      continue;
    }
    const attrs = normalizeAttrs(block.attrs);
    const kind: 'setup' | 'script' = block === descriptor.scriptSetup ? 'setup' : 'script';
    scripts.push({
      kind,
      content: block.content,
      offset: block.loc.start.offset,
      lang: blockLang(attrs),
      attrs,
      ...(typeof attrs['src'] === 'string' ? { src: attrs['src'] } : {}),
    });
  }

  return { scripts };
}

/** The `@vue/compiler-sfc` backend of the `SfcAnalyzer` seam. */
export function createVueAnalyzer(): SfcAnalyzer {
  return { name: 'vue-compiler-sfc', analyze: analyzeVueSfc };
}
