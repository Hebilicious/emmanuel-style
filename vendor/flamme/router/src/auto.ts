/**
 * `@flamme/router/auto` — the invisible call site (REQ-3).
 *
 * This is the entry point the generated `$flamme/routes` shim and the app's `main.ts` import, so
 * neither of them names a document, a loader, a client or a variables getter:
 *
 * ```ts
 * // main.ts — the client is named once, and that is all
 * import { createFlammeRouter } from '@flamme/router/auto'
 * const { router, dataLoader } = createFlammeRouter({ client, history: createWebHistory() })
 * ```
 * ```vue
 * <!-- src/pages/[[id]].vue — no loader import, no client, no variables getter -->
 * <script setup lang="ts">
 * const { data, fetching, errors, loadNextPage, pageInfo } = usePageQuery()
 * </script>
 * ```
 *
 * The generated route module carries `meta.loaders` (so the navigation guard runs the loaders) and
 * `meta.flamme` (`'page'` or `'layout'`). {@link usePageQuery} reads the record that renders **the
 * component it is called from** (vue-router's `<RouterView>` provides it at each nesting level), so
 * a page and a nested route group (`(types)/+page.vue`) each read their own document and neither
 * can read the other's. The explicit API in the package's main entry
 * (`createRouteLoaders`, `queryLoader`, `useRouteQuery`, `prefetchFragment`) is unchanged and stays
 * the escape hatch for routes that do not follow the convention.
 *
 * The route *generator* is deliberately **not** part of this entry: it is Node-side code (it reads
 * the page tree and imports `@flamme/core`), and a browser bundle that pulled it in would drag the
 * compiler and its parser into the app. `@flamme/router/codegen` is where `@flamme/vite` imports it
 * from.
 */

import { computed, inject } from 'vue';

import type { Artifact, ArtifactData, Client, GraphQLResponseError } from '@flamme/runtime';
import type {
  RouteLocation,
  RouteRecordNormalized,
  Router,
  RouterHistory,
} from 'vue-router';

import { composedRequestInFlight, defineFlammeRoutes, type FlammeRoute } from './define.js';
import { composeFlammeRoutes } from './compose.js';
import { GENERATED_SHIM_ID, importGeneratedShim } from './auto-shim.js';
import { QueryLoaderError, type RouteQueryLoader } from './loader.js';
import { useRouteQuery, type RouteQueryHandle, type UseRouteQueryOptions } from './query.js';
import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  matchedRouteKey,
  useRoute,
} from './vue-router.js';

export { DataLoaderPlugin, QueryLoaderError, reroute } from './loader.js';
export type { RouteQueryDefinition, RouteQueryLoader } from './loader.js';
export { prefetchRoute } from './prefetch-route.js';
export type { PrefetchRouteOptions } from './prefetch-route.js';
export { createComposedPageLoader, createPageLoader, defineFlammeRoutes } from './define.js';
export type { FlammeLoaderDefinition, FlammeRoute, FlammeRouteMeta, PageLoader } from './define.js';
export { composeFlammeRoutes } from './compose.js';
export type { RouteQueryHandle, UseRouteQueryOptions } from './query.js';

/**
 * The build-time registry of the page records a **specific app** declares, which is what makes
 * `usePageQuery()` typed without an argument.
 *
 * The generated `$flamme/routes` module augments this interface, one entry per record that declares
 * a query (a page, a layout and a route group alike), with the data that record's loader produces:
 *
 * ```ts
 * declare module '@flamme/router/auto' {
 *   interface FlammeGeneratedRoutes {
 *     readonly '[id]': PageData<typeof DocInfo>
 *     readonly '[id]/(types)': PageData<typeof DocSpeciesTypes>
 *   }
 * }
 * ```
 *
 * The registry is empty until the generated module augments it, so an app that never runs the
 * generator has no page query to type (`never`) - and `usePageQuery()` would report `FLM4010` at
 * runtime.
 *
 * ## Why the call site may name its own data type
 *
 * Which record renders a component is a **runtime** fact (vue-router's `<RouterView>` nesting), so
 * TypeScript cannot resolve it from a call site: the default is therefore
 * `FlammeGeneratedRoutes[keyof FlammeGeneratedRoutes]`, the union of every record's data in the app.
 * One record makes the union exact; several records (two pages, or a page and its route group) make
 * it a union, and a component that wants **its own** record's fields names them:
 *
 * ```ts
 * const { data } = usePageQuery<SpeciesTypes$result>() // this record's document
 * ```
 *
 * The type argument is constrained to that union, so it names one of the app's own records and an
 * invented type is a compile error rather than a `data.value` no loader can produce.
 *
 * The runtime is unchanged by the type argument: the loader is still the one the record that renders
 * the component carries.
 */
