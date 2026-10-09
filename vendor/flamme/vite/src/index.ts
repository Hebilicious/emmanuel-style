/**
 * `@flamme/vite` — the Vite plugin and codegen integration
 * (`spec/spec.md` §10). `flamme()` returns the two plugins; the analysis
 * helpers are exported so the same seams can be exercised by tests and by
 * consumers who need the ids.
 */

export { flamme, type FlammePluginOptions } from './plugin.js';
export { ARTIFACT_UPDATE_EVENT, CODEGEN_PLUGIN_NAME, TRANSFORM_PLUGIN_NAME } from './names.js';
export { VizeSeamError } from './errors.js';
export { FLAMME_ALIAS, flammeAliases, injectAliases } from './aliases.js';
export { MANIFEST_RESOLVED_ID, MANIFEST_VIRTUAL_ID, splitId, vizeCompiledFile } from './virtual.js';
export {
  VIZE_NATIVE_SPECIFIER,
  createVizeAnalyzer,
  createVueAnalyzer,
  loadVizeNative,
  readVizeVersion,
  scriptBlocks,
  selectAnalyzer,
  type AnalyzerChoice,
  type AnalyzerReason,
  type ModuleLoader,
  type SelectAnalyzerOptions,
} from './analyzer.js';
export {
  artifactSpecifier,
  createArtifactIndex,
  documentNameOf,
  indexFromCodegen,
  indexFromManifest,
  type ArtifactIndex,
  type ArtifactRecord,
} from './indexes.js';
export {
  SKIP_GENERATE_ENV,
  createPluginState,
  isOwnWrite,
  runBuildStart,
  runConfig,
  runConfigResolved,
  runConfigureServer,
  runHotUpdate,
  runLoad,
  runResolveId,
  runTransform,
  skipGenerateEnv,
} from './actions.js';
export { type PluginState } from './state.js';
export {
  createHmrRunner,
  type ChangedArtifact,
  type HmrEvent,
  type HmrRunner,
  type Ownership,
} from './hmr.js';
export { rewriteFile, type RewriteDocument, type RewriteResult } from './rewrite.js';
export { scanBlock, type BlockScan, type DocumentRange } from './scan.js';
export {
  formatCompileError,
  formatDiagnosticList,
  runCodegen,
  type CodegenRun,
} from './codegen.js';
export { warnOnPluginOrder } from './options.js';
/** The host seam: a plugin registered with `flamme()` may contribute a compiler plugin, a Vite plugin, or both. */
export { compilerPluginsOf, vitePluginsOf, type FlammeVitePlugin } from './plugins.js';
/** The CLI codegen path's route generation (`flamme.config.ts` -> `plugins: [flammeRoutesPlugin()]`). */
export {
  flammeRoutesPlugin,
  type FlammeRoutesErrorMode,
  type FlammeRoutesPluginOptions,
} from './plugin-config.js';
export {
  ROUTES_FILE,
  ROUTES_SHIM_FILE,
  generateRoutes,
  routesAreCurrent,
  writeRoutes,
} from './routes.js';
export type { GenerateRoutesOptions, RoutesDocument, RoutesRun } from './routes.js';
