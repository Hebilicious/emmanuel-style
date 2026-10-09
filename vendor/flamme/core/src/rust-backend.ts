/**
 * The Rust backend driver (`apps/docs/content/architecture.md`).
 *
 * What stays here is orchestration: resolve the config (already done by the
 * caller), read the SDL and the committed persisted manifest, hand the native
 * compiler one JSON request, then run the plugin host over the tree it returned and
 * write it with the same atomic writer, rollback and tombstone semantics the
 * TypeScript pipeline uses. The native call itself does discovery, reading, the
 * incremental cache, schema indexing, extraction, validation, IR and emit, and
 * returns the tree the run has to land plus the state the next run continues from.
 *
 * Two request shapes, one pipeline:
 *
 * - a **full run** (`options.files === undefined`) calls `compileProject`, which
 *   walks `projectDir` by the resolved include/exclude globs, stats and reads the
 *   tree in Rust and caches every file;
 * - a **change-set run** (`options.files`) keeps the TypeScript walk, because the
 *   watcher's change set is the caller's own knowledge, and reads only the files it
 *   names; the native side re-uses every other file from the cache, so an edit
 *   compiles the edited document and the documents it reaches, and reads nothing
 *   else. `readSources` is that path; `compileProject` is what replaces it.
 *
 * A user plugin that needs the compiler's own IR (`transformDocument`, `validate`),
 * that mutates the extracted documents (`afterExtract`) or that reads the schema
 * index (`schema`) cannot be honoured by a single native pass, and such a project
 * falls back to the TypeScript compiler with a message (see `generate.ts`). A plugin
 * that only observes (`config`, `configResolved`, `beforeExtract`) or contributes
 * files (`beforeEmit`, `afterEmit`) runs unchanged, and when a `beforeEmit` or
 * `afterEmit` hook is registered the request asks for the full IR so
 * `context.documents` is the real thing.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve as resolvePath } from 'node:path';

import { parse } from 'graphql';

import { type ResolvedConfig } from './config.js';
import {
  CompileError,
  createDiagnostic,
  errorMessage,
  hasErrors,
  type Diagnostic,
} from './diagnostics.js';
import {
  type DocumentSurface,
  type ExtractResult,
  type GqlImport,
  type RawDocument,
} from './extract.js';
import { type GenerateOptions } from './generate.js';
import { walkFiles, type DiscoveredFile } from './glob.js';
import type { IrDocument } from './ir.js';
import { loadNativeModule, missingCompilerMessage, type NativeModule } from './native.js';
import { toPosix } from './offsets.js';
import {
  createCompilerHost,
  type CompilerHost,
  type CompilerPlugin,
  type RouteDocument,
} from './plugins/host.js';
import { readSchemaSourceForCompiler, type SchemaIndex } from './schema.js';
import type { SubscriptionSelection } from './contract.js';

/** One artifact of a native compile, as the native module reports it. */
export interface NativeArtifact {
  readonly name: string;
  readonly kind: 'query' | 'fragment' | 'mutation' | 'subscription';
  readonly hash: string;
  readonly raw: string;
  readonly file: string;
  readonly source: string;
  readonly artifactFile: string;
  readonly paginated: readonly (readonly string[])[];
  readonly lists: readonly string[];
}

/** One extracted document of a native compile. */
export interface NativeDocument {
  readonly name: string;
  readonly kind: 'query' | 'fragment' | 'mutation' | 'subscription';
  readonly raw: string;
  readonly file: string;
  readonly relativePath: string;
  readonly surface: string;
  readonly offset: number;
  readonly start: number;
  readonly end: number;
  readonly sourceOffsets: readonly number[];
}

/** One `.gql` import of a native compile. */
export interface NativeImport {
  readonly file: string;
  readonly relativePath: string;
  readonly specifier: string;
  readonly resolved?: string | undefined;
  readonly offset: number;
}

