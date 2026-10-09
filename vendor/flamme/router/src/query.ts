/**
 * `useRouteQuery`: the page's handle on the query its route loader owns.
 *
 * One source of truth per route (REQ-1). The loader declares the document, the variables and the
 * policy; the component renders them and declares nothing. The handle is `useQuery`'s own — the
 * shared store, the pagination surface, `refetch` — so a page can render, page and refetch exactly
 * as it does with `useQuery`, and it is cache-backed because the loader wrote the cache during
 * navigation.
 *
 * The loader's own failure is merged into `errors`: with `DataLoaderPlugin`'s `errors:
 * [QueryLoaderError]` the navigation completes on a failed read, and the failure lives on the
 * loader's `error` ref, so a page that renders the loader's read must render the loader's error too.
 */
import { computed, type ComputedRef } from 'vue';
import { useRoute } from 'vue-router';

import { useQuery, type QueryHandle } from '@flamme/vue';
import type { GraphQLResponseError } from '@flamme/runtime';

import {
  QueryLoaderError,
  isBackgroundLoaderPending,
  pauseLoaderFor,
  type RouteQueryLoader,
} from './loader.js';

/** The `useRouteQuery` options: the two `useQuery` switches that do not change the read itself. */
export interface UseRouteQueryOptions {
  /** Default `true`; `false` defers the first request to `refetch()` or to the loader. */
  readonly fetchOnMount?: boolean;
  /** Keep the previous data visible while a variable change is in flight. Default `true`. */
  readonly keepPreviousData?: boolean;
  /**
   * Pauses this handle's own request while it returns `false`, without unsubscribing: the data stays
   * and keeps following the cache.
   *
   * In the `meta.pageLoaders` shape no navigation guard runs the record's own loader, so this
   * handle's own `loader()` call is what would fetch. A paused handle still reads the loader's refs
   * (they carry the loader's failure surface) but pauses exactly that call, so nothing is sent; the
   * request then comes from this handle's own `useQuery` once it is enabled, where `fetchOnMount`
   * applies as usual.
   *
   * `usePageQuery()` sets it for a **composed** record while the record's composed request is still
   * open (`research/route-composition-design.md` §3.3): the composed write carries the record's own
   * fields, so a read of its participant document during the stream is a second request for data
   * already on its way, and it is the read that paints the deferred boundary meanwhile.
   */
  readonly enabled?: () => boolean;
}

/**
 * The handle `useRouteQuery` returns: `useQuery`'s handle with an error surface that also carries the
 * loader's failed read.
 *
 * Every field but `errors` is the `useQuery` field of the same name; `errors` is a `computed` union
 * of the read's errors and the loader's, which is why it is typed as a `ComputedRef` here.
 */
export interface RouteQueryHandle<TData> extends Omit<QueryHandle<TData>, 'errors'> {
  /** The read's errors plus the loader's, deduplicated by message, or `null` when there are none. */
  readonly errors: ComputedRef<readonly GraphQLResponseError[] | null>;
  /** The route loader's failure, or `null` when the loader did not fail. */
  readonly loaderError: ComputedRef<QueryLoaderError | null>;
}

/**
 * Renders the query a route loader owns.
 *
 * ```vue
 * <script setup lang="ts">
 * const { data, errors, fetching, loadNextPage } = useRouteQuery(useRouteLoaders(LOADERS_KEY).info)
 * </script>
 * ```
 *
 * The loader is called here (in `setup`, where its refs live) so the handle can carry the loader's
 * error, unless the handle is paused at that moment: see {@link UseRouteQueryOptions.enabled}.
 * `DataLoaderPlugin` must be installed on the app before the router: it is what creates the
 * per-router entry the loader's refs come from, and without it the route's `meta.loaders` would not
 * run either. A route that does not list the loader leaves the page's own read to trigger it, so the
 * first paint is the loading state and the request is still the loader's one.
 */
