/**
 * `@flamme/router` — the bridge between a route and a GraphQL query, built on vue-router's
 * experimental data loaders (D9, spec §11).
 *
 * This entry re-exports the adapter and never imports `vue-router/experimental` itself: every
 * experimental import lives in `./loader.js` (spec §2.2 rule 5). `DataLoaderPlugin` is re-exported
 * so an app installs the plugin from this package instead of reaching into the experimental
 * subpath, and `reroute` is re-exported so redirects from a loader keep the single-import invariant.
 *
 * The idiomatic wiring is the client-bound factory plus the page composable:
 *
 * ```ts
 * // src/loaders.ts — the client is named once
 * export const loaders = createRouteLoaders(client)
 * export const info = loaders.query({ artifact: Info, variables: (route) => ({ id: route.params.id }) })
 * ```
 * ```vue
 * <!-- SpeciesPage.vue — the page never names the query, the client or the variables -->
 * <script setup lang="ts">
 * const { data, errors, fetching } = useRouteQuery(useRouteLoaders(LOADERS_KEY).info)
 * </script>
 * ```
 * ```ts
 * // a row's hover: the record's composed document, warmed for the navigation that may follow
 * prefetchRoute(client, router, router.resolve(speciesPath(id)))
 * ```
 */

/** The plugin that registers the loader navigation guards; install it before the router. */
export {
  DataLoaderPlugin,
  /** The typed error a failed query surfaces through the loader's `error` ref and `router.onError`. */
  QueryLoaderError,
  /** Imperatively fetches a query into the cache (hover, idle, a guard), deduplicated by the client. */
  prefetch,
  /** Imperatively warms one fragment's data for a known parent reference. */
  prefetchFragment,
  /** Creates a basic data loader that seeds and follows the client's cache for one query. */
  queryLoader,
  /** Redirects (or cancels) a navigation from inside a loader. */
  reroute,
} from './loader.js';

/** The adapter's public types: the loader result, its definition, its options and `prefetch` options. */
export type {
  PrefetchFragmentOptions,
  PrefetchOptions,
  QueryLoader,
  QueryLoaderOptions,
  RouteQueryDefinition,
  RouteQueryLoader,
} from './loader.js';

/** Warming what a navigation will read, from a location, outside a navigation (`prefetchRoute`). */
export { prefetchRoute } from './prefetch-route.js';
export type { PrefetchRouteOptions } from './prefetch-route.js';

/** The client-bound factory and the accessor that hands a page its own loaders. */
export { createRouteLoaders, routeLoadersKey, useRouteLoaders } from './loaders.js';
export type { QueryDefinitionOptions, RouteLoaders } from './loaders.js';

/** The composable that renders a route loader's query, and its handle. */
export { useRouteQuery } from './query.js';
export type { RouteQueryHandle, UseRouteQueryOptions } from './query.js';
