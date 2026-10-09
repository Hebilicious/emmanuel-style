/**
 * The generation driver both the CLI and the Vite plugin call (`spec/spec.md`
 * §4, §10.1): compile, then write the tree the compiler returned, deterministic,
 * with stale-artifact deletion and a check mode that writes nothing.
 *
 * One compiler: the Rust crate (`crates/flamme-core`) reached through the napi
 * binding. This file is orchestration only: resolve the config, hand the native
 * compiler one JSON request (plus the files a change set names), run the plugin
 * host over the tree it returned and land it with the atomic writer. Discovery,
 * reading, the incremental cache, schema indexing, extraction, validation, the IR
 * and emit all happen inside Rust; a run without the built module is an `FLM2002`
 * failure, not a different compiler.
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { loadConfig, resolveConfig, type FlammeConfig, type ResolvedConfig } from './config.js';
import {
  prepareNativeTree,
  rehydrateIrDocuments,
  rehydrateSchemaIndex,
  runNative,
  unsupportedPluginHook,
  type NativeArtifact,
  type RustRun,
} from './rust-backend.js';
import {
  CompileError,
  EmitError,
  createDiagnostic,
  errorMessage,
  hasErrors,
  type Diagnostic,
} from './diagnostics.js';
import { type ExtractResult, type PhaseObserver } from './extract.js';
import { type IrDocument } from './ir.js';
import { artifactModulePath, compareNames } from './naming.js';
import { toPosix } from './offsets.js';
import { type CompilerHost, type RouteDocument } from './plugins/host.js';
import { type SchemaIndex } from './schema.js';

/** One compiled artifact, as `manifest.json` and the drivers see it. */
export interface CompiledArtifact {
  readonly name: string;
  readonly kind: IrDocument['kind'];
  readonly hash: string;
  readonly raw: string;
  /** Absolute path of the source file. */
  readonly file: string;
  /** Posix path relative to `projectDir`. */
  readonly source: string;
  /** Path relative to `runtimeDir` (`artifacts/Info.ts`). */
  readonly artifactFile: string;
  readonly paginated: readonly (readonly string[])[];
  readonly lists: readonly string[];
}

/** What `compileProject` and `generate` return. */
export interface CodegenResult {
  readonly artifacts: readonly CompiledArtifact[];
  readonly diagnostics: readonly Diagnostic[];
  /** Files written by this run, relative to `runtimeDir`; empty in check mode. */
  readonly written: readonly string[];
  /**
   * The documents this run rebuilt, by their **compiler** names: the names the
   * extraction found, before any `transformDocument` hook renamed them. Every other
   * document came from the cache. The artifact-name set the emit bag is keyed by is
   * not this list (see `RunResult.compiledArtifacts`).
   */
  readonly compiled: readonly string[];
  /**
   * The extraction this run performed, so a caller that also needs the raw
   * documents (the Vite plugin's route pass) does not walk and parse the project
   * a second time. `undefined` only when the schema failed to load.
   */
  readonly extraction: ExtractResult | undefined;
}

/**
 * The full IR of a project: what the read-only inspection drivers (`flamme
 * explain`, `flamme refs`) need beyond `CompiledArtifact`, without writing
 * anything.
 */
export interface CompiledProject {
  readonly documents: readonly IrDocument[];
  readonly diagnostics: readonly Diagnostic[];
  /** `undefined` when the schema could not be loaded; `documents` is empty then. */
  readonly schema: SchemaIndex | undefined;
}