export interface FlammeGeneratedRoutes {}

/**
 * The data type of the records the generated registry declares. An app that never ran the generator
 * leaves the registry empty, so this is `never`: `usePageQuery()` has nothing to return there, which
 * is exactly what the runtime reports (`FLM4010`).
 */
type GeneratedData = FlammeGeneratedRoutes[keyof FlammeGeneratedRoutes];

/**
 * The data type one page's query produces. The generated module types each entry of its page
 * registry with this, which is what makes `usePageQuery()`'s return type exact without either side
 * naming a document:
 *
 * ```ts
 * export const pageQueries = { '[id]': null as unknown as PageData<typeof Species> } as const
 * ```
 */
export type PageData<A extends Artifact<'query'>> = ArtifactData<A>;

/**
 * The current page's own query, with no argument (REQ-3).
 *
 * ```vue
 * <script setup lang="ts">
 * const { data, fetching, errors, loadNextPage, pageInfo } = usePageQuery()
 * </script>
 * ```
 *
 * The loader comes from the **record that renders the calling component**: vue-router's
 * `<RouterView>` provides that record to every component it renders, so a page and a route group
 * nested inside it each read their own document. A component outside a `<RouterView>` falls back to
 * the deepest matched record whose `meta.flamme` is `'page'`; layout records are skipped
 * deliberately, so a page and its layout may each declare a query and neither call site has to say
 * which one it means. A page whose query the generator never saw throws a message that says so,
 * because there is nothing sensible to return.
 *
 * `TData` is constrained to `FlammeGeneratedRoutes[keyof FlammeGeneratedRoutes]`: the type argument
 * names **one of the app's own generated records**, and an invented type is a compile error rather
 * than a `data.value` that no loader can produce.
 *
 * A route that needs a second document nests a **route group** instead: `(types)/+page.gql` with
 * `(types)/+page.vue`, whose component calls `usePageQuery()` itself and renders where the parent
 * puts `<RouterView />`. This call takes no argument and never names a document.
 */
export function usePageQuery<TData extends GeneratedData = GeneratedData>(
  options?: UseRouteQueryOptions,
): RouteQueryHandle<TData>;
export function usePageQuery(options?: UseRouteQueryOptions): RouteQueryHandle<unknown> {
  // vue-router's `meta` is untyped, so the loader is re-typed once here: the overload above is the
  // assertion that the record's loader carries this data (its default is the generated registry's
  // union, and the generated `pageQueries` map performs the same narrow at its own boundary).
  const resolved = pageLoader(options);
  const route = useRoute();
  const handle = useRouteQuery(
    resolved.loader,
    resolved.composed === undefined
      ? (options ?? {})
      : {
          ...options,
          enabled: () => (options?.enabled?.() ?? true) && !composedRequestInFlight(route),
        },
  );
  return withComposedFailure(handle, route);
}

/**
 * The record's own read with the navigation's composed failure merged into `errors`.
 *
 * A composed record runs the composed loader in the navigation guard and keeps its own document
 * loader for reads (masking). When the composed request fails, the failure lives on the **guard's**
 * loader, which no component reads: without this merge a page would render an empty read and no
 * error at all, where before composition the guard's loader was the very loader the page read.
 *
 * The failure is looked up on every composed loader the navigation ran, not only on the record's
 * own: the request belongs to the longest chain, so on a nested route (`page` and a route group
 * below it) it is the **group's** loader that fails while the page's own composed loader lost the
 * arbitration and holds no error. Every matched record's composed loader is *called* for its refs,
 * which vue-router answers from the navigation's own entry, so reading the failure costs no request.
 */
