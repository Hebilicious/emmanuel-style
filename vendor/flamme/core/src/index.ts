/**
 * `@flamme/core` — the framework-agnostic GraphQL compiler: config, schema,
 * extraction, validation, IR and the generated tree (`spec/spec.md` §2.1).
 */

export {
  BUILT_IN_SCALARS,
  CONFIG_FILE_NAMES,
  DEFAULT_DOCUMENT_EXTENSIONS,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  DEFAULT_RUNTIME_DIR,
  ConfigError,
  defineConfig,
  documentExtensionsOf,
  documentFileNames,
  findConfigFile,
  hasDocumentExtension,
  loadConfig,
  resolveConfig,
  runtimeDirRelative,
  type FlammeConfig,
  type LoadConfigOptions,
  type ResolvedConfig,
  type RoutingConfig,
  type ScalarConfig,
  type TypeConfig,
} from './config.js';
export {
  PLUGIN_ERROR_CODE,
  createCompilerHost,
  definePlugin,
  type CompilerHook,
  type CompilerHost,
  type CompilerHostOptions,
  type CompilerPlugin,
  type CompilerRunOptions,
  type DiagnosticSink,
  type EmitBag,
  type EmitContext,
  type PluginContext,
  type RouteDocument,
  type RouteDocumentInput,
  type RouteDocumentResult,
} from './plugins/index.js';
export {
  CompileError,
  EmitError,
  SchemaError,
  createDiagnostic,
  formatDiagnostic,
  formatDiagnostics,
  hasErrors,
  sortDiagnostics,
  type Diagnostic,
  type DiagnosticSeverity,
  type RelatedInformation,
  type SourceLocation,
} from './diagnostics.js';
export {
  INTROSPECTION_QUERY,
  readSchemaSourceForCompiler,
  type SchemaIndex,
  type SchemaIndexOptions,
  type SchemaSource,
} from './schema.js';
export {
  extractProject,
  isIncluded,
  scanCode,
  unescapeTemplate,
  walkAst,
  type DocumentSurface,
  type ExtractOptions,
  type ExtractResult,
  type GqlImport,
  type RawDocument,
  type ScanBinding,
  type ScanExport,
  type ScanResult,
} from './extract.js';
export {
  analyzeVueSfc,
  createVueAnalyzer,
  type SfcAnalysis,
  type SfcAnalyzer,
  type SfcAnalyzerName,
  type SfcScriptBlock,
} from './sfc.js';
export {
  DEFAULT_LAYOUT_DOCUMENT_FILE,
  DEFAULT_PAGE_DOCUMENT_FILE,
  LAYOUT_MODULE_FILE,
  PAGE_EXPORT_NAME,
  PAGE_MODULE_FILE,
  pageModuleRole,
  resolvePageModule,
  type PageModuleCode,
  type PageModuleResolution,
  type ResolvePageModuleInput,
} from './page-module.js';
export { type IrDocument } from './ir.js';
export {
  COMPILER_VERSION,
  GENERATED_BANNER,
  RUNTIME_VERSION,
  emitTsconfig,
} from './generated.js';
export {
  compileDocuments,
  compileProject,
  emitProject,
  generate,
  relativePath,
  type CodegenResult,
  type CompiledArtifact,
  type CompiledProject,
  type GenerateOptions,
} from './generate.js';
export {
  artifactTypeNames,
  explainDocument,
  explainDocumentOf,
  findFragmentReferences,
  findReferences,
  type DocumentExplanation,
  type ExplainKey,
  type ExplainList,
  type ExplainResult,
  type ExplainSelection,
  type ExplainVariable,
  type FragmentDefinitionSite,
  type FragmentReferences,
  type FragmentSpreadSite,
  type ReferencesResult,
} from './inspect.js';
export {
  artifactModulePath,
  base36,
  canonicalJson,
  cloneFragmentName,
  fnv1a32,
  isIdentifier,
} from './naming.js';
export { hashDocument } from './hash.js';
export { buildLineIndex, columnAt, lineAt, locationAt, nodeRange, toPosix } from './offsets.js';
export {
  expandBraces,
  globToRegExp,
  matchesAny,
  matchesGlob,
  walkFiles,
  type DiscoveredFile,
} from './glob.js';
export type {
  Artifact,
  ArtifactKind,
  CachePolicy,
  DirectiveSpec,
  FieldSpec,
  FragmentSpec,
  GraphQLValue,
  InputObject,
  ListOperation,
  ListSpec,
  LoadingSpec,
  PaginationSpec,
  RefetchSpec,
  SubscriptionSelection,
} from './contract.js';
export { COMPILER_VERSION as version } from './generated.js';
export {
  loadNativeModule,
  missingCompilerMessage,
  nativeLoadFailure,
  nativeModuleBuilt,
  nativeModulePath,
  type NativeModule,
} from './native.js';