/** Options shared by the drivers. */
export interface GenerateOptions {
  /** Restricts extraction to these project-relative posix paths (incremental rebuild). */
  readonly files?: readonly string[];
  /** `false` is check mode: nothing is written or deleted. Default `true`. */
  readonly update?: boolean;
  /** Alias for `update: false`. */
  readonly check?: boolean;
  /**
   * Persisted queries (`research/answers-report.md` Q4): write
   * `<runtimeDir>/persisted.json` and register it in `manifest.json`. In check
   * mode nothing is written and a missing or stale manifest is reported as
   * `FLM1025`, which is what lets CI enforce the committed file. Default `false`:
   * a plain run produces exactly the tree it produced before this option existed.
   */
  readonly persisted?: boolean;
  /** Phase measurements; nothing else reads them. */
  readonly onPhase?: PhaseObserver;
  /**
   * State the previous run of the same project left behind, so this one can skip
   * every file and document the change set cannot affect. Only meaningful with
   * `files`; a cache without a change set still re-reads and re-parses the project.
   */
  readonly cache?: GenerateCache;
  /**
   * An extraction the caller already performed, reused instead of walking the project again.
   *
   * The Vite codegen driver extracts once, plans the route composition from that extraction and
   * hands both back here, so one pass reads and parses the project once. The extraction must have
   * been made with the same config (and, for a change-set run, the same `files`/`previous`) the run
   * would have used; `@flamme/vite` builds it exactly that way.
   */
  readonly extraction?: ExtractResult;
  /**
   * Synthetic route documents to compile in this run
   * (`research/route-composition-design.md` §4.1).
   *
   * The Vite codegen driver plans them before the compile (it needs the extraction, which it
   * already has) and hands them over here, so they are validated, IR'd, emitted and manifested
   * exactly like discovered documents in one pass. When this is absent, a plugin that implements
   * `routeDocuments` supplies them instead (the CLI path, where `generate()` is the only driver).
   */
  readonly routeDocuments?: readonly RouteDocument[];
}

/**
 * What one `generate` call may hand to the next.
 *
 * The Vite plugin keeps one of these for the life of a dev server. It is opt-in
 * because a cache is only valid while the caller owns change detection: `files`
 * must name every source that changed since the previous run, and no compiler
 * plugin may mutate an `IrDocument` in place (`plugin.validate` receives one).
 *
 * A run installs its state only once its tree is on disk, so the cache always
 * describes what was written: a run that fails before or during the write leaves
 * the previous state in place, and the next run rebuilds the documents whose
 * modules it never landed.
 */
export interface GenerateCache {
  /** The previous extraction, reused per file. */
  extraction?: ExtractResult;
  /** Fragment name to its raw text in the previous run, for dependency checks. */
  fragmentRaws?: ReadonlyMap<string, string>;
  /** Document name to the IR the previous run built. */
  documents?: ReadonlyMap<string, IrDocument>;
  /** The schema hash the previous run compiled against. */
  schemaHash?: string;
  /** The `@list` registrations of the previous run. */
  lists?: string;
  /**
   * The Rust backend's session state, opaque to TypeScript
   * (`crates/flamme-core/src/session.rs`). It carries the per-file extraction and
   * the IR of every document, so a native run compiles only what changed; the
   * TypeScript fields above are the oracle's own cache and are never mixed with it.
   */
  native?: string;
}

/**
 * The state one run would record in the caller's {@link GenerateCache}. The
 * TypeScript pipeline fills the first five members; a native run fills `native`.
 */
interface CacheState {
  readonly extraction?: ExtractResult;
  readonly fragmentRaws?: ReadonlyMap<string, string>;
  readonly documents?: ReadonlyMap<string, IrDocument>;
  readonly schemaHash?: string;
  readonly lists?: string;
  readonly native?: string;
}

/**
 * Installs what a run compiled. It is called only once the tree the state
 * describes is on disk: a run whose write did not land may not claim that its
 * documents are current, or the artifact an unfinished run left behind would
 * never be rebuilt (`emitProject`'s missing-module repair only sees a file that
 * is gone, not one carrying older bytes).
 */
function commitCache(cache: GenerateCache | undefined, state: CacheState | undefined): void {
  if (cache === undefined || state === undefined) {
    return;
  }
  if (state.native !== undefined) {
    // A native run advances the native state and invalidates the oracle's: the two
    // describe the tree in different shapes, and a run of the other backend would
    // read the wrong one.
    cache.native = state.native;
    delete cache.extraction;
    delete cache.documents;
    delete cache.fragmentRaws;
    delete cache.schemaHash;
    delete cache.lists;
    return;
  }
  if (state.extraction !== undefined) {
    cache.extraction = state.extraction;
  }
  if (state.documents !== undefined) {
    cache.documents = state.documents;
  }
  if (state.fragmentRaws !== undefined) {
    cache.fragmentRaws = state.fragmentRaws;
  }
  if (state.schemaHash !== undefined) {
    cache.schemaHash = state.schemaHash;
  }
  if (state.lists !== undefined) {
    cache.lists = state.lists;
  }
  delete cache.native;
}

