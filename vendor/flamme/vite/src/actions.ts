/**
 * Every hook body of the two plugins (`spec/spec.md` §10.1-§10.4), written as
 * plain functions over {@link PluginState} so they can be driven from tests with
 * a fake context and no Vite server. `plugin.ts` only wires them up.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import {
  CompileError,
  documentExtensionsOf,
  emitTsconfig,
  formatDiagnostic,
  hasDocumentExtension,
  scanCode,
  toPosix,
  type Diagnostic,
  type ResolvedConfig,
} from '@flamme/core';
import type { UserConfig } from 'vite';

import { injectAliases } from './aliases.js';
import { formatCompileError, planRoutesFor, runCodegen, type CodegenRun } from './codegen.js';
import type {
  DevServerLike,
  ErrorContextLike,
  HotUpdateLike,
  HotUpdateReturn,
  RawSourceMapLike,
  ResolvedConfigLike,
  TransformContextLike,
  TransformOutput,
  UserConfigLike,
} from './context.js';
import { VizeSeamError } from './errors.js';
import { createHmrRunner, type ChangedArtifact } from './hmr.js';
import { CODEGEN_PLUGIN_NAME } from './names.js';
import { artifactSpecifier, documentNameOf, indexFromManifest } from './indexes.js';
import {
  defaultRuntimeDir,
  fallbackConfig,
  loadProjectConfig,
  missingConfigError,
  warnOnPluginOrder,
} from './options.js';
import { rewriteFile } from './rewrite.js';
import { ROUTES_SHIM_FILE, writeRoutes } from './routes.js';
import { selectAnalyzer } from './analyzer.js';
import { createPluginState, includeGlobs, type PluginState } from './state.js';
import {
  MANIFEST_RESOLVED_ID,
  MANIFEST_VIRTUAL_ID,
  ROUTES_RESOLVED_ID,
  ROUTES_VIRTUAL_ID,
  splitId,
  vizeCompiledFile,
} from './virtual.js';

export { createPluginState };


/** The env escape hatch that skips codegen (`spec/spec.md` §10.2 `buildStart`). */
export const SKIP_GENERATE_ENV = 'FLAMME_SKIP_GENERATE';

/** `true` when `FLAMME_SKIP_GENERATE` is set to a truthy value. */
export function skipGenerateEnv(): boolean {
  const value = process.env[SKIP_GENERATE_ENV];
  return value === '1' || value === 'true';
}