/** One IR document of a native compile, without its `RawDocument`. */
type NativeIrDocument = Omit<IrDocument, 'ast' | 'document'> & {
  readonly fragmentSelections: Readonly<Record<string, SubscriptionSelection>>;
  readonly fragmentTypes: Readonly<Record<string, string>>;
  readonly injectedKeys: Readonly<Record<string, string>>;
};

/** The native module's response. */
export interface NativeResponse {
  /**
   * The tree this run has to land: the aggregate members over the whole project,
   * the artifacts it rebuilt, and the artifact of a re-used document whose module
   * is not on disk. A document the cache served and whose module is already on
   * disk is not in here, so the writer never re-compares the whole tree.
   */
  readonly files: readonly { readonly path: string; readonly contents: string }[];
  readonly diagnostics: readonly Diagnostic[];
  /** Every document, in extraction order, whether it was rebuilt or re-used. */
  readonly artifacts: readonly NativeArtifact[];
  readonly extractionDiagnostics: readonly Diagnostic[];
  readonly documents: readonly NativeDocument[];
  readonly imports: readonly NativeImport[];
  readonly importedNames: readonly string[];
  readonly irDocuments?: readonly NativeIrDocument[] | undefined;
  /**
   * The schema surface, present with `irDocuments` when the request asked for the
   * IR. The read-only inspectors (`flamme explain`, `flamme refs`) read key fields
   * from it; there is no second, TypeScript schema index.
   */
  readonly irSchema?: NativeIrSchema | undefined;
  /** The documents this run built, rather than re-used from the cache. */
  readonly compiled: readonly string[];
  /** The state the next run continues from; opaque, kept only after the write. */
  readonly cacheState?: string | undefined;
  /** Every file the run compiled from, with its text, in walk order. */
  readonly sources: readonly NativeSource[];
}

/** The schema surface a native run reports when the caller asked for the IR. */
export interface NativeIrSchema {
  readonly possibleTypes: Readonly<Record<string, readonly string[]>>;
  readonly keyFields: Readonly<Record<string, readonly string[]>>;
  readonly enums: Readonly<Record<string, readonly string[]>>;
  readonly inputTypes: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly hash: string;
  readonly sdl: string;
  readonly defaultKeys: readonly string[];
}

/** One file the native compiler compiled from. */
export interface NativeSource {
  /** Posix path relative to `projectDir`. */
  readonly relative: string;
  /** Absolute path on disk. */
  readonly absolute: string;
  /** The file's text. */
  readonly text: string;
  /** Size in bytes. */
  readonly size: number;
  /** Modification time in milliseconds. */
  readonly mtimeMs: number;
}

/** Everything one native pass produced, in the shape the drivers consume. */
export interface RustRun {
  readonly host: CompilerHost;
  readonly response: NativeResponse;
  readonly extraction: ExtractResult;
  readonly discovered: readonly DiscoveredFile[];
  /**
   * `false` when the schema source itself could not be read: the response carries
   * that `FLM2002` and nothing else, and the driver must not run the hooks a
   * project that never reached extraction does not run.
   */
  readonly prepared: boolean;
}

/**
 * The first plugin hook the Rust compiler cannot honour, or `undefined`.
 *
 * `transformDocument`, `validate` and `afterExtract` change what the compiler
 * produces, and the compiler produces it inside Rust: the native pass compiles the
 * project before any TypeScript hook can see the IR, so a hook that would edit a
 * document or report on it would be silently ignored. There is one compiler and no
 * fallback, so a project with one of those hooks fails with an `FLM2005` diagnostic
 * that names the plugin and the hook instead of compiling something the plugin did
 * not ask for.
 *
 * `beforeEmit` and `afterEmit` are supported: they contribute files to the tree the
 * native pass returned, and `context.documents` is the rehydrated IR.
 */