interface RunResult {
  readonly config: ResolvedConfig;
  readonly extracted: ExtractResult | undefined;
  /**
   * Every document this run describes, after `transformDocument`. It is what the
   * stale sweep must keep in `artifacts/`, and what {@link emitSet} walks.
   */
  readonly documentNames: readonly string[];
  /**
   * `false` when the run never reached a tree (a schema that did not load): nothing
   * is emitted and nothing is deleted.
   */
  readonly emittable: boolean;
  /**
   * The artifacts this run re-serializes: the compiler computes them before the emit
   * bag is filled, because the native response leaves out the documents it re-used
   * whose module is already on disk. `undefined` means "every artifact", which is
   * what a caller with no cache gets.
   */
  readonly emitArtifacts?: ReadonlySet<string> | undefined;
  /** Names of the documents this run built, rather than reused from the cache. */
  readonly compiled: readonly string[];
  /**
   * The **artifact** names this run rebuilt: the names above after every
   * `transformDocument` hook, which is what the emit bag is keyed by. A hook that
   * renames a document would otherwise leave the artifact it renamed out of the
   * incremental re-serialization set.
   */
  readonly compiledArtifacts: ReadonlySet<string>;
  /**
   * What this run would record in the caller's cache, once `emitProject` has put
   * the tree it describes on disk. `undefined` when there is no cache to update
   * or the run never reached the IR stage.
   */
  readonly cacheState: CacheState | undefined;
  readonly diagnostics: readonly Diagnostic[];
  /** The plugin host of this run; `emitProject` fills the bag through it. */
  readonly host: CompilerHost;
}

/**
 * Re-locates the diagnostics of the synthetic composed documents.
 *
 * A composed document has no file on disk, so a diagnostic that points into one sends the reader to
 * a path they cannot open. Two things can be said about such a finding, and this is where the run
 * decides which it is:
 *
 * - the **same** finding already exists for a participant (the composed document spreads the same
 *   fragment, selects the same field), so it is the participant's own warning re-reported once per
 *   composition: it is dropped, which is what keeps a three-record chain from printing the same
 *   sentence three times;
 * - the finding exists **only** in the union (a rule the composer did not model), so it is kept and
 *   moved to the record's own file with the composed document named in the message. Failing loudly
 *   is deliberate: the composed document is real, and a project must not ship one the compiler
 *   rejected.
 */
function relocateComposedDiagnostics(
  diagnostics: readonly Diagnostic[],
  sources: readonly RouteDocument[],
): readonly Diagnostic[] {
  if (sources.length === 0) {
    return diagnostics;
  }
  const byPath = new Map(sources.map((source) => [source.relativePath, source]));
  const kept: Diagnostic[] = [];
  const located = new Set<string>();
  const pending: { readonly diagnostic: Diagnostic; readonly source: RouteDocument }[] = [];
  for (const diagnostic of diagnostics) {
    const source = byPath.get(diagnostic.location.file);
    if (source === undefined) {
      kept.push(diagnostic);
      located.add(`${diagnostic.code}|${diagnostic.message}`);
      continue;
    }
    pending.push({ diagnostic, source });
  }
  for (const { diagnostic, source } of pending) {
    if (located.has(`${diagnostic.code}|${diagnostic.message}`)) {
      continue;
    }
    kept.push({
      ...diagnostic,
      message:
        `${diagnostic.message} (this finding is in the composed document "${source.name}" of the ` +
        `route "${source.record}", which merges ${source.participants.map((name) => `"${name}"`).join(', ')})`,
      location: { file: source.file, line: 1, column: 1, length: 1 },
    });
  }
  return kept;
}

/** Runs `body`, reporting its wall-clock time to `observe` under `phase`. */
async function timed<T>(
  observe: PhaseObserver | undefined,
  phase: string,
  body: () => Promise<T>,
): Promise<T> {
  if (observe === undefined) {
    return body();
  }
  const started = performance.now();
  try {
    return await body();
  } finally {
    observe({ phase, ms: performance.now() - started });
  }
}

/**
 * Runs one native compile, composing the route documents when a plugin plans them.
 *
 * A caller that already extracted and planned (`@flamme/vite`'s codegen driver) passes
 * `routeDocuments`, and the run is a single native call whose request carries them. A caller that
 * did not - `flamme generate`, where `generate()` is the only driver - has no extraction in
 * TypeScript, so this runs the native compiler twice: the first call compiles the project and
 * returns what it extracted, the plugin host plans the composition from that, and the second call
 * carries the composed documents and the first call's cache state. The second call is a change-set
 * run with an empty change set, so it re-uses every file the first call read and extracts only the
 * composed documents, which are a handful of small queries.
 */
