/**
 * The client-bound loader factory: one `createRouteLoaders(client)` call at router-creation time, and
 * every loader, prefetch and fragment prefetch after it needs no client argument.
 *
 * The client is installed once by `app.use(FlammePlugin, …)` for composables, but a loader runs
 * during navigation, outside any component, so it cannot inject. Binding the client into a factory
 * is the ergonomic answer: the call site names the document and the variables, never the client.
 *
 * `routeLoadersKey`/`useRouteLoaders` are the matching accessor for the loader values: a loader is
 * created per app (one client per page load, §8.11), so a page reaches its own loader through the
 * provided map rather than by importing a module-scope value that could not exist yet.
 */
import { inject, type InjectionKey } from 'vue';

import type {
  Artifact,
  ArtifactData,
  ArtifactInput,
  Client,
  FragmentReference,
  QueryResult,
} from '@flamme/runtime';

import {
  prefetch,
  prefetchFragment,
  queryLoader,
  type PrefetchFragmentOptions,
  type PrefetchOptions,
  type QueryLoaderOptions,
  type RouteQueryLoader,
} from './loader.js';

/** The options factory-built loaders take: `queryLoader`'s, with the client already bound. */
export type QueryDefinitionOptions<A extends Artifact<'query'>> = Omit<
  QueryLoaderOptions<A>,
  'client'
>;

/**
 * One app's loaders, bound to its client.
 *
 * `query` builds a route loader, `prefetch` warms a whole query and `prefetchFragment` warms one
 * fragment for a known parent reference; all three take the same arguments as their client-first
 * counterparts in `./loader.js`.
 */
export interface RouteLoaders {
  /** The client every loader of this factory queries through. */
  readonly client: Client;
  /** Builds a route loader for one query; list it in the route's `meta.loaders`. */
  query<A extends Artifact<'query'>>(
    options: QueryDefinitionOptions<A>,
  ): RouteQueryLoader<ArtifactData<A>>;
  /** Warms a query into the cache with no loader and no route involved (hover, idle, a guard). */
  prefetch<A extends Artifact<'query'>>(
    artifact: A,
    variables: ArtifactInput<A>,
    options?: PrefetchOptions,
  ): Promise<QueryResult<ArtifactData<A>>>;
  /** Warms one fragment's data for a known parent reference (hover, a modal, a sidebar). */
  prefetchFragment<F extends Artifact<'fragment'>, P extends Artifact<'query'>>(
    fragment: F,
    reference: FragmentReference | null | undefined,
    options: PrefetchFragmentOptions<P>,
  ): Promise<QueryResult<ArtifactData<F>>>;
}

/**
 * Binds a client once and yields the loaders that need no client argument.
 *
 * ```ts
 * const loaders = createRouteLoaders(client)
 * export const info = loaders.query({ artifact: Info, variables: (route) => ({ id: route.params.id }) })
 * ```
 */
export function createRouteLoaders(client: Client): RouteLoaders {
  return {
    client,
    query<A extends Artifact<'query'>>(
      options: QueryDefinitionOptions<A>,
    ): RouteQueryLoader<ArtifactData<A>> {
      return queryLoader({ ...options, client });
    },
    prefetch<A extends Artifact<'query'>>(
      artifact: A,
      variables: ArtifactInput<A>,
      options: PrefetchOptions = {},
    ): Promise<QueryResult<ArtifactData<A>>> {
      return prefetch(client, artifact, variables, options);
    },
    prefetchFragment<F extends Artifact<'fragment'>, P extends Artifact<'query'>>(
      fragment: F,
      reference: FragmentReference | null | undefined,
      options: PrefetchFragmentOptions<P>,
    ): Promise<QueryResult<ArtifactData<F>>> {
      return prefetchFragment(client, fragment, reference, options);
    },
  };
}

/**
 * The injection key a loaders map is provided under. `TMap` is the app's own declaration of its
 * loaders, so `useRouteLoaders(key)` hands the page typed loaders without a cast at the call site.
 *
 * ```ts
 * export const LOADERS_KEY = routeLoadersKey<AppLoaders>()
 * app.provide(LOADERS_KEY, { info })
 * ```
 */
export function routeLoadersKey<TMap extends object>(): InjectionKey<TMap> {
  // A fresh symbol per call is the runtime identity; the map's shape is the caller's declaration.
  return Symbol('flamme-route-loaders');
}

/** The loaders map an ancestor provided (usually the app). Throws when nothing was provided. */
export function useRouteLoaders<TMap extends object>(key: InjectionKey<TMap>): TMap {
  const loaders = inject(key, null);
  if (loaders === null) {
    throw new Error(
      'No route loaders were provided (FLM4009). Call `app.provide(LOADERS_KEY, loaders)` before ' +
        'the app mounts, where `LOADERS_KEY` is the key `routeLoadersKey()` returned.',
    );
  }
  return loaders;
}
