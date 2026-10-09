/**
 * `prefetchRoute`: warm exactly what a navigation will read, from a location, outside a navigation
 * (a hover, a viewport entry, idle time).
 *
 * A route record's documents compile into **one composed operation** and the record's loader reads
 * it, so warming a route means running that loader's own read: the artifact the composed loader
 * carries and the variables its own resolver produces for the target location. Anything else warms
 * something the navigation does not read. Warming the participant documents instead (what
 * `prefetch`/`prefetchFragment` would do on their own) warms a *cache* the composed read still finds
 * incomplete, and warming a different artifact is a second request the navigation cannot join.
 *
 * Because the warm goes through `client.query` with the loader's own `(artifact, variables)`, the
 * navigation that follows is either a cache read or a **join** of the request this warm started
 * (§5.6: an identical read already in flight is shared, `@dedupe` defaults to sharing). A route
 * loader settles at the first payload of a `@defer` response, and a read that joins one settles on
 * the same payload, so a warm that is still streaming still makes the navigation free.
 *
 * Three surfaces, three jobs:
 *
 * | call | warms |
 * | --- | --- |
 * | `prefetchRoute` | the document a **navigation** of a location reads, variables included |
 * | `prefetch` | one query artifact you name, with variables you resolve yourself |
 * | `prefetchFragment` | one fragment's data for a known parent reference |
 */
import type { Client, QueryResult } from '@flamme/runtime';
import type { RouteLocation, RouteLocationRaw, Router } from 'vue-router';

import type { RouteQueryDefinition } from './loader.js';

/** The options {@link prefetchRoute} takes. */
export interface PrefetchRouteOptions {
  /** Cancels the warm (a hover that ended, a viewport entry that left). */
  readonly signal?: AbortSignal;
}

/**
 * Warms what a navigation of `to` will read, without navigating there.
 *
 * ```ts
 * // a row's hover: the navigation that follows is a cache read, or joins this warm
 * prefetchRoute(client, router, router.resolve(speciesPath(id)))
 * ```
 *
 * `to` is anything vue-router resolves (a path, a location object, or the result of
 * `router.resolve(href)`), so a call site can warm the same href it renders. The loaders come from
 * the matched records' own meta (`meta.loaders`, else `meta.pageLoaders`), so the warm needs no
 * knowledge of the documents: the record's definitions are the single source of truth.
 *
 * A matched record that **redirects** carries no loader of its own, and `router.resolve` does not
 * follow the redirect, so warming such a location warms nothing: warm the location the record
 * redirects to, which is the read a navigation of it ends up making.
 *
 * Resolves with one result per loader the navigation will run: the reads it warmed, in matched
 * order. The warm is idempotent: a document the cache can answer completely under the loader's own
 * policy costs no request.
 */
export function prefetchRoute(
  client: Client,
  router: Router,
  to: RouteLocationRaw,
  options: PrefetchRouteOptions = {},
): Promise<readonly QueryResult[]> {
  const target = router.resolve(to);
  const loaders = navigationLoaders(target).filter((loader) => loader.enabled?.(target) ?? true);
  return Promise.all(
    loaders.map((loader) =>
      client.query(loader.artifact, {
        variables: loader.variables(target),
        ...(loader.policy === undefined ? {} : { policy: loader.policy }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    ),
  );
}

/**
 * The loaders a navigation of `location` will run.
 *
 * vue-router starts the union of **every** matched record's loaders, but the composition
 * arbitration hands the request to the longest chain, which is the deepest matched record's
 * (`createComposedPageLoader`): every other record's composed loader returns its own cache view
 * without sending. Warming the deepest record that carries loaders is therefore warming the whole
 * navigation, and warming the others would be requests the navigation never issues.
 *
 * `meta.pageLoaders` is the fallback for a record whose documents are not in the guard's list (the
 * shape a record keeps when it composes nothing, or a caller stripped the guard's list): its own
 * document is then the read the page makes, and a warm of it is still a warm of the navigation.
 */
function navigationLoaders(location: RouteLocation): readonly RouteQueryDefinition<unknown>[] {
  const matched = location.matched;
  const guarded = deepestLoaders(matched, 'loaders');
  if (guarded.length > 0) {
    return guarded;
  }
  return deepestLoaders(matched, 'pageLoaders');
}

/** The loaders of the deepest matched record that holds any under `member`. */
function deepestLoaders(
  matched: readonly { readonly meta?: unknown }[],
  member: 'loaders' | 'pageLoaders',
): readonly RouteQueryDefinition<unknown>[] {
  for (let index = matched.length - 1; index >= 0; index -= 1) {
    const meta = matched[index]?.meta;
    if (typeof meta !== 'object' || meta === null) {
      continue;
    }
    const value: unknown = Reflect.get(meta, member);
    if (!Array.isArray(value)) {
      continue;
    }
    const loaders = value.filter(isRouteLoader);
    if (loaders.length > 0) {
      return loaders;
    }
  }
  return [];
}

/** `true` for a value that is a route query loader (a callable carrying its read's definition). */
function isRouteLoader(value: unknown): value is RouteQueryDefinition<unknown> & (() => unknown) {
  if (typeof value !== 'function') {
    return false;
  }
  const artifact: unknown = Reflect.get(value, 'artifact');
  const variables: unknown = Reflect.get(value, 'variables');
  return typeof artifact === 'object' && artifact !== null && typeof variables === 'function';
}