async function runNativeComposed(
  config: ResolvedConfig,
  options: GenerateOptions,
  diagnostics: Diagnostic[],
  extra: { readonly includeIr?: boolean } = {},
): Promise<RustRun> {
  const plugins = config.plugins ?? [];
  const composes = plugins.some((plugin) => plugin.routeDocuments !== undefined);
  if (options.routeDocuments !== undefined || !composes) {
    const direct = await runNative(config, options, diagnostics, plugins, extra);
    const sources = options.routeDocuments ?? [];
    if (sources.length > 0) {
      const relocated = relocateComposedDiagnostics(diagnostics, sources);
      diagnostics.splice(0, diagnostics.length, ...relocated);
    }
    return direct;
  }
  const before = diagnostics.length;
  const first = await runNative(config, options, diagnostics, plugins, {
    ...extra,
    saveCache: true,
  });
  if (!first.prepared) {
    // The schema source could not be read: there is no extraction to plan a composition from.
    return first;
  }
  const afterFirst = diagnostics.length;
  const composed = await first.host.routeDocuments(first.extraction.documents);
  // The composer's own findings, kept aside: the first pass's list is superseded by the second
  // pass's (which compiles the same project plus the composed documents) and is dropped below.
  const composedDiagnostics = diagnostics.splice(afterFirst);
  if (composed === undefined || composed.documents.length === 0) {
    diagnostics.push(...composedDiagnostics);
    return first;
  }
  diagnostics.length = before;
  const second = await runNative(config, options, diagnostics, plugins, {
    ...extra,
    routeDocuments: composed.documents,
    previousCache: first.response.cacheState,
    ...(options.files === undefined ? { changeSet: [] } : {}),
  });
  diagnostics.push(...composedDiagnostics);
  const relocated = relocateComposedDiagnostics(diagnostics, composed.documents);
  diagnostics.splice(0, diagnostics.length, ...relocated);
  // The run rebuilt what its two passes rebuilt, and it reports that as one list in document order:
  // the first pass compiled everything the second one re-used from its cache, so a caller that
  // serializes `compiled` (the incremental emit set) sees the same documents the single-pass
  // pipeline would have rebuilt.
  const rebuilt = new Set([...first.response.compiled, ...second.response.compiled]);
  // The tree is the union of both passes', the second winning a path it also carries. The second
  // pass re-uses the first pass's cache, so it *omits* the artifact of a document the first pass
  // rebuilt whose module is already on disk - and that module holds the bytes from before the
  // edit. Landing only the second pass's tree would leave the changed document's artifact stale
  // (the composed route's own artifact would move while its participant stayed behind), so the
  // first pass's artifacts travel with it. A path both passes carry is the second pass's: only it
  // compiled the composed documents the aggregate members describe.
  const files = new Map(first.response.files.map((file) => [file.path, file]));
  for (const file of second.response.files) {
    files.set(file.path, file);
  }
  return {
    ...second,
    response: {
      ...second.response,
      files: [...files.values()],
      compiled: second.response.artifacts
        .map((artifact) => artifact.name)
        .filter((name) => rebuilt.has(name)),
    },
  };
}

/**
 * Compiles a resolved config without writing, throwing `CompileError` when an error
 * diagnostic exists (§4.9). A `cache` passed here is read but never advanced: it
 * describes the tree a previous write left.
 */
export async function compileProject(
  config: ResolvedConfig,
  options: GenerateOptions = {},
): Promise<CodegenResult> {
  const unsupported = unsupportedPluginDiagnostic(config);
  if (unsupported !== undefined) {
    throw new CompileError([unsupported]);
  }
  return compileProjectWithRust(config, options);
}

/**
 * The diagnostic for a plugin hook the Rust compiler cannot honour, or `undefined`.
 *
 * There is no fallback compiler: a project whose plugin needs the compiler's own IR
 * in TypeScript fails with `FLM2005` naming the plugin and the hook, rather than
 * compiling a document the hook never saw.
 */
function unsupportedPluginDiagnostic(config: ResolvedConfig): Diagnostic | undefined {
  const unsupported = unsupportedPluginHook(config.plugins ?? []);
  if (unsupported === undefined) {
    return undefined;
  }
  return createDiagnostic({
    code: 'FLM2005',
    severity: 'error',
    message: `${unsupported}, which the Rust compiler cannot run: the IR lives in Rust and is not handed back to a hook that would change it.`,
    hint: 'remove the hook, or report the finding without changing the documents',
    location: { file: 'flamme.config.ts', line: 1, column: 1, length: 1 },
  });
}

