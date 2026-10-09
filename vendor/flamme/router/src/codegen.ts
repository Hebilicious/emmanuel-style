/**
 * `@flamme/router/codegen` — the filesystem route **generator** (REQ-1, REQ-2, REQ-6).
 *
 * This entry is Node-side build tooling, not runtime: it walks the pages tree, plans the route table
 * and renders the module `$flamme/routes` (and the shim `@flamme/router/auto` imports to install it).
 * `@flamme/vite` is its only consumer inside the repo; it is a separate entry from
 * `@flamme/router/auto` because the generated module imports *that* entry from the browser bundle,
 * and a browser bundle must not pull in the compiler.
 *
 * ```ts
 * import { planRoutes, emitRoutesModule, emitRoutesShim } from '@flamme/router/codegen'
 * ```
 */

export { planRoutes, resolveRoutingConfig } from './routes-plan.js';
export type {
  PlannedLoader,
  PlannedRoute,
  PlanRoutesInput,
  ResolvedRoutingConfig,
  RoutePlan,
  RouteWarning,
} from './routes-plan.js';
export { RECORDS_DIRECTORY, RECORDS_INDEX_FILE, emitRoutesModule, recordSpecifierOf } from './routes-module.js';
export type { EmittedRoutes, RecordModule, RouteImport } from './routes-module.js';
export { COMPOSED_DIRECTORY, composedDocumentName, planComposition } from './compose-documents.js';
export type {
  ComposedDocumentSource,
  ComposedRecord,
  PlanCompositionInput,
  RouteComposition,
} from './compose-documents.js';
export { emitRoutesShim, GENERATED_ROUTES_SPECIFIER, GENERATED_SHIM_SPECIFIER } from './routes-shim.js';
export {
  DEFAULT_PAGES_DIR,
  LAYOUT_DOCUMENT_FILE,
  LAYOUT_FILE,
  NOT_FOUND_FILES,
  NOT_FOUND_ROUTE_NAME,
  PAGE_DOCUMENT_FILE,
  canonicalName,
  isLayoutFile,
  isNotFoundFile,
  isPageFile,
  nameOfLayout,
  nameOfPage,
  parseSegment,
  pathOfPage,
  segmentPattern,
} from './conventions.js';
export {
  coerceParam,
  coercionOf,
  paramSources,
  resolveRouteVariables,
  variablesOfDocument,
} from './variables.js';
export type { RouteParamSource, RouteVariable, VariableCoercion } from './variables.js';