export function unsupportedPluginHook(plugins: readonly CompilerPlugin[]): string | undefined {
  for (const plugin of plugins) {
    if (plugin.transformDocument !== undefined) {
      return `Compiler plugin "${plugin.name}" defines transformDocument`;
    }
    if (plugin.validate !== undefined) {
      return `Compiler plugin "${plugin.name}" defines validate`;
    }
    if (plugin.afterExtract !== undefined) {
      return `Compiler plugin "${plugin.name}" defines afterExtract`;
    }
  }
  return undefined;
}

/** True when any plugin hook reads the compiler's documents or the emit bag. */
function needsIr(plugins: readonly CompilerPlugin[]): boolean {
  return plugins.some(
    (plugin) => plugin.beforeEmit !== undefined || plugin.afterEmit !== undefined,
  );
}

/** The config subset the native compiler reads, in its own field names. */
function nativeConfig(config: ResolvedConfig): Record<string, unknown> {
  return {
    projectDir: config.projectDir,
    runtimeDir: config.runtimeDir,
    include: config.include,
    exclude: config.exclude,
    scalars: config.scalars,
    types: config.types,
    defaultKeys: config.defaultKeys,
    defaultCachePolicy: config.defaultCachePolicy,
    defaultPartial: config.defaultPartial,
    defaultPaginateMode: config.defaultPaginateMode,
    defaultListPosition: config.defaultListPosition,
    defaultListTarget: config.defaultListTarget,
    defaultFragmentMasking: config.defaultFragmentMasking,
    logLevel: config.logLevel,
    routing: config.routing ?? {},
  };
}

/**
 * The discovered files, in the request's `SourceFile` shape.
 *
 * The TypeScript walk is the author of a change-set run (`options.files`): the
 * watcher's list is the caller's own knowledge. Only the files it names are read
 * here; every other file travels as a path, and the native side serves it from the
 * cache or reads it when its stamp says it changed behind the watcher's back. The
 * walk still has to be complete: the generated tree describes the whole project.
 */