/** The native compile without a write, for `compileProject`. */
async function compileProjectWithRust(
  config: ResolvedConfig,
  options: GenerateOptions,
): Promise<CodegenResult> {
  const diagnostics: Diagnostic[] = [];
  const nativeRun = await runNativeComposed(config, options, diagnostics);
  if (!nativeRun.prepared) {
    // The schema source could not be read: the TypeScript pipeline stops before
    // `beforeExtract`, and so does this one.
    await nativeRun.host.resolveConfig();
    throw new CompileError(diagnostics);
  }
  const { host } = await prepareNativeTree(nativeRun, config.plugins);
  await host.beforeEmit();
  if (hasErrors(diagnostics)) {
    throw new CompileError(diagnostics);
  }
  return {
    artifacts: nativeRun.response.artifacts.map(toCompiledArtifact),
    diagnostics,
    written: [],
    compiled: nativeRun.response.compiled,
    extraction: nativeRun.extraction,
  };
}

/** One native artifact, as `CodegenResult.artifacts` reports it. */
function toCompiledArtifact(artifact: NativeArtifact): CompiledArtifact {
  return {
    name: artifact.name,
    kind: artifact.kind,
    hash: artifact.hash,
    raw: artifact.raw,
    file: artifact.file,
    source: artifact.source,
    artifactFile: artifact.artifactFile,
    paginated: artifact.paginated,
    lists: artifact.lists,
  };
}

/**
 * The native generate: one compile, the plugin host over the tree it returned, and
 * the ordinary atomic write. Check mode and a failed compile write nothing, exactly
 * like the TypeScript path.
 *
 * The write runs through {@link emitProject}, so the emit set, the plugins'
 * `beforeEmit`, the atomic writer with its rollback and tombstones and the cache
 * commit are the same code the TypeScript backend uses. The native side reports
 * which documents it rebuilt and the state the next run continues from; the tree it
 * returned already carries the artifacts of the documents this run re-serializes.
 */
async function generateWithRust(
  config: ResolvedConfig,
  options: GenerateOptions,
  diagnostics: Diagnostic[],
): Promise<CodegenResult> {
  const nativeRun = await runNativeComposed(config, options, diagnostics);
  const artifacts = nativeRun.response.artifacts.map(toCompiledArtifact);
  const compiled = nativeRun.response.compiled;
  if (!nativeRun.prepared) {
    // The schema source could not be read: no tree, no write, nothing deleted.
    await nativeRun.host.resolveConfig();
    return {
      artifacts,
      diagnostics,
      written: [],
      compiled,
      extraction: undefined,
    };
  }
  const documentNames = artifacts.map((artifact) => artifact.name);
  // The emit set is computed before the bag is filled: the native response leaves
  // out the artifacts it re-used and whose module is already on disk, and the bag
  // must not put them back (`landTree` would compare the whole tree otherwise).
  const compiledArtifacts = new Set(compiled);
  const emitArtifacts = await emitSet({
    config,
    documentNames,
    emittable: true,
    compiled,
    compiledArtifacts,
  });
  const { host } = await prepareNativeTree(nativeRun, config.plugins, emitArtifacts);
  const result: RunResult = {
    config,
    extracted: nativeRun.extraction,
    documentNames,
    emittable: !hasErrors(diagnostics),
    emitArtifacts,
    compiled,
    compiledArtifacts,
    cacheState:
      nativeRun.response.cacheState === undefined
        ? undefined
        : { native: nativeRun.response.cacheState },
    diagnostics,
    host,
  };
  const check = options.check === true || options.update === false;
  if (hasErrors(diagnostics) || check) {
    // Check mode is read-only: `beforeEmit` still runs, because a plugin decides
    // what check mode reports, and the bag it fills is discarded.
    await host.beforeEmit();
    return {
      artifacts,
      diagnostics,
      written: [],
      compiled,
      extraction: nativeRun.extraction,
    };
  }
  let written: readonly string[];
  try {
    // `emitProject` runs `beforeEmit` with the emit set, writes the bag, rolls a
    // failed batch back and commits the cache only once the tree is on disk.
    written = await emitProject(result, options);
  } catch (error) {
    const code = error instanceof EmitError ? error.code : 'FLM2003';
    return {
        artifacts,
      diagnostics: [
        ...diagnostics,
        createDiagnostic({
          code,
          severity: 'error',
          message: errorMessage(error),
          location: { file: 'flamme.config.ts', line: 1, column: 1, length: 1 },
        }),
      ],
      written: [],
      compiled,
      extraction: nativeRun.extraction,
    };
  }
  return {
    artifacts,
    diagnostics,
    written,
    compiled,
    extraction: nativeRun.extraction,
  };
}