export function useRouteQuery<TData>(
  loader: RouteQueryLoader<TData>,
  options: UseRouteQueryOptions = {},
): RouteQueryHandle<TData> {
  const route = useRoute();
  const policy = loader.policy;
  const loaderEnabled = loader.enabled;
  const handleEnabled = options.enabled;
  const enabled =
    loaderEnabled === undefined && handleEnabled === undefined
      ? undefined
      : (): boolean => (loaderEnabled?.(route) ?? true) && (handleEnabled?.() ?? true);
  // `loader()` is what starts a loader that no navigation guard runs (the `meta.pageLoaders`
  // shape), so a paused handle pauses that one call: it still reads the loader's refs, which are
  // its failure surface, and sends nothing.
  const state =
    enabled === undefined || enabled()
      ? readLoaderState(loader)
      : pauseLoaderFor(loader, () => readLoaderState(loader));
  const query = useQuery(loader.artifact, () => loader.variables(route), {
    ...(policy === undefined ? {} : { policy }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(options.fetchOnMount === undefined ? {} : { fetchOnMount: options.fetchOnMount }),
    ...(options.keepPreviousData === undefined
      ? {}
      : { keepPreviousData: options.keepPreviousData }),
  });

  const loaderError = computed<QueryLoaderError | null>(() => {
    const error: unknown = state?.error.value;
    return error instanceof QueryLoaderError ? error : null;
  });
  const errors = computed<readonly GraphQLResponseError[] | null>(() =>
    mergeErrors(query.errors.value, loaderError.value),
  );
  /**
   * A **background** loader's read is a navigation-level request the page's own store may never have
   * joined (a composed record's own document read is paused while the composed request is open), so
   * the loader's own `isLoading` is part of what "a read has not answered yet" means here. For an
   * awaited loader the navigation has settled before the page mounts, `isLoading` is `false`, and
   * this is the store's own `fetching`.
   */
  const fetching = computed(() => {
    if (query.fetching.value) {
      return true;
    }
    if (!loader.background) {
      return false;
    }
    return isBackgroundLoaderPending(loader) && (state?.isLoading.value ?? false);
  });

  return {
    data: query.data,
    errors,
    fetching,
    partial: query.partial,
    stale: query.stale,
    hasNext: query.hasNext,
    deferred: query.deferred,
    source: query.source,
    variables: query.variables,
    // the cursor surface is present only for a cursor-paginated document; an offset one has none
    // of it (`QueryHandle` types the members as optional, so the handle stays honest)
    ...(query.connection === undefined ? {} : { connection: query.connection }),
    ...(query.pageInfo === undefined ? {} : { pageInfo: query.pageInfo }),
    ...(query.hasNextPage === undefined ? {} : { hasNextPage: query.hasNextPage }),
    ...(query.hasPreviousPage === undefined ? {} : { hasPreviousPage: query.hasPreviousPage }),
    loadingNextPage: query.loadingNextPage,
    ...(query.loadingPreviousPage === undefined
      ? {}
      : { loadingPreviousPage: query.loadingPreviousPage }),
    loadNextPage: () => query.loadNextPage(),
    ...(query.loadPreviousPage === undefined
      ? {}
      : { loadPreviousPage: (): Promise<void> => query.loadPreviousPage?.() ?? Promise.resolve() }),
    refetch: () => query.refetch(),
    get store() {
      return query.store;
    },
    loaderError,
  };
}

/**
 * The loader's own refs (`data`, `isLoading`, `error`), with a readable failure when the plugin that
 * creates them is missing: vue-router keeps them in a per-router entry only `DataLoaderPlugin`
 * installs, so calling the composable without it throws deep inside vue-router.
 */
function readLoaderState<TData>(
  loader: RouteQueryLoader<TData>,
): ReturnType<RouteQueryLoader<TData>> {
  try {
    return loader();
  } catch (error) {
    throw new Error(
      "useRouteQuery() could not read the route loader's state. DataLoaderPlugin must be installed " +
        'on the app before the router: `app.use(DataLoaderPlugin, { router })`.',
      { cause: error },
    );
  }
}

/**
 * The read's errors plus the loader's, without duplicates.
 *
 * The loader's failed read and the page's own read of the same document report the same GraphQL
 * errors (the page's read retries a document the cache could not answer), so a plain concatenation
 * would render every message twice. Errors are compared by message, which is the identity a GraphQL
 * error carries.
 */
function mergeErrors(
  own: readonly GraphQLResponseError[] | null,
  loaderError: QueryLoaderError | null,
): readonly GraphQLResponseError[] | null {
  if (loaderError === null) {
    return own;
  }
  const merged: GraphQLResponseError[] = [...(own ?? [])];
  const seen = new Set(merged.map((error) => error.message));
  for (const error of loaderError.errors) {
    if (!seen.has(error.message)) {
      seen.add(error.message);
      merged.push(error);
    }
  }
  return merged;
}
