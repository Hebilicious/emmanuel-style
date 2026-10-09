/**
 * The compiler plugin host (`apps/docs/content/plugins.md`).
 *
 * One host function, `createCompilerHost`, owns the lifecycle. `generate()` creates it once per run
 * and calls its stage methods in order; every hook runs through one executor, so the error contract
 * holds for all of them: a plugin that throws (or whose hook rejects) fails the run with an
 * `FLM2005` diagnostic that names the plugin and the hook. A failure before the write leaves the
 * generated tree as it was; `afterEmit` runs after the tree is on disk, so its failure is reported
 * once the write has happened and the next successful run repairs the tree.
 *
 * A plugin declares `enforce: 'pre'` to run before the built-ins and `enforce: 'post'` to run after
 * every plugin that declares neither; everything else keeps the order the config file gives. Inside
 * a stage the plugins run in that order, one at a time, and the host awaits a hook that returns a
 * promise before it starts the next one.
 *
 * | Hook | When | What it may do |
 * | --- | --- | --- |
 * | `config` | in `loadConfig`, before resolution | return a replacement config |
 * | `configResolved` | once per run, before the schema loads | observe the resolved config |
 * | `beforeExtract` | after the schema, before discovery | observe; read the config |
 * | `routeDocuments` | once, after discovery and parsing | return the synthetic composed documents |
 * | `beforeEmit` | once, before anything is written | add, replace or delete files in `ctx.emit` |
 * | `afterEmit` | once, after the tree is on disk (not in check mode) | observe `ctx.written` |
 */

import { isAbsolute, posix } from 'node:path';

import type { FlammeConfig, ResolvedConfig } from '../config.js';
import {
  createDiagnostic,
  errorMessage,
  hasErrors,
  type Diagnostic,
  type SourceLocation,
} from '../diagnostics.js';
import type { RawDocument } from '../extract.js';
import type { IrDocument } from '../ir.js';

/** The diagnostic code a plugin failure reports (`apps/docs/content/errors.md`). */
export const PLUGIN_ERROR_CODE = 'FLM2005' as const;

/** Where a plugin reports a diagnostic. Implemented by the pipeline; a plugin never throws one. */
export interface DiagnosticSink {
  /** Records one diagnostic. */
  report(diagnostic: Diagnostic): void;
}

/**
 * What `beforeEmit`/`afterEmit` receive: the resolved config, the documents and the output tree.
 *
 * Kept as a base type for plugins written against the earlier contract; `PluginContext` is what the
 * host passes and it narrows `documents` to `IrDocument`.
 */
export interface EmitContext {
  readonly config: ResolvedConfig;
  readonly documents: readonly unknown[];
  readonly runtimeDir: string;
  readonly written: readonly string[];
}

/** The run state a plugin may read. Every field is fixed before the first hook runs. */
export interface CompilerRunOptions {
  /** `true` in check mode: nothing is written or deleted. */
  readonly check: boolean;
  /** `true` when the run carries persisted queries (`generate({ persisted: true })`). */
  readonly persisted: boolean;
  /** The project-relative sources this run was triggered by, when the caller had a change set. */
  readonly files?: readonly string[];
  /**
   * The artifact modules this run re-serializes; `undefined` is every artifact. An incremental run
   * narrows it, and the rest of the tree is still produced for the whole project.
   */
  readonly artifacts?: ReadonlySet<string>;
}

/**
 * The files one run will write, keyed by their path relative to `runtimeDir`.
 *
 * Every member normalizes the key (`artifacts/./A.ts` is `artifacts/A.ts`), so the
 * stored key, `paths()`/`entries()` and what `written` reports are one spelling. A
 * key outside the generated directory is rejected by `add`, `set` and `delete`; a
 * lookup that names one is simply absent.
 */
export interface EmitBag {
  /** How many files the bag holds. */
  readonly size: number;
  /** Adds a file; throws when another plugin already claimed the path. */
  add(path: string, content: string): void;
  /** Adds a file, replacing one another plugin claimed. */
  set(path: string, content: string): void;
  /** The content of one file, or `undefined`. */
  get(path: string): string | undefined;
  /** `true` when the bag holds the path. */
  has(path: string): boolean;
  /**
   * Removes a file and tombstones its path, so a file an earlier run wrote (or one
   * the compiler contributed to this run's bag) is deleted on disk after a
   * successful write; `true` when the bag held it.
   */
  delete(path: string): boolean;
  /** Every path in insertion order. */
  paths(): readonly string[];
  /** Every `[path, content]` pair in insertion order. */
  entries(): readonly (readonly [string, string])[];
  /** Every path a plugin removed, in insertion order. */
  deleted(): readonly string[];
}