/**
 * Compiles a resolved config and returns the full IR (documents, their
 * selections and the schema index) plus every diagnostic; writes nothing and
 * never throws, so a read-only driver can report the same diagnostics `check`
 * does. This is the seam `flamme explain` and `flamme refs` read.
 *
 * The Rust compiler compiles the project, so `explain`/`refs` and `generate`/`check`
 * cannot contradict each other: they are the same compiler over the same documents.
 *
 * `options` carries what a caller needs beyond the config: `routeDocuments` for a
 * project whose records compose (the composed documents are compiled in the same
 * pass and come back with the rest), `files` for a change set, and a `cache` a
 * previous run left.
 */
export async function compileDocuments(
  config: ResolvedConfig,
  options: GenerateOptions = {},
): Promise<CompiledProject> {
  const unsupported = unsupportedPluginDiagnostic(config);
  if (unsupported !== undefined) {
    return { documents: [], diagnostics: [unsupported], schema: undefined };
  }
  return compileDocumentsWithRust(config, options);
}

/**
 * The read-only inspection: one compile that asks for the IR and the schema surface
 * it was built against. Nothing is written and no plugin hook runs.
 */
async function compileDocumentsWithRust(
  config: ResolvedConfig,
  options: GenerateOptions,
): Promise<CompiledProject> {
  const diagnostics: Diagnostic[] = [];
  const nativeRun = await runNativeComposed(
    config,
    // Check mode is read-only and irrelevant to the native request: the walk is all
    // this path does. `includeIr` is what makes it return the compiler's documents.
    { ...options, check: true },
    diagnostics,
    { includeIr: true },
  );
  if (!nativeRun.prepared) {
    // The schema source could not be read: the response carries that FLM2002 and
    // nothing else, exactly like `generateWithRust`.
    await nativeRun.host.resolveConfig();
    return { documents: [], diagnostics, schema: undefined };
  }
  // The index comes back with the IR: the read-only inspectors read key fields from
  // it, and the SDL was the native pass's own input.
  const schema: SchemaIndex | undefined = rehydrateSchemaIndex(nativeRun.response);
  return {
    documents: rehydrateIrDocuments(nativeRun.response, nativeRun.extraction),
    diagnostics,
    schema,
  };
}

/**
 * Writes the generated tree atomically, skipping unchanged files and deleting stale artifacts.
 *
 * The tree is the host's emit bag: `beforeEmit` runs first and every plugin contributes its files,
 * then the bag is written in sorted path order and `afterEmit` observes `written`. A schema that
 * failed to load, or an error diagnostic from before `beforeEmit`, writes nothing.
 */
export async function emitProject(
  result: RunResult,
  options: GenerateOptions = {},
): Promise<readonly string[]> {
  const host = result.host;
  if (!result.emittable || hasErrors(result.diagnostics)) {
    return [];
  }
  // Only the documents this run rebuilt are re-serialized, plus any whose module file
  // a previous run's rollback or a plugin's `emit.delete` removed; an artifact whose IR
  // came from the cache and whose file is on disk already has its bytes.
  const artifacts = result.emitArtifacts ?? (await emitSet(result));
  await timed(options.onPhase, 'emit', async () => host.beforeEmit(artifacts));
  if (hasErrors(result.diagnostics)) {
    // A plugin reported an error while it built the tree: leave the previous
    // generation alone rather than write a half-described one.
    return [];
  }
  const written = await landTree({
    config: result.config,
    host,
    documentNames: result.documentNames,
    ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
  });
  // The tree is on disk, so the state that describes it may be handed to the next run.
  // Every path above that returns before the write leaves the cache alone, and so does
  // a thrown write failure: the next run rebuilds what this one did not land.
  commitCache(options.cache, result.cacheState);
  return written;
}

/** What {@link landTree} writes and sweeps. */
export interface LandTreeInput {
  readonly config: ResolvedConfig;
  readonly host: CompilerHost;
  /** Every artifact name the stale sweep must keep. */
  readonly documentNames: readonly string[];
  readonly onPhase?: PhaseObserver;
}