function withComposedFailure<TData>(
  handle: RouteQueryHandle<TData>,
  route: RouteLocation,
): RouteQueryHandle<TData> {
  const composed: { readonly loader: RouteQueryLoader<unknown>; readonly state: ReturnType<RouteQueryLoader<unknown>> }[] = [];
  for (const record of route.matched) {
    const meta = record.meta;
    if (Reflect.get(meta, 'composed') !== true) {
      continue;
    }
    const loader = firstLoader(meta, 'loaders');
    if (loader !== undefined) {
      composed.push({ loader, state: loader() });
    }
  }
  if (composed.length === 0) {
    return handle;
  }
  const errors = computed<readonly GraphQLResponseError[] | null>(() => {
    const merged = [...(handle.errors.value ?? [])];
    const seen = new Set(merged.map((error) => error.message));
    for (const { state } of composed) {
      const error: unknown = state.error.value;
      if (!(error instanceof QueryLoaderError)) {
        continue;
      }
      for (const failure of error.errors) {
        if (!seen.has(failure.message)) {
          seen.add(failure.message);
          merged.push(failure);
        }
      }
    }
    return merged.length === 0 ? null : merged;
  });
  // A **background** composed request is the record's read while it is open: the record's own
  // document loader is paused by the composed claim (`pauseWhileComposed`), so the page's handle has
  // no store request of its own to report and the guard has already committed the navigation. The
  // composed loader's `isLoading` is what says the page's fields are still on their way.
  const background = composed.filter(({ loader }) => loader.background);
  if (background.length === 0) {
    return { ...handle, errors };
  }
  const fetching = computed(
    () => handle.fetching.value || background.some(({ state }) => state.isLoading.value),
  );
  return { ...handle, errors, fetching };
}

/**
 * The page loader of the record that renders the calling component.
 *
 * A component rendered through vue-router's `<RouterView>` injects {@link matchedRouteKey}, the
 * record that view rendered, and that record's loader is the one this component owns. That is what
 * makes a page and a route group nested inside it independent: both call `usePageQuery()` with no
 * argument and each reads its own document, because each is rendered by its own record.
 *
 * A component outside a `<RouterView>` (an app root, a component mounted directly in a test) has no
 * injected record, and falls back to the deepest matched record whose `meta.flamme` is `'page'`:
 * the page currently rendering. Layout records are skipped deliberately, so a page and its layout
 * may each declare a query and neither call site has to say which one it means.
 */