/** The context every run-level hook receives. */
export interface PluginContext extends EmitContext {
  /** The compiled documents the request asked for. */
  readonly documents: readonly IrDocument[];
  /** Every extracted document. Set by the host before `afterExtract` runs. */
  readonly rawDocuments: readonly RawDocument[];
  /** The project root. */
  readonly projectDir: string;
  /** The run's options. */
  readonly options: CompilerRunOptions;
  /** Every diagnostic collected so far, live. */
  readonly diagnostics: readonly Diagnostic[];
  /** `true` when `diagnostics` holds an error. */
  readonly hasErrors: boolean;
  /** The files this run will write. */
  readonly emit: EmitBag;
  /** Records one diagnostic. */
  report(diagnostic: Diagnostic): void;
}

/** What {@link CompilerPlugin.routeDocuments} receives: the documents this run extracted. */
export interface RouteDocumentInput {
  /** The resolved config. */
  readonly config: ResolvedConfig;
  /** The project root, absolute. */
  readonly projectDir: string;
  /** The generated directory, absolute. */
  readonly runtimeDir: string;
  /** Every document this run extracted, in extraction order. */
  readonly documents: readonly RawDocument[];
}

/**
 * One synthetic route document, as the composer plans it.
 *
 * It has no file on disk: the compiler compiles it like any other document (validate, IR, emit,
 * manifest) and writes a real artifact module at `<runtimeDir>/artifacts/<name>.ts`, while leaving
 * it out of the `$flamme` barrel and `ambient.d.ts`.
 */
export interface RouteDocument {
  /** The composed document name, which is also its operation name and artifact name. */
  readonly name: string;
  /** The composed GraphQL text. */
  readonly raw: string;
  /** The synthetic path relative to `projectDir`, for messages. */
  readonly relativePath: string;
  /** The same path, absolute. */
  readonly absolute: string;
  /** The participant document names, chain order. */
  readonly participants: readonly string[];
  /** The route record this composition belongs to. */
  readonly record: string;
  /**
   * The project-relative file the record's own document loader came from (a page's `+page.gql`, or
   * the nearest participant for a record that declares none).
   *
   * A finding about the composed document is re-located here: the synthetic file has no line a
   * reader could open, so a warning that is not a duplicate of a participant's own finding names
   * the page instead and says which composition it came from.
   */
  readonly file: string;
}

/** What one plugin's `routeDocuments` hook returned. */
export interface RouteDocumentResult {
  /** The composed documents to compile. */
  readonly documents: readonly RouteDocument[];
  /** Findings about the route tree (`FLM3011`-`FLM3015`, `FLM1032`). */
  readonly diagnostics?: readonly Diagnostic[];
}

/**
 * Compiler plugin hooks. Node-only; every hook is optional. `generate()` runs them through
 * {@link createCompilerHost}.
 */
export interface CompilerPlugin {
  /** Plugin name, used in diagnostics and debug output. */
  readonly name: string;
  /** `pre` runs before the built-ins, `post` after every plugin that declares neither. */
  readonly enforce?: 'pre' | 'post';
  /**
   * Runs in `loadConfig`, before the config is resolved. May return a replacement config, or a
   * promise for one; a returned promise is awaited before the next plugin's hook starts.
   */
  config?(config: FlammeConfig): FlammeConfig | undefined | Promise<FlammeConfig | undefined>;
  /** Runs once per run on the resolved config. Observe only: use `config` to change it. */
  configResolved?(config: ResolvedConfig): unknown;
  /** Runs before extraction discovers anything. A returned promise is awaited. */
  beforeExtract?(context: PluginContext): unknown;
  /** Observes or replaces one compiled document; `undefined` keeps it. */
  transformDocument?(
    document: IrDocument,
    context: PluginContext,
  ): IrDocument | undefined | Promise<IrDocument | undefined>;
  /** Runs once after extraction, before validation. May add a raw document to the array. */
  afterExtract?(documents: RawDocument[], context: PluginContext): unknown;
  /**
   * Plans the project's composed route documents (`research/route-composition-design.md`).
   *
   * Called once after extraction, before validation, so the composed documents are compiled by the
   * same pass as every other document. `@flamme/vite`'s `flammeRoutesPlugin()` is the implementation:
   * it plans the route table, merges each record's chain and returns one query per composing
   * record. A plugin that returns nothing (or no plugin at all) composes nothing, and a caller that
   * passes `routeDocuments` to `generate()` supplies them itself.
   */
  routeDocuments?(
    input: RouteDocumentInput,
    context: PluginContext,
  ): RouteDocumentResult | undefined | Promise<RouteDocumentResult | undefined>;
  /** Per-document validation; reports diagnostics through the sink. */
  validate?(document: IrDocument, diagnostics: DiagnosticSink): void;
  /** Runs before the generated tree is written; contributes files through `context.emit`. */
  beforeEmit?(context: PluginContext): unknown;
  /** Runs after the generated tree is written. */
  afterEmit?(context: PluginContext): unknown;
}