/**
 * Writes the host's emit bag atomically, removes tombstoned files and stale
 * artifacts and runs `afterEmit`. Shared by the TypeScript pipeline and the native
 * one, so the writer, the rollback and the tombstone semantics are the same code.
 */
export async function landTree(input: LandTreeInput): Promise<readonly string[]> {
  const { config, host, documentNames } = input;
  const options = input.onPhase === undefined ? {} : { onPhase: input.onPhase };
  const entries = [...host.emit.entries()].toSorted((a, b) => compareNames(a[0], b[0]));
  const written: string[] = [];
  // Every file that actually landed, in completion order: what a partial batch rolls back.
  const landed: string[] = [];
  let counter = 0;
  try {
    await timed(options.onPhase, 'write', async () => {
      // `allSettled`, not `all`: every writer has to be done before a rollback runs,
      // or a write still in flight lands after the files it is racing were removed.
      const outcomes = await Promise.allSettled(
        entries.map(async ([file, content]): Promise<string | undefined> => {
          const absolute = join(config.runtimeDir, file);
          await mkdir(dirname(absolute), { recursive: true });
          const existing = await readFile(absolute, 'utf8').catch(() => undefined);
          if (existing === content) {
            return undefined;
          }
          // A per-process temp name, so two concurrent `generate` runs cannot rename
          // each other's temporary out from under themselves (E2).
          counter += 1;
          const temporary = `${absolute}.${process.pid}-${counter}.tmp`;
          try {
            await writeFile(temporary, content, 'utf8');
            await rename(temporary, absolute);
          } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined);
            throw new EmitError(`cannot write ${file}: ${errorMessage(error)}`);
          }
          // Recorded as it happens: a batch that fails on a later file must roll back
          // exactly the files this run already replaced.
          landed.push(file);
          return file;
        }),
      );
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          throw outcome.reason;
        }
      }
      // `written` stays in sorted path order, whatever order the writes completed in.
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled' && outcome.value !== undefined) {
          written.push(outcome.value);
        }
      }
    });
  } catch (error) {
    // No partial tree: a failure removes every file this run already wrote, so the batch either
    // lands whole or not at all. A file this run had already replaced is removed, not restored to
    // its previous bytes, so the next successful run is what repairs the tree (A23).
    await Promise.all(landed.map((file) => rm(join(config.runtimeDir, file), { force: true })));
    throw error instanceof EmitError ? error : new EmitError(errorMessage(error));
  }
  // A `delete` is a tombstone, not a no-op: the file an earlier run wrote is removed
  // once this run's tree is on disk.
  await removeEmitted(config, host.emit.deleted());
  await removeStaleArtifacts(config, staleKeepSet(documentNames, host));
  await host.afterEmit(written);
  return written;
}

/**
 * The `artifacts/` names the stale sweep must keep: every document, plus every path
 * the bag itself carries, so a plugin's own module under `artifacts/` survives.
 */
function staleKeepSet(documentNames: readonly string[], host: CompilerHost): ReadonlySet<string> {
  const keep = new Set(documentNames);
  for (const file of host.emit.paths()) {
    const artifact = file.startsWith('artifacts/') ? file.slice('artifacts/'.length) : undefined;
    if (artifact !== undefined && !artifact.includes('/')) {
      keep.add(baseNameOf(artifact));
    }
  }
  return keep;
}

/** Removes the paths plugins tombstoned with `emit.delete`, relative to `runtimeDir`. */
async function removeEmitted(config: ResolvedConfig, deleted: readonly string[]): Promise<void> {
  for (const file of deleted) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a failure names its path
      await rm(join(config.runtimeDir, file), { force: true });
    } catch (error) {
      throw new EmitError(`cannot delete ${file}: ${errorMessage(error)}`);
    }
  }
}

/**
 * The artifacts this run has to serialize: the ones it rebuilt, under their post-transform names,
 * plus any cached document whose module file is missing on disk. A rollback or an `emit.delete` can
 * remove an artifact the incremental cache still considers current, and a later run has to put it
 * back rather than leave a manifest that names a file which is gone. `undefined` means "every
 * artifact", which is what a caller with no cache (the CLI, `flamme check`) gets. The native path
 * computes this set itself, before it fills the emit bag, and passes it as `emitArtifacts`.
 */