function pageLoader(options?: UseRouteQueryOptions): ResolvedPageLoader {
  rejectDocumentOption(options);
  const route = useRoute();
  const own = ownRecord();
  if (own !== undefined) {
    const resolved = loaderOfRecord(own.meta);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  for (const record of [...route.matched].toReversed()) {
    if (Reflect.get(record.meta, 'flamme') !== 'page') {
      continue;
    }
    const resolved = loaderOfRecord(record.meta);
    if (resolved !== undefined) {
      return resolved;
    }
    throw new Error(
      `The route "${record.path}" is a page but carries no loader (FLM4010). A page ` +
        'declares its query with a colocated document (or a +page.ts "Page" export); a page ' +
        'with no query renders without usePageQuery().',
    );
  }
  throw new Error(
    `usePageQuery() found no page record for "${route.path}" (FLM4010). Call it from a ` +
      'component rendered by a generated route, and install the router with ' +
      '`createFlammeRouter()` from `@flamme/router/auto`.',
  );
}

/** The record's read handle, and the composed loader the navigation ran for it when it composes. */
interface ResolvedPageLoader {
  /** The component-level read handle: the record's own document, or the composed loader. */
  readonly loader: RouteQueryLoader<unknown>;
  /** The composed loader, when the record composes. `undefined` for a per-document record. */
  readonly composed: RouteQueryLoader<unknown> | undefined;
}

/**
 * The route record that renders the calling component, or `undefined` outside a `<RouterView>`.
 *
 * The injected ref is a `RouteRecordNormalized` for the current navigation; reading `.value` once in
 * `setup()` is enough because a record never changes identity for a mounted component (a navigation
 * that reuses the record reuses the component).
 */
function ownRecord(): RouteRecordNormalized | undefined {
  const record = inject(matchedRouteKey, null);
  return record?.value;
}

/**
 * The record's own loader: `pageLoaders` first (the record's own document, which is what masking
 * needs), then `loaders` (the guard's list) when the record has no composed request.
 *
 * On a composed record `meta.loaders[0]` is the composed loader and `pageLoaders[0]` is the
 * record's own document, so the read handle is the document and the composed loader rides along as
 * the record's failure surface. A **carrier** - a page record with no document of its own, whose
 * composed chain is its ancestors' - has no `pageLoaders` and only the composed loader in
 * `meta.loaders`; returning that would hand the page every ancestor field, which is exactly what
 * masking forbids. Its read is `FLM4010`, as it was before composition.
 */
function loaderOfRecord(meta: unknown): ResolvedPageLoader | undefined {
  if (typeof meta !== 'object' || meta === null || Reflect.get(meta, 'flamme') !== 'page') {
    return undefined;
  }
  const own = firstLoader(meta, 'pageLoaders');
  const guard = firstLoader(meta, 'loaders');
  if (own !== undefined) {
    const composed = Reflect.get(meta, 'composed') === true && guard !== own ? guard : undefined;
    return { loader: own, composed };
  }
  if (Reflect.get(meta, 'composed') === true) {
    return undefined;
  }
  return guard === undefined ? undefined : { loader: guard, composed: undefined };
}

/** The first loader of one `meta` member, or `undefined` when it holds none. */
function firstLoader(meta: object, member: string): RouteQueryLoader<unknown> | undefined {
  const value: unknown = Reflect.get(meta, member);
  const first = Array.isArray(value) ? value[0] : undefined;
  return isRouteLoader(first) ? first : undefined;
}

/**
 * Fails loudly on the retired `usePageQuery({ document })` option.
 *
 * A second document is a route group now, and renaming the option to something that quietly reads
 * nothing would hide a page that fetches nothing after the upgrade. JavaScript call sites reach this
 * too: the option is gone from the type, not merely deprecated.
 */
function rejectDocumentOption(options: UseRouteQueryOptions | undefined): void {
  const document: unknown = options === undefined ? undefined : Reflect.get(options, 'document');
  if (document === undefined) {
    return;
  }
  const group = typeof document === 'string' ? `(${document})` : '(name)';
  const from = typeof document === 'string' ? `+page.${document}.gql` : 'the second document';
  throw new Error(
    `usePageQuery({ document: ${JSON.stringify(document)} }) was removed (FLM4015): a route's ` +
      `second document is a route group now. Move ${from} to \`${group}/+page.gql\`, add ` +
      `\`${group}/+page.vue\` beside it, call \`usePageQuery()\` from that component with no ` +
      'argument, and render `<RouterView />` in the parent where the section goes. The parent ' +
      'cannot read the group’s document.',
  );
}

/** `true` for a value that is a route query loader (a callable carrying its artifact). */
function isRouteLoader(value: unknown): value is RouteQueryLoader<unknown> {
  if (typeof value !== 'function') {
    return false;
  }
  const artifact: unknown = Reflect.get(value, 'artifact');
  return typeof artifact === 'object' && artifact !== null;
}

/** The options {@link createFlammeRouter} takes. */
export interface FlammeRouterOptions {
  /** The app's client; every generated loader is bound to it here, once. */
  readonly client: Client;
  /** Defaults to `createWebHistory()`; tests pass a memory history. */
  readonly history?: RouterHistory;
  /**
   * The generated route table, the **base** the hand-written records compose with. Defaults to
   * `$flamme/routes`, which the Flamme Vite plugin (or the CLI) generates and the `$flamme` alias
   * resolves. Pass it explicitly in a test or in a bundle that has no `$flamme` alias.
   */
  readonly routes?: readonly FlammeRoute[] | undefined;
  /**
   * Hand-written route records, composed with the base table by {@link composeFlammeRoutes}: a
   * `name` that matches a generated record replaces it, a `parent` nests under a generated record,
   * and `path: ''` marks a pathless child (the shape a route group emits).
   *
   * ```ts
   * const { router } = await createFlammeRouter({
   *   client,
   *   routes: records, // the generated table
   *   handwritten: [legacySpecies], // one route the file tree cannot express
   * })
   * ```
   *
   * A project with no `src/pages` passes hand-written records alone: with no generated table to
   * import, the base is empty rather than the `FLM4011` failure. Collisions and unknown parents are
   * diagnostics (`FLM4016`, `FLM4017`, `FLM4018`), not silently unreachable routes.
   */
  readonly handwritten?: readonly FlammeRoute[] | undefined;
}

/** What {@link createFlammeRouter} returns. */
export interface FlammeRouter {
  /** The vue-router instance, with every generated loader in its records' `meta.loaders`. */
  readonly router: Router;
  /**
   * The composed flat table the router was built from: the generated records with the hand-written
   * ones merged in. Exported for tools and tests (a route listing, a diagnostic), never read by
   * vue-router, which holds the nested result.
   */
  readonly routes: readonly FlammeRoute[];
  /**
   * Builds the `DataLoaderPlugin` options for this router. The plugin has to be installed on the app
   * **before** the router and it takes the router as an argument, which is why this is a function:
   *
   * ```ts
   * app.use(DataLoaderPlugin, dataLoader())
   * app.use(router)
   * ```
   *
   * `QueryLoaderError` is listed as an expected error, so a failed page read renders the page's own
   * error state instead of cancelling the navigation (the Pokédex's out-of-range id).
   */
  readonly dataLoader: () => {
    readonly router: Router;
    readonly errors: (typeof QueryLoaderError)[];
  };
}

/**
 * Builds the app's router from the generated route table: the one call `main.ts` makes.
 *
 * ```ts
 * const { router, dataLoader } = await createFlammeRouter({ client, history: createWebHistory() })
 * ```
 *
 * Asynchronous because reading the generated route table is a module import. A factory rather than a
 * module singleton, because a router belongs to one app and one client (one client per page load,
 * spec §8.11).
 *
 * Hand-written records compose with the generated table here, before `defineFlammeRoutes` nests it
 * (see {@link FlammeRouterOptions.handwritten}).
 */
export async function createFlammeRouter(options: FlammeRouterOptions): Promise<FlammeRouter> {
  const handwritten = options.handwritten ?? [];
  const generated = options.routes ?? (await generatedRoutes(handwritten.length === 0));
  const routes = composeFlammeRoutes(generated, handwritten);
  const router = createRouter({
    history: options.history ?? createWebHistory(),
    routes: defineFlammeRoutes(routes, options.client),
  });
  // a plain closure rather than a method: `const { dataLoader } = createFlammeRouter(…)` is the
  // documented call shape, and a method would lose its receiver there
  const dataLoader = (): {
    readonly router: Router;
    readonly errors: (typeof QueryLoaderError)[];
  } => ({ router, errors: [QueryLoaderError] });
  return { router, dataLoader, routes };
}

/**
 * The generated route table, installed by the `$flamme/auto-routes` shim.
 *
 * `@flamme/router` cannot statically import a file that does not exist when the package is
 * compiled, so {@link createFlammeRouter} imports the shim on demand (through
 * `importGeneratedShim`) and the shim calls this once at import time. The specifier is a literal, so
 * the Flamme Vite plugin's `resolveId`/`load` hooks answer it while the app is built and the
 * generated tree is part of the bundle; outside such a build the import rejects and one of the
 * errors below is what the app sees.
 */
let generated: readonly FlammeRoute[] | undefined;

/**
 * Installs the generated route table, the flat form `composeFlammeRoutes` reads. Called by the
 * generated `$flamme/auto-routes` shim:
 *
 * ```ts
 * import { setGeneratedRoutes } from '@flamme/router/auto'
 * import { records } from '$flamme/routes'
 * setGeneratedRoutes(records)
 * ```
 */
export function setGeneratedRoutes(routes: readonly FlammeRoute[]): void {
  generated = routes;
}

/** The error codes a bundler or Node raises when the specifier resolves to no module at all. */
const MISSING_MODULE_CODES: ReadonlySet<unknown> = new Set([
  // Node ESM and CJS resolution, which is also what vitest's module runner falls back to
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  // Rollup's unresolved-import error, before it is wrapped in a plugin error
  'UNRESOLVED_IMPORT',
]);

/** The resolution-failure spellings a bundler or a dev server puts in the message. */
const RESOLUTION_FAILURE_PHRASE =
  /does not exist|failed to resolve import|failed to load url|cannot find module/iu;

/**
 * The phrases a browser's module loader rejects a bare specifier with.
 *
 * A page whose chunk still carries `import('$flamme/auto-routes')` (a dev server with no plugin, a
 * bundler that left the specifier alone) hands its module loader a bare specifier, which is not a
 * URL it can fetch. Chromium ("Failed to resolve module specifier …") and WebKit ("… is not a valid
 * absolute URL") both name the specifier; Firefox ("invalid module specifier") names neither it nor
 * a file to fix, which is why {@link FIREFOX_SPECIFIER_PHRASE} exists separately.
 */
const BROWSER_SPECIFIER_PHRASE =
  /failed to resolve module specifier|invalid module specifier|not a valid absolute url/iu;

/**
 * Firefox's bare-specifier rejection, anchored because it carries no specifier to match against.
 *
 * The anchor is what keeps it narrow: only the bare phrase counts, so a `TypeError` thrown while the
 * generated tree evaluates that merely mentions module specifiers stays the broken-shim case.
 */
const FIREFOX_SPECIFIER_PHRASE = /^(?:typeerror: )?invalid module specifier\.?$/iu;

/**
 * `true` when the shim import failed because there is no `$flamme/auto-routes` module, `false` for
 * any other reason.
 *
 * The distinction is the whole opt-out. A project with no `src/pages` has no shim, and with
 * hand-written records of its own that is not an error: the base is empty and those records are the
 * whole table. A shim that resolves and then throws while it evaluates is the opposite case: the
 * app has a generated tree, and treating that failure as "no generated routes" would install a
 * router with every generated route silently missing.
 *
 * A resolution failure names itself four ways: Node sets `code`; the dev server and Rollup throw a
 * message about the specifier ("Failed to load url … Does the file exist?" and "Failed to resolve
 * import …"); a browser handed the un-resolved bare specifier rejects with Chromium's, WebKit's or
 * Firefox's wording; and every one of them but Firefox's carries the specifier. A message from the
 * shim's own evaluation is not matched: only a resolution failure says the module could not be
 * found.
 */
function isMissingShimError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (MISSING_MODULE_CODES.has(Reflect.get(error, 'code'))) {
    return true;
  }
  const message = error.message;
  if (message.includes(GENERATED_SHIM_ID)) {
    return RESOLUTION_FAILURE_PHRASE.test(message) || BROWSER_SPECIFIER_PHRASE.test(message);
  }
  return error instanceof TypeError && FIREFOX_SPECIFIER_PHRASE.test(message.trim());
}