async function readSources(
  discovered: readonly DiscoveredFile[],
  files: readonly string[],
): Promise<{ relative: string; absolute: string; text: string; size: number; mtimeMs: number }[]> {
  const changed = new Set(files);
  return Promise.all(
    discovered.map(async (file) => {
      if (!changed.has(file.relative)) {
        return { relative: file.relative, absolute: file.absolute, text: '', size: 0, mtimeMs: 0 };
      }
      const text = await readFile(file.absolute, 'utf8');
      const info = await stat(file.absolute);
      return {
        relative: file.relative,
        absolute: file.absolute,
        text,
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    }),
  );
}

/** The `FLM2002` diagnostic a schema source that cannot be read reports. */
function schemaFailure(message: string): Diagnostic {
  return createDiagnostic({
    code: 'FLM2002',
    severity: 'error',
    message,
    location: { file: 'flamme.config.ts', line: 1, column: 1, length: 1 },
  });
}

/**
 * Runs one native compile: discovery, file reading, the schema source, the
 * committed persisted manifest, the call, and the rehydrated extraction.
 *
 * `extra.includeIr` asks for the full IR even when no plugin hook needs it: the
 * read-only inspectors (`flamme explain`, `flamme refs`) read the compiler's own
 * documents, so they go through this same entry point with the same backend
 * selection `generate` uses.
 */
export async function runNative(
  config: ResolvedConfig,
  options: GenerateOptions,
  diagnostics: Diagnostic[],
  plugins: readonly CompilerPlugin[],
  extra: {
    readonly includeIr?: boolean;
    /**
     * The composed route documents of this run, when the caller planned them (`options.routeDocuments`
     * is the same input through the driver, and this member is how the two-pass path hands them to
     * its second native call).
     */
    readonly routeDocuments?: readonly RouteDocument[];
    /** The native cache state a previous call of this same run returned, so the second call reuses it. */
    readonly previousCache?: string | undefined;
    /** Forces the request to carry a cache state, even when the caller keeps none. */
    readonly saveCache?: boolean;
    /**
     * The change set this request carries, overriding `options.files`.
     *
     * The two-pass composition path uses it to make its second call a change-set run (`[]`, an
     * empty change set) whose cache the first call filled: every file is re-used and only the
     * composed documents are extracted, while the request's `files` still has to list the whole
     * project, which is what the walk below produces.
     */
    readonly changeSet?: readonly string[] | undefined;
  } = {},
): Promise<RustRun> {
  const native = loadNativeModule();
  if (native === undefined) {
    // There is one compiler, so a missing binding is a failed run: the diagnostic
    // names the build command, and `generate` reports it like a schema failure
    // (nothing is written, nothing is deleted).
    diagnostics.push(
      createDiagnostic({
        code: 'FLM2002',
        severity: 'error',
        message: missingCompilerMessage(),
        location: { file: 'flamme.config.ts', line: 1, column: 1, length: 1 },
      }),
    );
    const host = createCompilerHost(config, {
      plugins,
      defaults: [],
      run: { check: options.check === true || options.update === false, persisted: false },
      diagnostics,
    });
    return { host, response: emptyResponse(), extraction: emptyExtraction(), discovered: [], prepared: false };
  }

  const inputsStarted = performance.now();
  const files = extra.changeSet ?? options.files;
  // A full run lets the native side own discovery and reading; a change-set run
  // keeps the TypeScript walk (the watcher's list) and reads the files it names.
  const discovered =
    files === undefined
      ? []
      : await walkFiles(config.projectDir, config.include, config.exclude, diagnostics);
  const sources = files === undefined ? [] : await readSources(discovered, files);
  let schema: Awaited<ReturnType<typeof readSchemaSourceForCompiler>> | undefined;
  let failure: string | undefined;
  try {
    schema = await readSchemaSourceForCompiler(config);
  } catch (error) {
    // A schema source that cannot be read is a diagnostic, not a throw: the caller
    // reports it exactly as the TypeScript pipeline's `loadSchema` failure.
    failure = errorMessage(error);
  }
  options.onPhase?.({ phase: 'inputs', ms: performance.now() - inputsStarted });
  const check = options.check === true || options.update === false;
  const persisted = options.persisted === true;
  const persistedPath = toPosix(
    relative(config.projectDir, join(config.runtimeDir, 'persisted.json')),
  );
  const committed =
    persisted && check
      ? await readFile(join(config.runtimeDir, 'persisted.json'), 'utf8').catch(() => undefined)
      : undefined;

  const host = createCompilerHost(config, {
    plugins,
    defaults: [],
    run: { check, persisted, ...(options.files === undefined ? {} : { files: options.files }) },
    diagnostics,
  });
  if (schema === undefined) {
    diagnostics.push(schemaFailure(failure ?? 'the schema source could not be read'));
    return {
      host,
      response: emptyResponse(),
      extraction: emptyExtraction(),
      discovered,
      prepared: false,
    };
  }

  // The synthetic composed route documents of the run: they have no file on disk, so they travel
  // in the request and the session appends them to its source list after the walk.
  const routeDocuments = (extra.routeDocuments ?? options.routeDocuments ?? []).map((document) => ({
    name: document.name,
    relative: document.relativePath,
    absolute: document.absolute,
    text: document.raw,
    size: 0,
    mtimeMs: 0,
  }));

  const request = {
    config: nativeConfig(config),
    schema: { sdl: schema.sdl, file: schema.file },
    ...(files === undefined ? {} : { files: sources, sources: files }),
    options: {
      check,
      persisted,
      ...(files === undefined ? {} : { files }),
      includeIr: extra.includeIr === true || needsIr(plugins),
      // Only a caller with a cache to keep pays for one: the state carries the IR of
      // every document, and the CLI (which passes no cache) would serialize it into
      // a value it drops.
      saveCache: options.cache !== undefined || extra.saveCache === true,
    },
    persistedCommitted: committed ?? null,
    persistedPath,
    cache: extra.previousCache ?? options.cache?.native ?? null,
    ...(routeDocuments.length === 0 ? {} : { routeDocuments }),
  };

  const nativeStarted = performance.now();
  let response: NativeResponse;
  try {
    const requestJson = JSON.stringify(request);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the native module's own contract
    response = JSON.parse(
      files === undefined ? native.compileProject(requestJson) : native.compile(requestJson),
    ) as NativeResponse;
  } catch (error) {
    throw new CompileError([
      ...diagnostics,
      schemaFailure(`the Rust compiler failed: ${errorMessage(error)}`),
    ]);
  }

  options.onPhase?.({ phase: 'native', ms: performance.now() - nativeStarted });
  diagnostics.push(...response.diagnostics);
  return {
    host,
    response,
    extraction: rehydrateExtraction(response, response.sources, response.sources),
    discovered: response.sources.map((source) => ({
      relative: source.relative,
      absolute: source.absolute,
    })),
    prepared: true,
  };
}

/** The response of a run that never reached the native compiler. */
function emptyResponse(): NativeResponse {
  return {
    files: [],
    diagnostics: [],
    artifacts: [],
    extractionDiagnostics: [],
    documents: [],
    imports: [],
    importedNames: [],
    compiled: [],
    cacheState: undefined,
    sources: [],
  };
}

/** The extraction of a run that never reached the native compiler. */
function emptyExtraction(): ExtractResult {
  return {
    documents: [],
    diagnostics: [],
    imports: [],
    importedNames: [],
    files: [],
    byFile: new Map(),
  };
}

/** The surface spelling the extraction reports, as the TypeScript union. */
function surfaceOf(value: string): DocumentSurface {
  if (value === 'tag' || value === 'script' || value === 'composed') {
    return value;
  }
  return 'file';
}

/** Rebuilds the `ExtractResult` the Vite route pass and the plugin context read. */
export function rehydrateExtraction(
  response: NativeResponse,
  sources: readonly { readonly relative: string; readonly text: string }[],
  discovered: readonly DiscoveredFile[],
): ExtractResult {
  const texts = new Map(sources.map((source) => [source.relative, source.text]));
  const documents: RawDocument[] = response.documents.map((document) => ({
    name: document.name,
    kind: document.kind,
    raw: document.raw,
    file: document.file,
    relativePath: document.relativePath,
    surface: surfaceOf(document.surface),
    offset: document.offset,
    start: document.start,
    end: document.end,
    sourceOffsets: document.sourceOffsets,
    ast: parse(document.raw),
    source: texts.get(document.relativePath) ?? '',
  }));
  const imports: GqlImport[] = response.imports.map((entry) => ({
    file: entry.file,
    relativePath: entry.relativePath,
    specifier: entry.specifier,
    resolved: entry.resolved,
    offset: entry.offset,
    source: texts.get(entry.relativePath) ?? '',
  }));
  return {
    documents,
    diagnostics: response.extractionDiagnostics,
    imports,
    importedNames: response.importedNames,
    files: discovered,
    // The incremental cache is a TypeScript-side structure; a native run compiles
    // the whole project every time, so it reports no per-file records.
    byFile: new Map(),
  };
}

/**
 * A record the native side may send either as a JSON object (a `JsObject`) or as
 * an array of pairs (a Rust `Vec<(String, T)>`), rebuilt as a `Map`.
 */
function pairMap<T>(
  value: Readonly<Record<string, T>> | readonly (readonly [string, T])[] | undefined,
): Map<string, T> {
  if (value === undefined) {
    return new Map();
  }
  if (Array.isArray(value)) {
    return new Map(value as readonly (readonly [string, T])[]);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record shape this branch tests for
  return new Map(Object.entries(value as Readonly<Record<string, T>>));
}

/**
 * Rebuilds the IR documents the plugin host exposes, when the request asked.
 *
 * The native response carries every artifact, including the pagination companions a
 * paginated fragment generates; those are not extracted documents, so the plugin
 * surface keeps only the documents the project actually wrote. This is also the
 * shape `flamme explain` and `flamme refs` read, so the two inspectors see the
 * compiler's own IR rather than a second, TypeScript one.
 */
export function rehydrateIrDocuments(
  response: NativeResponse,
  extraction: ExtractResult,
): readonly IrDocument[] {
  const byName = new Map(extraction.documents.map((document) => [document.name, document]));
  const documents: IrDocument[] = [];
  for (const document of response.irDocuments ?? []) {
    const raw = byName.get(document.name);
    if (raw === undefined) {
      continue;
    }
    documents.push(rehydrateDocument(withoutAbsentNulls(document), raw));
  }
  return documents;
}

/**
 * The schema surface the inspectors read, rebuilt from the native response.
 *
 * The native compiler indexes the SDL inside Rust; the response carries the subset a
 * read-only driver acts on (key fields, possible types, enums, inputs, hash, SDL).
 * `undefined` when the response has none, which is a schema that never indexed: the
 * caller then has no documents either.
 */
export function rehydrateSchemaIndex(response: NativeResponse): SchemaIndex | undefined {
  const schema = response.irSchema;
  if (schema === undefined) {
    return undefined;
  }
  const keyFields = schema.keyFields;
  return {
    possibleTypes: schema.possibleTypes,
    keyFields,
    keyFieldsForType: (type: string): readonly string[] => keyFields[type] ?? [],
    isEmbedded: (type: string): boolean => (keyFields[type] ?? []).length === 0,
    enums: schema.enums,
    inputTypes: schema.inputTypes,
    hash: schema.hash,
    sdl: schema.sdl,
  };
}

/**
 * The response document with every `null` member removed.
 *
 * A Rust `Option::None` reaches JSON as `null` unless the field carries
 * `skip_serializing_if`, and the TypeScript IR spells absence as an absent member:
 * `refetch` is `undefined` for a document that does not paginate, never `null`, and
 * an emitter that reads `document.refetch.path` would throw on the null. Treating the
 * two as the same thing at the boundary is what keeps the rehydrated IR the same
 * shape the TypeScript pipeline hands its plugins.
 */
function withoutAbsentNulls(document: NativeIrDocument): NativeIrDocument {
  const entries = Object.entries(document).filter(([, value]) => value !== null);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same member names, with the null members dropped
  return Object.fromEntries(entries) as unknown as NativeIrDocument;
}

/** One IR document from the response, with its `RawDocument` reattached. */
function rehydrateDocument(document: NativeIrDocument, raw: RawDocument | undefined): IrDocument {
  {
    const fallback: RawDocument = {
      name: document.name,
      kind: document.kind,
      raw: document.raw,
      file: document.file,
      relativePath: document.source,
      surface: 'file',
      offset: 0,
      start: 0,
      end: 0,
      sourceOffsets: [],
      ast: parse(document.raw),
      source: '',
    };
    return {
      name: document.name,
      kind: document.kind,
      raw: document.raw,
      hash: document.hash,
      file: document.file,
      source: document.source,
      rootType: document.rootType,
      selection: document.selection,
      input: document.input,
      ...(document.refetch === undefined ? {} : { refetch: document.refetch }),
      // The compiler's own plugin data (what `@dedupe` and friends contribute), which
      // the native IR computes too: a plugin that reads `context.documents[].pluginData`
      // sees what the TypeScript pipeline would show it. The emitters write `{}` into
      // the artifact literal on both sides, so this member is for plugins only.
      pluginData: document.pluginData ?? {},
      ...(document.enableLoadingState === undefined
        ? {}
        : { enableLoadingState: document.enableLoadingState }),
      ...(document.policy === undefined ? {} : { policy: document.policy }),
      ...(document.partial === undefined ? {} : { partial: document.partial }),
      paginated: document.paginated,
      lists: document.lists,
      ...(document.deferred === undefined ? {} : { deferred: document.deferred }),
      ...(document.paginationCompanion === undefined
        ? {}
        : { paginationCompanion: document.paginationCompanion }),
      ...(document.optimisticKeys === undefined ? {} : { optimisticKeys: document.optimisticKeys }),
      injectedKeys: pairMap(document.injectedKeys),
      fragmentTypes: pairMap(document.fragmentTypes),
      fragmentSelections: pairMap(document.fragmentSelections),
      ast: raw?.ast ?? parse(document.raw),
      // The extracted document is preferred: it carries the file's text and the
      // `sourceOffsets` map, which is what a read-only inspector turns an AST `loc`
      // into a `file:line:column` with. The fallback serves a document the extraction
      // did not produce (a pagination companion), whose offsets only make sense
      // against its own text.
      document: raw ?? fallback,
    };
  }
}

/**
 * The document name an `artifacts/<name>.ts` path belongs to, or `undefined` for
 * every other path (the aggregate members, and a plugin's own module under
 * `artifacts/` with a nested path).
 */
export function artifactNameOf(path: string): string | undefined {
  if (!path.startsWith('artifacts/') || !path.endsWith('.ts')) {
    return undefined;
  }
  const name = path.slice('artifacts/'.length, -'.ts'.length);
  return name.includes('/') || name.length === 0 ? undefined : name;
}

/**
 * Fills the emit bag from a native response, runs the plugin host's emit hooks and
 * returns the host plus the documents the stale sweep must keep.
 *
 * `artifacts`, when given, is the set of documents this run re-serializes: the
 * artifact modules of every other document stay out of the bag, because the native
 * response only carries them when their file is missing on disk. The aggregate
 * members are always set: they describe the whole project and the writer compares
 * them before it writes.
 */
export async function prepareNativeTree(
  run: RustRun,
  plugins: readonly CompilerPlugin[],
  artifacts?: ReadonlySet<string>,
): Promise<{ host: CompilerHost; documentNames: readonly string[] }> {
  const host = run.host;
  await host.resolveConfig();
  await host.beforeExtract();
  for (const file of run.response.files) {
    const name = artifactNameOf(file.path);
    if (artifacts !== undefined && name !== undefined && !artifacts.has(name)) {
      continue;
    }
    host.emit.set(file.path, file.contents);
  }
  // The built-in output is the native tree, so the host's own document list is the
  // native IR when a plugin hook needs it.
  const documents = needsIr(plugins) ? rehydrateIrDocuments(run.response, run.extraction) : [];
  await host.afterExtract([...run.extraction.documents]);
  for (const document of documents) {
    // `transformDocument` is not supported on this backend (`needsTypeScriptPipeline`
    // rejects it), so this only records the document in the host context.
    // oxlint-disable-next-line eslint/no-await-in-loop -- document order is the run's order
    await host.transformDocument(document);
  }
  return { host, documentNames: run.response.artifacts.map((artifact) => artifact.name) };
}

/** The schema source path the driver reports for a schema that could not load. */
export const NATIVE_SCHEMA_FILE = 'flamme.config.ts';

/** Re-exported so the driver can resolve a schema path the same way `loadConfig` does. */
export function absoluteSchemaPath(config: ResolvedConfig, path: string): string {
  return toPosix(resolvePath(config.projectDir, path));
}

/** Unused re-export guard: keeps `CompileError` reachable for callers of this module. */
export { CompileError, hasErrors };

/** The native module, for tests that need to check it is the Rust one. */
export function nativeModuleOrUndefined(): NativeModule | undefined {
  return loadNativeModule();
}