/** What {@link emitSet} reads; a {@link RunResult} satisfies it structurally. */
interface EmitSetInput {
  readonly config: ResolvedConfig;
  readonly documentNames: readonly string[];
  readonly emittable: boolean;
  readonly compiled: readonly string[];
  readonly compiledArtifacts: ReadonlySet<string>;
}

async function emitSet(input: EmitSetInput): Promise<ReadonlySet<string> | undefined> {
  if (!input.emittable || input.compiled.length === input.documentNames.length) {
    return undefined;
  }
  const emit = new Set(input.compiledArtifacts);
  const missing = await Promise.all(
    input.documentNames
      .filter((name) => !emit.has(name))
      .map(async (name): Promise<string | undefined> => {
        const file = join(input.config.runtimeDir, artifactModulePath(name));
        const present = await stat(file).then(
          (entry) => entry.isFile(),
          () => false,
        );
        return present ? undefined : name;
      }),
  );
  for (const name of missing) {
    if (name !== undefined) {
      emit.add(name);
    }
  }
  return emit;
}

/**
 * Deletes artifact files whose document is gone, plus `.tmp` litter. A temporary
 * whose base name is still live is kept only while the process that created it is
 * alive: a crashed run must not leave a permanent `.tmp` beside a live artifact (A24).
 */
async function removeStaleArtifacts(
  config: ResolvedConfig,
  keep: ReadonlySet<string>,
): Promise<void> {
  const directory = join(config.runtimeDir, 'artifacts');
  const entries = await readdir(directory).catch(() => [] as string[]);
  const stale = entries.filter((entry) => {
    if (!entry.endsWith('.ts') && !entry.endsWith('.tmp')) {
      return false;
    }
    if (keep.has(baseNameOf(entry))) {
      return entry.endsWith('.tmp') && isAbandoned(entry);
    }
    return true;
  });
  await Promise.all(stale.map((entry) => rm(join(directory, entry), { force: true })));
}

/** The artifact name a file in `artifacts/` belongs to (`Q.ts`, `Q.ts.1-1.tmp` → `Q`). */
function baseNameOf(entry: string): string {
  const match = /^(.*?)\.ts(?:\..*\.tmp)?$/.exec(entry);
  return match?.[1] ?? entry.replace(/\.tmp$/, '');
}

/** True when a temporary belongs to no live process (a crashed run's litter). */
function isAbandoned(entry: string): boolean {
  const pid = /\.ts\.(\d+)-\d+\.tmp$/.exec(entry)?.[1];
  if (pid === undefined) {
    return true;
  }
  const value = Number.parseInt(pid, 10);
  if (value === process.pid) {
    return true;
  }
  try {
    process.kill(value, 0);
    return false;
  } catch {
    return true;
  }
}

/**
 * The one entry point: resolves the config (`projectDir` or a loaded config),
 * compiles, and writes the tree unless `check`/`update: false`.
 */
export async function generate(
  projectDirOrConfig: string | ResolvedConfig | FlammeConfig,
  options: GenerateOptions = {},
): Promise<CodegenResult> {
  // A `config` hook failure is a diagnostic like any other, so the array exists before the config
  // is loaded and the run fails through the ordinary error path rather than a thrown `ConfigError`.
  const diagnostics: Diagnostic[] = [];
  const config =
    typeof projectDirOrConfig === 'string'
      ? await loadConfig(projectDirOrConfig, { diagnostics })
      : isResolvedConfig(projectDirOrConfig)
        ? projectDirOrConfig
        : resolveConfig(projectDirOrConfig, projectDirOrConfig.projectDir ?? process.cwd());

  const unsupported = unsupportedPluginDiagnostic(config);
  if (unsupported !== undefined) {
    diagnostics.push(unsupported);
    return {
      artifacts: [],
      diagnostics,
      written: [],
      compiled: [],
      extraction: undefined,
    };
  }
  return generateWithRust(config, options, diagnostics);
}

/** True when a config object has already been through `resolveConfig`. */
function isResolvedConfig(value: FlammeConfig | ResolvedConfig): value is ResolvedConfig {
  return (
    'projectDir' in value &&
    typeof value.projectDir === 'string' &&
    'include' in value &&
    Array.isArray(value.include) &&
    'plugins' in value &&
    Array.isArray(value.plugins)
  );
}

/** Formats a project-relative path for diagnostics; kept here for the CLI slice. */
export function relativePath(config: ResolvedConfig, absolute: string): string {
  return toPosix(relative(config.projectDir, absolute));
}

export { CompileError, EmitError };