/** The `FLM4011` message for an app that has no `$flamme/auto-routes` module to import. */
function noGeneratedRoutes(): string {
  return (
    'No generated routes were found (FLM4011). `createFlammeRouter()` without an explicit ' +
    '`routes` option reads the `$flamme/auto-routes` shim, which exists only after ' +
    '`flamme generate` ran with the Flamme Vite plugin (or the CLI) and only resolves inside ' +
    'a bundle that carries the `$flamme` alias. Pass `routes` explicitly outside that setup.'
  );
}

/**
 * The `FLM4011` message for a shim that resolved and then threw while it evaluated: the app has a
 * generated tree, and swallowing that failure would install a router with every generated route
 * missing.
 */
function shimFailed(): string {
  return (
    'The generated `$flamme/auto-routes` shim failed to evaluate (FLM4011). It resolved, so the ' +
    'app has a generated tree, but importing it threw before it could install the route table; ' +
    'the router would otherwise ship without a single generated route. Fix the failure in the ' +
    'generated tree (this error is the cause of that one), or pass `routes` explicitly to bypass ' +
    'the shim.'
  );
}

/**
 * The generated routes the alias serves, or `undefined` when no shim ran.
 *
 * `required` is false when the app brought hand-written records of its own: a project with no
 * `src/pages` has no `$flamme/auto-routes` shim at all, and its hand-written table is the whole
 * route table rather than a composition with nothing. That exemption covers a **missing** shim
 * only. A shim that resolves and throws is a broken generated tree, and reporting it is what keeps
 * a project with `src/pages` from silently losing every generated route; a shim that loads without
 * installing a table is the same failure with a different cause.
 */
async function generatedRoutes(required = true): Promise<readonly FlammeRoute[]> {
  if (generated === undefined) {
    try {
      // the generated shim's only job is to call `setGeneratedRoutes`; its namespace is not read
      await importGeneratedShim();
    } catch (error) {
      const missing = isMissingShimError(error);
      if (!required && missing) {
        return [];
      }
      throw new Error(missing ? noGeneratedRoutes() : shimFailed(), { cause: error });
    }
  }
  if (generated === undefined) {
    throw new Error(
      'The generated `$flamme/auto-routes` shim loaded without a route table (FLM4011). Re-run ' +
        '`flamme generate`; the generated tree is stale or hand-edited.',
    );
  }
  return generated;
}

export { createMemoryHistory, createRouter, createWebHistory };
