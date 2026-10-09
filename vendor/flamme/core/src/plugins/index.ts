/**
 * The compiler plugin surface (`apps/docs/content/plugins.md`): the host and the
 * authoring helper.
 *
 * The built-in emitters that used to live here are gone with the TypeScript
 * compiler: the Rust compiler owns the generated tree, and the host is what a user
 * plugin attaches to (`configResolved`, `beforeExtract`, `routeDocuments`,
 * `beforeEmit`, `afterEmit`).
 */

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
} from './host.js';