/** The hook names, for diagnostics. */
export type CompilerHook =
  | 'config'
  | 'configResolved'
  | 'beforeExtract'
  | 'transformDocument'
  | 'afterExtract'
  | 'routeDocuments'
  | 'validate'
  | 'beforeEmit'
  | 'afterEmit';

/** Identity helper that gives a compiler plugin full type checking and completion. */
export function definePlugin(plugin: CompilerPlugin): CompilerPlugin {
  return plugin;
}

/** Options of {@link createCompilerHost}. */
export interface CompilerHostOptions {
  /** The user's plugins. Default `config.plugins`. */
  readonly plugins?: readonly CompilerPlugin[];
  /** Plugins composed before the user's, when a caller has built-ins of its own. */
  readonly defaults?: readonly CompilerPlugin[];
  /** The run options the context exposes. Missing fields default to a full, non-persisted run. */
  readonly run?: Partial<CompilerRunOptions>;
  /** The array plugin failures and plugin-reported diagnostics are pushed onto. */
  readonly diagnostics?: Diagnostic[];
}

/** The lifecycle of one `generate()` run, as `generate()` calls it. */
export interface CompilerHost {
  /** Every plugin, in execution order. */
  readonly plugins: readonly CompilerPlugin[];
  /** The context the run-level hooks receive. */
  readonly context: PluginContext;
  /** The files this run will write. */
  readonly emit: EmitBag;
  /** Runs `configResolved` over every plugin. */
  resolveConfig(): Promise<void>;
  /** Runs `beforeExtract`. */
  beforeExtract(): Promise<void>;
  /** Records the raw documents and runs `afterExtract`. */
  afterExtract(documents: RawDocument[]): Promise<void>;
  /**
   * Runs `routeDocuments` and returns the merged composition, reporting the findings it carries.
   * `undefined` when no plugin composes, which is what keeps a project without a route plugin on
   * the plain per-document pipeline.
   */
  routeDocuments(documents: readonly RawDocument[]): Promise<RouteDocumentResult | undefined>;
  /** Runs `transformDocument` over one document and appends the result to the context. */
  transformDocument(document: IrDocument): Promise<IrDocument>;
  /** Runs the per-document `validate` hook over every document. */
  validate(documents: readonly IrDocument[]): Promise<void>;
  /** Runs `beforeEmit`; `artifacts` narrows the artifact modules the built-ins re-serialize. */
  beforeEmit(artifacts?: ReadonlySet<string>): Promise<void>;
  /** Records the written files and runs `afterEmit`. */
  afterEmit(written: readonly string[]): Promise<void>;
}

/** The config-file location a run-level plugin failure is reported at. */
const CONFIG_LOCATION: SourceLocation = {
  file: 'flamme.config.ts',
  line: 1,
  column: 1,
  length: 1,
};

/** The source location a per-document plugin failure is reported at. */
function documentLocation(document: { readonly source: string }): SourceLocation {
  return { file: document.source, line: 1, column: 1, length: 1 };
}

/**
 * The `FLM2005` diagnostic one failed hook reports. The host and `loadConfig`
 * share it, so a `config` hook failure reads exactly like every other one.
 */
export function pluginFailureDiagnostic(
  plugin: { readonly name: string },
  hook: CompilerHook,
  error: unknown,
  location: SourceLocation = CONFIG_LOCATION,
): Diagnostic {
  return createDiagnostic({
    code: PLUGIN_ERROR_CODE,
    severity: 'error',
    message: `Compiler plugin "${plugin.name}" failed in ${hook}: ${errorMessage(error)}`,
    location,
    hint: 'fix or remove the plugin in flamme.config.ts; a plugin that throws fails the run',
  });
}

