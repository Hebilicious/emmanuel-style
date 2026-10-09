/**
 * The mutable state the two plugins share (`spec/spec.md` §10.1). One factory
 * call owns one state, so two `flamme()` plugins in one config never share a
 * config, an index or an HMR queue.
 */

import { DEFAULT_INCLUDE, type ResolvedConfig, type SfcAnalyzer } from '@flamme/core';

import { createVueAnalyzer } from './analyzer.js';
import type { AnalyzerReason } from './analyzer.js';
import type { DevServerLike } from './context.js';
import type { HmrRunner } from './hmr.js';
import type { GenerateCache } from './codegen.js';
import { createArtifactIndex, type ArtifactIndex } from './indexes.js';
import type { FlammePluginOptions } from './options.js';

/** The record module fields the transform reads (the generator's `RecordModule`). */
export interface RecordModuleLike {
  /** The specifier app code uses (`$flamme/records/index`). */
  readonly specifier: string;
  /** The module's path relative to `runtimeDir` (`records/index.ts`). */
  readonly file: string;
  /** The document the record's loader runs. */
  readonly document: string;
}

/** Shared plugin state, created by {@link createPluginState}. */
export interface PluginState {
  /** The user's plugin options. */
  readonly options: FlammePluginOptions;
  /** Project root, known after `config`/`configResolved`. */
  root: string;
  /** Whether Vite is building or serving. */
  command: 'build' | 'serve';
  /** The resolved config, or `undefined` when it could not be loaded. */
  config: ResolvedConfig | undefined;
  /** The load failure, re-thrown from `configResolved` unless codegen is skipped. */
  configError: unknown;
  /** The chosen SFC analyzer. */
  analyzer: SfcAnalyzer;
  /** Why the analyzer was chosen, for the one-time log line. */
  analyzerReason: AnalyzerReason;
  /** The installed Vize version, named by the seam guard. */
  vizeVersion: string | undefined;
  /** Whether a Vize plugin was found in the resolved plugin list. */
  hasVizePlugin: boolean;
  /** The artifact lookup the transform consults. */
  index: ArtifactIndex;
  /**
   * What the previous codegen pass left for the next one (extraction and IR, per
   * file and per document). One dev server, one project, one cache.
   */
  cache: GenerateCache;
  /** Hash per document name, for changed-artifact detection. */
  hashes: Map<string, string>;
  /** Document names per source file, for the HMR ownership rule. */
  documentFiles: Map<string, Set<string>>;
  /**
   * Route component (absolute path) -> the generated record module that types its
   * `usePageQuery()`. The transform rewrites the component's import to that module, so a page gets
   * its own record's data type with no type argument; a file that is not a route component is absent
   * and keeps the untyped `@flamme/router/auto` import.
   */
  recordModules: ReadonlyMap<string, RecordModuleLike>;
  /** Files the plugin wrote itself, with timestamps. */
  ownWrites: Map<string, number>;
  /** Where non-fatal diagnostics are printed, once a hook supplied a logger. */
  warn: ((message: string) => void) | undefined;
  /** The dev server, once `configureServer` ran. */
  server: DevServerLike | undefined;
  /** The HMR runner, once `configureServer` ran. */
  runner: HmrRunner | undefined;
}

/** Creates the shared state for one `flamme()` call. */
export function createPluginState(options: FlammePluginOptions = {}): PluginState {
  return {
    options,
    root: process.cwd(),
    command: 'build',
    config: undefined,
    configError: undefined,
    analyzer: createVueAnalyzer(),
    analyzerReason: 'vize-not-in-plugin-list',
    vizeVersion: undefined,
    hasVizePlugin: false,
    index: createArtifactIndex([]),
    cache: {},
    hashes: new Map(),
    documentFiles: new Map(),
    recordModules: new Map(),
    ownWrites: new Map(),
    warn: undefined,
    server: undefined,
    runner: undefined,
  };
}

/** The include globs the HMR ownership rule uses, with the config's own. */
export function includeGlobs(state: PluginState): readonly string[] {
  return state.config?.include ?? DEFAULT_INCLUDE;
}