/** Reads `server.watch.ignored` without depending on Vite's matcher type. */
function userIgnored(userConfig: UserConfigLike): string[] {
  const server: unknown = userConfig.server;
  const watch = typeof server === 'object' && server !== null ? Reflect.get(server, 'watch') : undefined;
  const ignored =
    typeof watch === 'object' && watch !== null ? Reflect.get(watch, 'ignored') : undefined;
  if (typeof ignored === 'string') {
    return [ignored];
  }
  if (Array.isArray(ignored)) {
    return ignored.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

/** The ignore globs Vite's watcher gets, merged with the user's. */
function ignoredGlobs(userConfig: UserConfigLike): string[] {
  return [...new Set(['**/.flamme/**', '**/*.flamme_tmp', ...userIgnored(userConfig)])];
}

/** Writes `.flamme/tsconfig.json` when it is absent or stale (§10.2 `config`). */
async function writeTsconfig(runtimeDir: string): Promise<boolean> {
  const content = emitTsconfig();
  const target = join(runtimeDir, 'tsconfig.json');
  const existing = await readFile(target, 'utf8').catch(() => undefined);
  if (existing === content) {
    return false;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return true;
}

/** The `config` hook: aliases, watcher ignores and the generated tsconfig. */
export async function runConfig(state: PluginState, userConfig: UserConfigLike): Promise<UserConfig> {
  state.root = resolve(userConfig.root ?? process.cwd());
  try {
    state.config = await loadProjectConfig(state.root, state.options);
    state.configError = undefined;
  } catch (error) {
    state.configError = error;
    state.config = fallbackConfig(state.root, state.options);
  }
  const runtimeDir = state.config.runtimeDir;
  await writeTsconfig(runtimeDir);
  return {
    resolve: { alias: injectAliases(userConfig, runtimeDir) },
    server: { watch: { ignored: ignoredGlobs(userConfig) } },
  };
}

/** Resolves the config for on-disk paths, applying the `skipCodegen` tolerance. */
async function resolveConfigForRoot(state: PluginState, root: string): Promise<void> {
  state.root = resolve(root);
  try {
    state.config = await loadProjectConfig(state.root, state.options);
    state.configError = undefined;
  } catch (error) {
    state.configError = error;
    if (error instanceof CompileError) {
      // A `config` plugin hook failed: the file loaded, so "no flamme.config.ts could be loaded"
      // would send the reader to the wrong place. Report the plugin failure as itself.
      throw error;
    }
    if (!state.options.skipCodegen) {
      throw missingConfigError(state.root, error);
    }
    state.config = fallbackConfig(state.root, state.options);
  }
}

/** The `configResolved` hook: config load, analyzer choice, ordering warning. */
export async function runConfigResolved(
  state: PluginState,
  config: ResolvedConfigLike,
): Promise<void> {
  state.command = config.command;
  state.hasVizePlugin = config.plugins.some(
    (plugin) => plugin.name === 'vize' || plugin.name.startsWith('vize:'),
  );
  if (state.config === undefined || state.configError !== undefined || resolve(config.root) !== state.root) {
    await resolveConfigForRoot(state, config.root);
  }
  warnOnPluginOrder(config.plugins, (message) => config.logger.warn(`flamme: ${message}`));
  const choice = await selectAnalyzer({
    ...(state.options.sfc === undefined ? {} : { sfc: state.options.sfc }),
    hasVizePlugin: state.hasVizePlugin,
  });
  state.analyzer = choice.analyzer;
  state.vizeVersion = choice.vizeVersion;
  state.analyzerReason = choice.reason;
  config.logger.info(`flamme: SFC analyzer: ${choice.analyzer.name} (${choice.reason})`);
  await ensureRoutes(state);
}

/**
 * Writes `$flamme/routes` before anything can import it.
 *
 * `configResolved` is the earliest hook that runs for every consumer (a dev server, a build, a test
 * runner) and the alias injected by `config` resolves to real files, so the generated module has to
 * exist by the time the first `import '$flamme/routes'` is resolved. The passes that follow
 * (`buildStart`, `configureServer`, HMR) regenerate it from the artifacts and the write is skipped
 * when the content is identical, so this is an ordering guarantee, not a second generator.
 */
async function ensureRoutes(state: PluginState): Promise<void> {
  const config = state.config;
  if (config === undefined || state.options.skipCodegen || skipGenerateEnv()) {
    return;
  }
  try {
    const run = await planRoutesFor(config);
    await writeRoutes(run, config.runtimeDir);
    state.recordModules = run.records;
    reportRouteWarnings(state, { routes: run });
  } catch (error) {
    // a project that cannot be extracted reports through the codegen passes that follow; this hook
    // must not make a dev server fail to start
    state.warn?.(`flamme: route generation skipped: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
}

/**
 * Writes the generated route modules and records them in the own-write window, so the watcher does
 * not treat our own write as a user edit (the `isOwnWrite` rule, §4.8 step 7).
 */
async function writeRouteFiles(
  state: PluginState,
  run: CodegenRun,
  config: ResolvedConfig,
): Promise<void> {
  const written = await writeRoutes(run.routes, config.runtimeDir);
  const stamp = Date.now();
  for (const file of written) {
    state.ownWrites.set(join(config.runtimeDir, file), stamp);
  }
}

/** Applies one codegen run to the shared state. */
function applyRun(state: PluginState, run: CodegenRun, config: ResolvedConfig): void {
  state.index = run.index;
  state.hashes = new Map(run.result.artifacts.map((artifact) => [artifact.name, artifact.hash]));
  const documentFiles = new Map<string, Set<string>>();
  for (const artifact of run.result.artifacts) {
    const names = documentFiles.get(artifact.file) ?? new Set<string>();
    names.add(artifact.name);
    documentFiles.set(artifact.file, names);
  }
  state.documentFiles = documentFiles;
  state.recordModules = run.routes.records;
  const stamp = Date.now();
  for (const file of run.result.written) {
    state.ownWrites.set(join(config.runtimeDir, file), stamp);
  }
}

/** Prints every warning diagnostic through the state's logger (FLM1018 etc.). */
function reportWarnings(state: PluginState, diagnostics: readonly Diagnostic[]): void {
  const warn = state.warn;
  if (warn === undefined) {
    return;
  }
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'warning') {
      warn(formatDiagnostic(diagnostic));
    }
  }
}

/**
 * Reports a failed codegen pass without throwing (`research/review-slice25-correctness.md`
 * C4): the diagnostics go through the logger and the dev-server error overlay, so a dev
 * server whose project is momentarily broken keeps running and the next edit recovers.
 */
function reportCompileFailure(state: PluginState, error: CompileError): void {
  const message = formatCompileError(error);
  state.warn?.(message);
  const server = state.server;
  if (server === undefined) {
    return;
  }
  server.ws.send({
    type: 'error',
    err: {
      message,
      stack: '',
      plugin: CODEGEN_PLUGIN_NAME,
    },
  });
}

/** Loads the artifact index from `manifest.json` when codegen is skipped. */
async function loadIndexFromManifest(state: PluginState): Promise<void> {
  const config = state.config;
  if (config === undefined) {
    return;
  }
  const index = await indexFromManifest(config.projectDir, config.runtimeDir).catch(() => undefined);
  if (index === undefined) {
    return;
  }
  state.index = index;
  const documentFiles = new Map<string, Set<string>>();
  for (const entry of index.records) {
    if (entry.file === undefined) {
      continue;
    }
    const names = documentFiles.get(entry.file) ?? new Set<string>();
    names.add(entry.name);
    documentFiles.set(entry.file, names);
  }
  state.documentFiles = documentFiles;
}

/** Runs the full pipeline, or loads the manifest when codegen is skipped. */
async function prepare(state: PluginState): Promise<void> {
  const config = state.config;
  if (config === undefined) {
    return;
  }
  if (state.options.skipCodegen || skipGenerateEnv()) {
    await loadIndexFromManifest(state);
    return;
  }
  const run = await runCodegen({ config, cache: state.cache });
  reportWarnings(state, run.result.diagnostics);
  await writeRouteFiles(state, run, config);
  reportRouteWarnings(state, run, run.result.diagnostics);
  applyRun(state, run, config);
}

/**
 * Prints the route generator's findings (`FLM3001`-`FLM3009`) through the plugin's logger.
 *
 * A project that registers `flammeRoutesPlugin()` gets the same findings from the compiler pass as
 * diagnostics (`diagnostics`), which the caller has already printed; the `${code}:${file}` pairs
 * they cover are skipped here so one warning is not reported twice.
 */
function reportRouteWarnings(
  state: PluginState,
  run: { readonly routes: CodegenRun['routes'] },
  diagnostics: readonly Diagnostic[] = [],
): void {
  const warn = state.warn;
  if (warn === undefined) {
    return;
  }
  const reported = new Set(
    diagnostics
      .filter((entry) => entry.code.startsWith('FLM3'))
      .map((entry) => `${entry.code}:${entry.location.file}`),
  );
  for (const warning of run.routes.warnings) {
    if (reported.has(`${warning.code}:${warning.file}`)) {
      continue;
    }
    warn(`${warning.code} ${warning.file}: ${warning.message}`);
  }
}

/** The `buildStart` hook: codegen in build mode, a no-op in dev. */
export async function runBuildStart(state: PluginState, context: ErrorContextLike): Promise<void> {
  if (state.command !== 'build') {
    return;
  }
  state.warn = (message) => context.warn(message);
  try {
    await prepare(state);
  } catch (error) {
    if (error instanceof CompileError) {
      context.error(formatCompileError(error));
    }
    throw error;
  }
}

/** The `configureServer` hook: codegen in dev, then the HMR runner is wired. */
export async function runConfigureServer(
  state: PluginState,
  server: DevServerLike,
  context: ErrorContextLike,
): Promise<void> {
  state.server = server;
  state.warn = (message) => context.warn(message);
  try {
    await prepare(state);
  } catch (error) {
    // A broken project (a deleted document still imported, a field that no longer
    // exists) must not kill the dev server: report the diagnostics and wire the
    // HMR runner anyway, so the next edit recovers (`research/review-slice25-correctness.md`
    // C4). Build mode still fails loudly in `runBuildStart`.
    if (!(error instanceof CompileError)) {
      throw error;
    }
    reportCompileFailure(state, error);
  }
  state.runner = createHmrRunner({
    projectDir: state.config?.projectDir ?? state.root,
    runtimeDir: state.config?.runtimeDir ?? defaultRuntimeDir(state.root, state.options),
    include: includeGlobs(state),
    ...(state.config === undefined
      ? {}
      : { documentExtensions: documentExtensionsOf(state.config.routing) }),
    regenerate: (files) => regenerate(state, files),
    readFile: (file) => readFile(file, 'utf8').catch(() => undefined),
    isKnownDocumentFile: (file) => state.documentFiles.has(file),
    isOwnWrite: (file) => isOwnWrite(state, file),
    onDelete: async (files) => {
      const runtimeDir = state.config?.runtimeDir;
      await Promise.all(
        files.map(async (file) => {
          // Prune the deleted document's artifact before regeneration: when the
          // batch also carries unrelated codegen errors, `generate` returns before
          // its stale-artifact sweep, and the stale module would otherwise survive
          // the delete forever (`research/review-slice25-correctness.md` C4).
          const record = state.index.byFile(file);
          if (record !== undefined && runtimeDir !== undefined) {
            await rm(join(runtimeDir, record.artifactFile), { force: true }).catch(() => undefined);
          }
          state.documentFiles.delete(file);
        }),
      );
    },
    invalidate: (artifacts) => invalidateArtifacts(server, artifacts),
    send: (payload) => server.ws.send(payload),
  });
}

/** Re-runs codegen and reports the artifacts whose content changed. */
async function regenerate(state: PluginState, files: readonly string[]): Promise<readonly ChangedArtifact[]> {
  const config = state.config;
  if (config === undefined) {
    return [];
  }
  // `files` is the change set, not a restriction on the tree: the run still
  // describes every document, and the cache is what makes the other files cheap.
  // A `files`-less run would re-read and re-parse the whole project on every
  // keystroke, which is exactly what the cache exists to avoid.
  let run: CodegenRun;
  try {
    run = await runCodegen({ config, files, cache: state.cache });
  } catch (error) {
    // The batch must resolve (an unhandled rejection inside the debounce timer has
    // no visible cause) and the diagnostics must reach the logger and the overlay.
    if (!(error instanceof CompileError)) {
      throw error;
    }
    reportCompileFailure(state, error);
    return [];
  }
  reportWarnings(state, run.result.diagnostics);
  await writeRouteFiles(state, run, config);
  reportRouteWarnings(state, run, run.result.diagnostics);
  const changed: ChangedArtifact[] = [];
  for (const artifact of run.result.artifacts) {
    if (state.hashes.get(artifact.name) === artifact.hash) {
      continue;
    }
    changed.push({
      path: join(config.runtimeDir, artifact.artifactFile),
      name: artifact.name,
      hash: artifact.hash,
    });
  }
  applyRun(state, run, config);
  return changed;
}

/** Invalidates the module-graph nodes of the changed artifacts. */
function invalidateArtifacts(
  server: DevServerLike,
  artifacts: readonly ChangedArtifact[],
): void {
  for (const artifact of artifacts) {
    const modules = server.moduleGraph.getModulesByFile(artifact.path);
    if (modules === undefined) {
      continue;
    }
    for (const module of modules) {
      server.moduleGraph.invalidateModule(module);
    }
  }
}

/** The own-write guard window, in milliseconds. */
const OWN_WRITE_WINDOW_MS = 2000;

/** `true` when the plugin wrote this file itself recently (§4.8 step 7). */
export function isOwnWrite(state: PluginState, file: string): boolean {
  const stamp = state.ownWrites.get(file);
  return stamp !== undefined && Date.now() - stamp < OWN_WRITE_WINDOW_MS;
}

/** Adds the artifact a rewritten document points at to the watch list. */
function watchArtifacts(state: PluginState, context: TransformContextLike, names: readonly string[]): void {
  const config = state.config;
  if (config === undefined) {
    return;
  }
  for (const name of names) {
    const record = state.index.byName(name);
    if (record !== undefined) {
      context.addWatchFile(join(config.runtimeDir, record.artifactFile));
    }
  }
}

/** Serves a document file that reached the bundler as a module. */
function serveDocumentFile(state: PluginState, context: TransformContextLike, file: string): TransformOutput {
  const record = state.index.byFile(file);
  if (record === undefined) {
    return null;
  }
  watchArtifacts(state, context, [record.name]);
  return { code: `export { default } from '${artifactSpecifier(record)}'`, map: null };
}

/**
 * Fails loudly when the rewritten module still carries a `graphql()` document:
 * an unbound document ships the tag source, and the runtime then throws
 * `graphql() must be compiled away` into an empty `#app` (§10.3 step 6, §10.4).
 * A document codegen did not compile is the case this catches.
 */
function assertNoSurvivingDocuments(code: string, file: string, relativePath: string): void {
  const scanned = scanCode(code, `${file}.ts`, relativePath, 0, code, 'ts');
  if (scanned.candidates.length === 0) {
    return;
  }
  const names = [
    ...new Set(scanned.candidates.map((candidate) => documentNameOf(candidate.text) ?? '(unparsable)')),
  ];
  throw new VizeSeamError(
    `${scanned.candidates.length} graphql() document(s) in "${file}" survived the Vize ` +
      `compiled-module rewrite: ${names.join(', ')}.`,
    {
      hint:
        'The bundle would throw "graphql() must be compiled away" at runtime. Run codegen so ' +
        'every document surface has an artifact before the bundler, or drop `skipCodegen`.',
    },
  );
}

/**
 * The secondary Vize strategy (`research/vize.md` §E.2/F.1, D8): Vize's plugin is
 * also `enforce: 'pre'` and resolves every `.vue` request to its own compiled
 * module `<abs>.vue.ts?vue&vize`, so {@link runTransform} never sees the SFC and
 * the primary rewrite cannot run under `vize()`.
 *
 * The compiled module still carries the `<script setup>` surfaces, so they are
 * rewritten here with the same artifact index the primary strategy uses:
 * `graphql()` tags and `.gql` import specifiers.
 */
async function secondaryTransform(
  state: PluginState,
  context: TransformContextLike,
  code: string,
  id: string,
  file: string,
): Promise<TransformOutput> {
  const config = state.config;
  if (config === undefined) {
    return null;
  }
  const relativePath = toPosix(relative(config.projectDir, file));
  const record = state.recordModules.get(file);
  const rewritten = rewriteFile(code, {
    filename: id.split('?')[0] ?? `${file}.ts`,
    relativePath,
    index: state.index,
    documentExtensions: documentExtensionsOf(config.routing),
    ...(record === undefined ? {} : { pageQueryRecord: record.specifier }),
  });
  const documents = rewritten.documents.map((document) => document.name);
  if (record !== undefined) {
    // The record module is what imports the artifact now, so the page's own watch list keeps it.
    documents.push(record.document);
  }
  const out = rewritten.code;
  assertNoSurvivingDocuments(out, file, relativePath);
  if (out === code) {
    return null;
  }
  watchArtifacts(state, context, documents);
  return { code: out, map: rewritten.map === undefined ? null : viteMap(rewritten.map, id) };
}

/** The `transform` hook: the six-step algorithm's step 5. */
export async function runTransform(
  state: PluginState,
  context: TransformContextLike,
  code: string,
  id: string,
): Promise<TransformOutput> {
  if (id.startsWith('\0')) {
    return null;
  }
  const compiled = vizeCompiledFile(id);
  if (compiled !== undefined) {
    return secondaryTransform(state, context, code, id, compiled);
  }
  const { file, query } = splitId(id);
  if (query !== undefined && query.length > 0) {
    return null;
  }
  if (state.config === undefined) {
    return null;
  }
  if (hasDocumentExtension(file, documentExtensionsOf(state.config.routing))) {
    return serveDocumentFile(state, context, file);
  }
  if (!/\.(vue|ts|tsx|js|jsx|mts|cts)$/.test(file)) {
    return null;
  }
  const relativePath = toPosix(relative(state.config.projectDir, file));
  const record = state.recordModules.get(file);
  let result: ReturnType<typeof rewriteFile>;
  try {
    result = rewriteFile(code, {
      filename: file,
      relativePath,
      index: state.index,
      documentExtensions: documentExtensionsOf(state.config.routing),
      ...(record === undefined ? {} : { pageQueryRecord: record.specifier }),
      analyze: (source, filename) => state.analyzer.analyze(source, filename),
    });
  } catch {
    return null;
  }
  if (!result.changed) {
    return null;
  }
  watchArtifacts(state, context, [
    ...result.documents.map((document) => document.name),
    // the record's own document, which the rewritten import reaches through the record module
    ...(record === undefined ? [] : [record.document]),
  ]);
  return { code: result.code, map: result.map === undefined ? null : viteMap(result.map, file) };
}

/** Converts a MagicString sourcemap into the raw map Vite's hooks expect. */
function viteMap(
  map: {
    readonly mappings: string;
    readonly names: readonly string[];
    readonly sources: readonly string[];
    readonly sourcesContent: readonly (string | null)[] | undefined;
  },
  source: string,
): RawSourceMapLike {
  return {
    version: 3,
    file: source,
    mappings: map.mappings,
    names: [...map.names],
    sources: [...map.sources],
    sourcesContent: map.sourcesContent === undefined ? [] : [...map.sourcesContent],
  };
}

/** The `resolveId` hook: the generated routes and the manifest module. */
export function runResolveId(state: PluginState, id: string): string | null {
  void state;
  if (id === MANIFEST_VIRTUAL_ID) {
    return MANIFEST_RESOLVED_ID;
  }
  if (id === ROUTES_VIRTUAL_ID) {
    return ROUTES_RESOLVED_ID;
  }
  return null;
}

/** The generated `auto-routes.ts` path, or `undefined` before the config is resolved. */
function runRoutesFile(state: PluginState): string | undefined {
  const config = state.config;
  return config === undefined ? undefined : join(config.runtimeDir, ROUTES_SHIM_FILE);
}

/** The inlined `manifest.json` module (dev only, §10.2 `load`). */
async function manifestModule(state: PluginState): Promise<string | null> {
  const config = state.config;
  if (config === undefined) {
    return null;
  }
  const text = await readFile(join(config.runtimeDir, 'manifest.json'), 'utf8').catch(() => undefined);
  return text === undefined ? 'export default null' : `export default ${text}`;
}

/** The `load` hook: the `.gql` artifact re-exports and the manifest module. */
export async function runLoad(
  state: PluginState,
  context: TransformContextLike,
  id: string,
): Promise<string | null> {
  if (id === MANIFEST_RESOLVED_ID) {
    return manifestModule(state);
  }
  if (id === ROUTES_RESOLVED_ID) {
    // the same module on disk (`<runtimeDir>/auto-routes.ts`), so an inspector and the bundler see
    // byte-identical content
    const file = runRoutesFile(state);
    return file === undefined ? null : readFile(file, 'utf8').catch(() => null);
  }
  const { file, query } = splitId(id);
  if (
    (query === undefined || query.length === 0) &&
    state.config !== undefined &&
    hasDocumentExtension(file, documentExtensionsOf(state.config.routing))
  ) {
    const record = state.index.byFile(file);
    if (record !== undefined) {
      watchArtifacts(state, context, [record.name]);
      return `export { default } from '${artifactSpecifier(record)}'`;
    }
  }
  return null;
}

/** The `hotUpdate` hook: ownership short-circuit, then the debounced pipeline. */
export async function runHotUpdate(
  state: PluginState,
  event: HotUpdateLike,
): Promise<HotUpdateReturn> {
  const runner = state.runner;
  if (runner === undefined) {
    return undefined;
  }
  const ownership = await runner.ownership(event.file);
  if (ownership === 'generated') {
    return [];
  }
  if (ownership === 'other') {
    return undefined;
  }
  // Own writes are filtered inside the runner's queue as well; a generated path
  // already returned above, so nothing else here can be a file we wrote.
  runner.enqueue({ file: event.file, type: event.type });
  // A document file is not a module of its own: suppress Vite's cascade and let
  // the artifact invalidation we push after codegen drive the update.
  const extensions =
    state.config === undefined ? [] : documentExtensionsOf(state.config.routing);
  return hasDocumentExtension(event.file, extensions) ? [] : undefined;
}