/** The order `pre`, then the unordered plugins, then `post`; `config` hooks use this. */
export function orderByEnforce(plugins: readonly CompilerPlugin[]): readonly CompilerPlugin[] {
  return orderPlugins(plugins, []);
}

/** `pre` first, then the built-ins, then the unordered plugins, then `post`. */
function orderPlugins(
  user: readonly CompilerPlugin[],
  defaults: readonly CompilerPlugin[],
): readonly CompilerPlugin[] {
  const pre: CompilerPlugin[] = [];
  const middle: CompilerPlugin[] = [];
  const post: CompilerPlugin[] = [];
  for (const plugin of user) {
    if (plugin.enforce === 'pre') {
      pre.push(plugin);
    } else if (plugin.enforce === 'post') {
      post.push(plugin);
    } else {
      middle.push(plugin);
    }
  }
  return [...pre, ...defaults, ...middle, ...post];
}

/**
 * The normalized key of a bag path, or a throw for one that does not name a file
 * inside `runtimeDir`: an absolute path, or one that normalizes out of the
 * directory. The throw becomes the `FLM2005` diagnostic of the hook that made the
 * call, which is what names the plugin; the message carries the key as written.
 *
 * The check is lexical, and normalizing here is what keeps the stored key, what
 * `written` reports and what the stale sweep compares the same string.
 */
function assertEmitPath(path: string): string {
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  if (path.length === 0 || isAbsolute(path) || posix.isAbsolute(normalized)) {
    throw new Error(
      `emit path "${path}" is absolute; keys are relative to the generated directory.`,
    );
  }
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(
      `emit path "${path}" escapes the generated directory; keys are relative to it.`,
    );
  }
  return normalized;
}

/** The stored key a lookup reads, or `undefined` for a path the bag cannot hold. */
function lookupEmitPath(path: string): string | undefined {
  try {
    return assertEmitPath(path);
  } catch {
    return undefined;
  }
}

/** A `Map`-backed {@link EmitBag}. */
function createEmitBag(): EmitBag {
  const files = new Map<string, string>();
  /** The paths a plugin removed, in insertion order; a re-add clears the tombstone. */
  const removed = new Map<string, true>();
  return {
    get size(): number {
      return files.size;
    },
    add(path, content) {
      const key = assertEmitPath(path);
      if (files.has(key)) {
        throw new Error(`"${key}" is already emitted by another plugin; call set() to replace it.`);
      }
      removed.delete(key);
      files.set(key, content);
    },
    set(path, content) {
      const key = assertEmitPath(path);
      removed.delete(key);
      files.set(key, content);
    },
    get(path) {
      const key = lookupEmitPath(path);
      return key === undefined ? undefined : files.get(key);
    },
    has(path) {
      const key = lookupEmitPath(path);
      return key === undefined ? false : files.has(key);
    },
    delete(path) {
      const key = assertEmitPath(path);
      const held = files.delete(key);
      removed.set(key, true);
      return held;
    },
    paths() {
      return [...files.keys()];
    },
    entries() {
      return [...files.entries()];
    },
    deleted() {
      return [...removed.keys()];
    },
  };
}

/**
 * Creates the host of one run over `config.plugins`.
 *
 * The run options are the native request's (`check`, `persisted`, `files`); the
 * compiler's own tree is already in the emit bag when `beforeEmit` runs, and a
 * plugin contributes to it.
 */
