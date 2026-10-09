/**
 * The SFC analyzer seam (`spec/spec.md` §10.3 step 1, §10.4). `@vizejs/native`
 * is an **optional peer**: it is reached through a guarded dynamic import and the
 * package builds and runs with Vize absent, in which case
 * `@vue/compiler-sfc` (through `@flamme/core`) is the analyzer.
 *
 * Both backends produce the same thing since the `<gql>` block surface was
 * removed (§4.3): the file's `<script>`/`<script setup>` blocks with
 * `innerLoc`-style offsets. The Vize backend recovers the offsets from the
 * source text, because Vize's own `parseSfc` does not carry them.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  createVueAnalyzer,
  type SfcAnalysis,
  type SfcAnalyzer,
  type SfcScriptBlock,
} from '@flamme/core';

import { VizeSeamError } from './errors.js';

/** A module loader, injectable so the "Vize absent" path is testable. */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

/** The specifier `@vizejs/native` is imported under. */
export const VIZE_NATIVE_SPECIFIER = '@vizejs/native';

/** The default loader: a real dynamic import, resolved at call time. */
const defaultLoader: ModuleLoader = (specifier) => import(specifier);

/**
 * `true` when `@vizejs/native` resolves. Never throws: optional peers come and
 * go, and the caller decides what an absent peer means.
 */
export async function loadVizeNative(loader: ModuleLoader = defaultLoader): Promise<boolean> {
  try {
    await loader(VIZE_NATIVE_SPECIFIER);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the entry file of an installed package. */
export type EntryResolver = (specifier: string) => string;

/** The default entry resolver: Node's own resolution from this module. */
const defaultEntryResolver: EntryResolver = (specifier) =>
  createRequire(import.meta.url).resolve(specifier);

/** The installed `@vizejs/native` version, read from its `package.json`. */
export async function readVizeVersion(
  resolveEntry: EntryResolver = defaultEntryResolver,
): Promise<string | undefined> {
  try {
    const entry = resolveEntry(VIZE_NATIVE_SPECIFIER);
    const text = await readFile(join(dirname(entry), 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(text);
    const version: unknown =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'version') : undefined;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recovers `<script>`/`<script setup>` blocks, with `innerLoc`-style offsets,
 * from the source text. Vize's `parseSfc` returns script contents without
 * offsets, so the offsets are derived here; the `content` slice is the same
 * `source.slice(offset, offset + content.length)` basis §4.3 step 2 mandates.
 */
export function scriptBlocks(source: string): readonly SfcScriptBlock[] {
  const blocks: SfcScriptBlock[] = [];
  const pattern = /<script\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const attributes = match[1] ?? '';
    const contentStart = match.index + match[0].length;
    const close = source.indexOf('</script>', contentStart);
    if (close === -1) {
      continue;
    }
    const attrs: Record<string, string | true> = {};
    const attributePattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributePattern.exec(attributes)) !== null) {
      const name = attribute[1];
      if (name === undefined) {
        continue;
      }
      const value = attribute[2] ?? attribute[3] ?? attribute[4];
      attrs[name] = value === undefined ? true : value;
    }
    const lang = attrs['lang'];
    blocks.push({
      kind: attrs['setup'] === undefined ? 'script' : 'setup',
      content: source.slice(contentStart, close),
      offset: contentStart,
      lang: lang === 'ts' || lang === 'tsx' || lang === 'js' || lang === 'jsx' ? lang : 'js',
      attrs,
      ...(typeof attrs['src'] === 'string' ? { src: attrs['src'] } : {}),
    });
  }
  return [...blocks].toSorted((a, b) => (a.kind === b.kind ? a.offset - b.offset : a.kind === 'setup' ? -1 : 1));
}

/**
 * The Vize backend of the analyzer seam: the same script blocks as the
 * `@vue/compiler-sfc` backend, with the offsets recovered from the source text
 * (Vize's `parseSfc` returns contents without offsets).
 */
export function createVizeAnalyzer(): SfcAnalyzer {
  return {
    name: 'vize',
    analyze(source: string): SfcAnalysis {
      return { scripts: scriptBlocks(source) };
    },
  };
}

/** Why an analyzer was chosen; reported once per Vite server. */
export type AnalyzerReason =
  | 'forced-vize'
  | 'forced-vue-compiler'
  | 'vize-installed'
  | 'vize-not-installed'
  | 'vize-not-in-plugin-list'
  | 'vize-load-failed';

/** The analyzer choice plus the metadata the seam guard reports. */
export interface AnalyzerChoice {
  /** The selected backend. */
  readonly analyzer: SfcAnalyzer;
  /** The installed Vize version, when Vize supplied the analyzer. */
  readonly vizeVersion: string | undefined;
  /** Why this backend was selected. */
  readonly reason: AnalyzerReason;
}

/** Options for {@link selectAnalyzer}. */
export interface SelectAnalyzerOptions {
  /** The `sfc` plugin option. */
  readonly sfc?: 'auto' | 'vize' | 'vue-compiler';
  /** Whether a Vize plugin appears in the resolved plugin list. */
  readonly hasVizePlugin: boolean;
  /** Injectable module loader, for the Vize-absent tests. */
  readonly loader?: ModuleLoader;
  /** Injectable version reader, for the Vize-absent tests. */
  readonly versionLoader?: () => Promise<string | undefined>;
}

/**
 * Picks the SFC analyzer: Vize when it is installed *and* `vize()` is in the
 * plugin list, otherwise `@vue/compiler-sfc`; `sfc: 'vize'` fails loudly when
 * Vize cannot be loaded.
 */
export async function selectAnalyzer(options: SelectAnalyzerOptions): Promise<AnalyzerChoice> {
  const sfc = options.sfc ?? 'auto';
  if (sfc === 'vue-compiler') {
    return { analyzer: createVueAnalyzer(), vizeVersion: undefined, reason: 'forced-vue-compiler' };
  }
  const version = options.versionLoader ?? (() => readVizeVersion());
  if (sfc === 'auto' && !options.hasVizePlugin) {
    return {
      analyzer: createVueAnalyzer(),
      vizeVersion: undefined,
      reason: 'vize-not-in-plugin-list',
    };
  }
  const available = await loadVizeNative(options.loader);
  if (!available) {
    if (sfc === 'vize') {
      throw new VizeSeamError(
        `${VIZE_NATIVE_SPECIFIER} could not be loaded but sfc: 'vize' was requested.`,
        { hint: `Install ${VIZE_NATIVE_SPECIFIER} or set sfc: 'auto'.` },
      );
    }
    return { analyzer: createVueAnalyzer(), vizeVersion: undefined, reason: 'vize-load-failed' };
  }
  return {
    analyzer: createVizeAnalyzer(),
    vizeVersion: await version(),
    reason: sfc === 'vize' ? 'forced-vize' : 'vize-installed',
  };
}

/** The plain `@vue/compiler-sfc` backend, re-exported for consumers. */
export { createVueAnalyzer };