export function createCompilerHost(
  config: ResolvedConfig,
  options: CompilerHostOptions = {},
): CompilerHost {
  const diagnostics = options.diagnostics ?? [];
  const run: {
    check: boolean;
    persisted: boolean;
    files?: readonly string[];
    artifacts?: ReadonlySet<string>;
  } = {
    check: options.run?.check ?? false,
    persisted: options.run?.persisted ?? false,
    ...(options.run?.files === undefined ? {} : { files: options.run.files }),
  };
  const plugins = orderPlugins(options.plugins ?? config.plugins, options.defaults ?? []);
  const emit = createEmitBag();
  const state: {
    rawDocuments: readonly RawDocument[];
    documents: readonly IrDocument[];
    written: readonly string[];
  } = { rawDocuments: [], documents: [], written: [] };

  const context: PluginContext = {
    config,
    get documents(): readonly IrDocument[] {
      return state.documents;
    },
    get rawDocuments(): readonly RawDocument[] {
      return state.rawDocuments;
    },
    projectDir: config.projectDir,
    runtimeDir: config.runtimeDir,
    get written(): readonly string[] {
      return state.written;
    },
    options: run,
    get diagnostics(): readonly Diagnostic[] {
      return diagnostics;
    },
    get hasErrors(): boolean {
      return hasErrors(diagnostics);
    },
    emit,
    report(diagnostic): void {
      diagnostics.push(diagnostic);
    },
  };

  /**
   * Runs one plugin's hook. A throw becomes an `FLM2005` diagnostic that names the plugin and the
   * hook, and the hook's value is `undefined`. The run continues so every remaining diagnostic is
   * still reported, and the error severity stops the write.
   */
  async function invoke<T>(
    plugin: CompilerPlugin,
    hook: CompilerHook,
    location: SourceLocation,
    body: () => T | Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await body();
    } catch (error) {
      diagnostics.push(pluginFailureDiagnostic(plugin, hook, error, location));
      return undefined;
    }
  }

  return {
    plugins,
    context,
    emit,
    async resolveConfig(): Promise<void> {
      for (const plugin of plugins) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- plugin hooks are ordered by contract
        await invoke(plugin, 'configResolved', CONFIG_LOCATION, () =>
          plugin.configResolved?.(config),
        );
      }
    },
    async beforeExtract(): Promise<void> {
      for (const plugin of plugins) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- plugin hooks are ordered by contract
        await invoke(plugin, 'beforeExtract', CONFIG_LOCATION, () =>
          plugin.beforeExtract?.(context),
        );
      }
    },
    async afterExtract(documents: RawDocument[]): Promise<void> {
      state.rawDocuments = documents;
      for (const plugin of plugins) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- plugin hooks are ordered by contract
        await invoke(plugin, 'afterExtract', CONFIG_LOCATION, () =>
          plugin.afterExtract?.(documents, context),
        );
      }
    },
    async routeDocuments(
      documents: readonly RawDocument[],
    ): Promise<RouteDocumentResult | undefined> {
      const composed: RouteDocument[] = [];
      let found = false;
      for (const plugin of plugins) {
        if (plugin.routeDocuments === undefined) {
          continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- plugin hooks are ordered by contract
        const result = await invoke(plugin, 'routeDocuments', CONFIG_LOCATION, () =>
          plugin.routeDocuments?.(
            { config, projectDir: config.projectDir, runtimeDir: config.runtimeDir, documents },
            context,
          ),
        );
        if (result === undefined) {
          continue;
        }
        found = true;
        diagnostics.push(...(result.diagnostics ?? []));
        composed.push(...result.documents);
      }
      return found ? { documents: composed } : undefined;
    },
    async transformDocument(document: IrDocument): Promise<IrDocument> {
      let current = document;
      const location = documentLocation(document);
      for (const plugin of plugins) {
        if (plugin.transformDocument === undefined) {
          continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- each plugin sees the previous result
        const next = await invoke(plugin, 'transformDocument', location, () =>
          plugin.transformDocument?.(current, context),
        );
        if (next !== undefined) {
          current = next;
        }
      }
      state.documents = [...state.documents, current];
      return current;
    },
    async validate(documents: readonly IrDocument[]): Promise<void> {
      for (const document of documents) {
        for (const plugin of plugins) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- document-major, as before the host
          await invoke(plugin, 'validate', documentLocation(document), () =>
            plugin.validate?.(document, { report: (entry) => diagnostics.push(entry) }),
          );
        }
      }
    },
    async beforeEmit(artifacts?: ReadonlySet<string>): Promise<void> {
      if (artifacts !== undefined) {
        run.artifacts = artifacts;
      }
      for (const plugin of plugins) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- plugin hooks are ordered by contract
        await invoke(plugin, 'beforeEmit', CONFIG_LOCATION, () => plugin.beforeEmit?.(context));
      }
    },
    async afterEmit(written: readonly string[]): Promise<void> {
      state.written = written;
      for (const plugin of plugins) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- plugin hooks are ordered by contract
        await invoke(plugin, 'afterEmit', CONFIG_LOCATION, () => plugin.afterEmit?.(context));
      }
    },
  };
}
