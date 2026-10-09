/**
 * `@flamme/router`'s vue-router data-loader adapter. **The only file in this package that
 * imports `vue-router/experimental`** (D9, §2.2 rule 5).
 *
 * Level 1 integration (`research/router-loaders-and-rstore.md` A.9): we wrap `defineBasicLoader`,
 * whose only contract is "return the data". The loader context is only `{ signal }`; there is no
 * `onDataLoaderError`, no `useDataLoader` and no `createDataLoader` factory in the published
 * surface, so errors ride on the loader's own `error` ref plus `router.onError`, and redirects use
 * `reroute` (§11.2).
 *
 * The cache is the single source of truth (D9): the loader's `data` is a stable Vue `reactive`
 * object kept in sync with a cache read (`./view.js`), not a one-shot snapshot, and every request
 * goes through `client.query` so the §5.6 in-flight table and the cache subscription do the work.
 */
import type { RouteLocation } from 'vue-router';
import { reactive } from 'vue';
import {
  DataLoaderPlugin,
  defineBasicLoader,
  reroute,
  type UseDataLoaderBasic_LaxData,
} from 'vue-router/experimental';

import {
  ROOT_RECORD,
  isAbortError,
  isCacheMiss,
  isFragmentRef,
  marshalInputs,
  stableStringify,
} from '@flamme/runtime';
import type {
  Artifact,
  ArtifactData,
  ArtifactInput,
  ArtifactKey,
  CachePolicy,
  Client,
  FragmentReference,
  GraphQLResponseError,
  QueryOptions,
  QueryResult,
  Variables,
} from '@flamme/runtime';

import { createCacheView } from './view.js';

/** The plugin that registers the loader guards, and the redirect helper a loader throws. */
export { DataLoaderPlugin, reroute };

/**
 * The basic loader `queryLoader` returns: `.data`, `.isLoading`, `.error` and `.reload()`.
 *
 * `TData` is `null` before the cache holds the document, mirroring `QueryResult.data` (§11.2).
 * `data` is `undefined` as well as `null` because the loader opts into `errors: true`: with an
 * expected-error list configured, a failed load commits no data at all, and vue-router types the
 * loader's result as the lax (`Data | undefined`) shape for exactly that reason.
 */
export type QueryLoader<TData> = UseDataLoaderBasic_LaxData<TData | null>;

/**
 * What a loader knows about the read it owns: the document, how the route maps to its variables, and
 * the two options that change whether and how the request runs.
 *
 * This is the half of a loader a component needs to render the same read through the cache, which is
 * what `useRouteQuery` (the composable) consumes: the page names the loader, never the query.
 */
export interface RouteQueryDefinition<TData> {
  /** The generated query artifact this loader runs. */
  readonly artifact: Artifact<'query', TData>;
  /** The variables for a resolved route, exactly as the loader resolves them. */
  readonly variables: (route: RouteLocation) => Variables;
  /** The policy this loader's request uses, or `undefined` for the artifact's own. */
  readonly policy: CachePolicy | undefined;
  /** The predicate that skips the request, or `undefined` when the loader always runs. */
  readonly enabled: ((route: RouteLocation) => boolean) | undefined;
  /**
   * `true` when this loader's read is **background**: the navigation it belongs to does not wait for
   * it, and the page renders its own pending state until the payload lands.
   *
   * A page's handle adds the loader's own `isLoading` to its `fetching` while this is set, because
   * the loader's read is then the only thing that knows a navigation-level request is still open
   * (see {@link QueryLoaderOptions.background}).
   */
  readonly background: boolean;
}

/**
 * The loader `queryLoader` returns: the vue-router data loader (call it in `setup` for its refs, list
 * it in `meta.loaders` for the navigation) plus the definition above.
 */
export type RouteQueryLoader<TData> = QueryLoader<TData> & RouteQueryDefinition<TData>;

/** The options object `queryLoader` takes (a loader has no injection context, so the client is explicit). */
export interface QueryLoaderOptions<A extends Artifact<'query'>> {
  /** The client every request and cache read goes through. */
  readonly client: Client;
  /** The generated query artifact. */
  readonly artifact: A;
  /** Static variables, or a function of the resolved route. */
  readonly variables?:
    ArtifactInput<A> | ((route: RouteLocation) => ArtifactInput<A>);
  /** Overrides the artifact's and the client's cache policy for this loader's request. */
  readonly policy?: CachePolicy;
  /** Skip the request for routes that cannot satisfy a precondition. */
  readonly enabled?: (route: RouteLocation) => boolean;
  /**
   * Decides whether this loader issues the request, after the cache subscription is attached and
   * before anything is sent. Returning `false` makes the loader resolve with its own cache view and
   * send nothing.
   *
   * A composed route loader uses it for the longest-chain arbitration
   * (`research/route-composition-design.md` §3.2): vue-router unions the loader sets of every matched
   * record, so without it a layout and a page would each issue their own composed request.
   */
  readonly claim?: (route: RouteLocation) => boolean | Promise<boolean>;
  /**
   * `true` makes this loader's read **background**: the navigation guard commits the navigation
   * without waiting for the response, the page renders its own pending state, and the payload lands
   * in the cache when it arrives, updating the page.
   *
   * The read itself is unchanged: the same one request, deduplicated and joinable through the
   * client's in-flight table (§5.6), started by the guard exactly as an awaited loader's is. What
   * changes is who waits. The page's handle (`usePageQuery()`/`useRouteQuery()`) reports `fetching`
   * while the response is outstanding and `data` stays `null`, which is precisely the read that has
   * not answered yet, and a failure arrives on `errors` once the request settles instead of
   * cancelling the navigation that already completed.
   *
   * **SSR still awaits.** A server render cannot paint a pending state, so on the server this option
   * has no effect: vue-router's loader guard awaits a lazy loader on the server whatever its `lazy`
   * value, and the loader's own read settles before the navigation does, which is what the SSR
   * payload is rendered from.
   *
   * A route whose loader must answer before the page can render anything (an authorization check, a
   * redirect keyed on the response) keeps the default and stays awaited.
   */
  readonly background?: boolean;
}

/** The typed error a failed query surfaces through the loader's `error` ref and `router.onError`. */
export class QueryLoaderError extends Error {
  /** The GraphQL or transport errors that failed the query, in arrival order. */
  readonly errors: readonly GraphQLResponseError[];

  constructor(errors: readonly GraphQLResponseError[], options?: ErrorOptions) {
    super(errors[0]?.message ?? 'The query failed.', options);
    this.name = 'QueryLoaderError';
    this.errors = Object.freeze([...errors]);
  }
}

/**
 * The loaders whose next call must not send: the one-call pause a read handle installs.
 *
 * `useRouteQuery()`'s `enabled` option pauses the handle's own request, but `loader()` is what
 * **starts** a loader that no navigation guard runs (the `meta.pageLoaders` shape), and the handle
 * still has to read that loader's refs: they are where a failed navigation guard read lives. The
 * set is the pause itself, and {@link pauseLoaderFor} keeps it to the one synchronous call the
 * handle makes.
 */
const pausedLoaders = new WeakSet<object>();

/**
 * Runs `read` with `loader`'s own request paused, and restores the loader afterwards.
 *
 * Internal to `@flamme/router`: only `useRouteQuery()` calls it, for the single `loader()` read it
 * makes while the handle is disabled. The pause covers the synchronous body run that read starts,
 * which is where `client.query` would be called; a call that finds vue-router's entry already in
 * place runs no body at all, so the pause is a no-op there.
 */
export function pauseLoaderFor<TData, TResult>(
  loader: RouteQueryLoader<TData>,
  read: () => TResult,
): TResult {
  pausedLoaders.add(loader);
  try {
    return read();
  } finally {
    pausedLoaders.delete(loader);
  }
}

/**
 * The background loaders whose navigation-level request is still open, and the predicate the page's
 * handle reads through.
 *
 * A background loader is the only thing that knows its navigation-level read is outstanding: the
 * guard has already committed, so vue-router reports the navigation as done, and the page's own read
 * of the same document may legitimately never have started (a composed record's own document read is
 * paused while the composed request is open, `research/route-composition-design.md` §3.3). `fetching`
 * on the handle therefore unions the loader's own `isLoading` in while the entry is marked here,
 * which is what makes "the page renders its own pending state" true rather than nearly true.
 *
 * The set is `reactive` rather than a `WeakSet`, so the handle's `computed` re-evaluates when it
 * changes, and it is keyed by the loader, so it can never leak across apps.
 */
const pendingBackgroundLoaders = reactive(new Set<object>());

/** Marks a background loader's navigation-level request as open, and returns the undo. */
function markBackgroundPending(loader: object): () => void {
  pendingBackgroundLoaders.add(loader);
  return () => {
    pendingBackgroundLoaders.delete(loader);
  };
}

/**
 * `true` while a **background** loader's navigation-level request is still open.
 *
 * `useRouteQuery()` reads it to include the loader's own `isLoading` in the handle's `fetching`: for
 * an awaited loader the navigation has always settled before a page mounts, so its `isLoading` is
 * already `false` and the union changes nothing.
 */
export function isBackgroundLoaderPending(loader: object): boolean {
  return pendingBackgroundLoaders.has(loader);
}

/**
 * Builds a vue-router basic data loader that seeds and follows the client's cache for one query.
 *
 * During navigation the loader resolves its variables from the route, subscribes to the document's
 * cache read, calls `client.query({ variables, policy, signal, onFirstPayload })` and returns the
 * stable reactive data object; a cancelled navigation's `signal` aborts the request and its rejection
 * is rethrown unchanged so the loader machinery swallows it (§11.2).
 *
 * ## The loader resolves at the first payload
 *
 * A `@defer`/`@stream` response is several payloads on one request, and the navigation does not wait
 * for the last one: the loader settles once **its own** response's first payload has reached the
 * cache and returns, while the client keeps merging the remaining patches into the cache. That is
 * what makes the deferral visible in an app: the page renders the boundary's fallback at first paint
 * and fills in as the patches land, from the same one request.
 *
 * The signal is the runtime's own per-request first-payload channel (`QueryOptions.onFirstPayload`,
 * §7.13), which fires for the request this loader **leads** and for one it **joins**. Joining is the
 * default for an identical read (§5.6: same `(hash, variables)`, `@dedupe` defaults to sharing), so a
 * navigation whose document is already being warmed settles on that warm's first payload rather than
 * issuing, or waiting for, a second request. The channel is anchored to the request, not to the
 * cache: another document writing the records this selection reads raises cache notifications but
 * never this loader's payload.
 *
 * Two consequences are deliberate. A failure that arrives **after** the first payload cannot fail
 * the loader any more (the navigation is complete); it rides on the page's own read, which joined
 * the same in-flight request and receives its errors. And the read itself still settles with the
 * whole response, so the request keeps streaming into the cache and every other reader of it, the
 * page's own document read above all, keeps finding the fields as they were deferred.
 *
 * The returned object is the loader itself, with the read's definition attached
 * ({@link RouteQueryDefinition}), so a component can render the same read through
 * `useRouteQuery(loader)` instead of declaring the query a second time.
 */
export function queryLoader<A extends Artifact<'query'>>(
  options: QueryLoaderOptions<A>,
): RouteQueryLoader<ArtifactData<A>> {
  const { client, artifact } = options;
  const query = asQueryArtifact(artifact);
  const view = createCacheView<ArtifactData<A>>();
  let resolved: Variables = {};
  let attached: string | null = null;
  let stop: (() => void) | null = null;
  /** The current navigation's first-payload resolver, armed by {@link nextPayload}. */
  let settleFirstPayload: (() => void) | null = null;
  /** The request's first-payload result, once it has one (the leader's, when this read joined). */
  let firstPayload: QueryResult<ArtifactData<A>> | null = null;

  /** Resolves when the current request's first payload has reached the cache. */
  function nextPayload(): Promise<void> {
    firstPayload = null;
    return new Promise<void>((resolve) => {
      settleFirstPayload = resolve;
    });
  }

  /**
   * The runtime's first-payload channel for the request this read uses: the response announces more
   * payloads (`hasNext: true`), the cache has the first of them, and the navigation is answerable.
   */
  const onFirstPayload = (result: QueryResult): void => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the read is this loader's own artifact, so the result is this loader's data
    firstPayload = result as QueryResult<ArtifactData<A>>;
    const settle = settleFirstPayload;
    settleFirstPayload = null;
    settle?.();
  };

  /** Re-reads the cache into the view with the variables the current navigation resolved. */
  function sync(): void {
    view.sync(client.readQuery<ArtifactData<A>>(query, resolved).data);
  }

  /** Points the subscription at this navigation's variables (re-subscribing only when they change). */
  function attach(route: RouteLocation): Variables {
    resolved = marshalInputs(artifact, resolveVariables(options.variables, route));
    const key = stableStringify(resolved);
    if (key !== attached) {
      stop?.();
      stop = client.cache.subscribe({
        // The variables are part of the key: the registry indexes the `(record, field)` pairs a
        // subscription reads *when it is created*, and the field keys depend on the variables
        // (`species(id: 1)` vs `species(id: 2)`). Two navigations that share a key without them would
        // leave the second subscription indexed against the first navigation's fields, so a write
        // for the new variables would never mark it dirty and the loader would never be notified.
        key: `${ROOT_RECORD}::${artifact.hash}::${key}`,
        rootType: artifact.rootType,
        selection: artifact.selection,
        parentID: ROOT_RECORD,
        variables: () => resolved,
        onMessage: () => {
          sync();
        },
      });
      attached = key;
    }
    sync();
    return resolved;
  }

  const loader = defineBasicLoader<ArtifactData<A> | null>(
    async (route, context) => {
      const variables = attach(route);
      if (options.enabled !== undefined && !options.enabled(route)) {
        return view.value;
      }
      if (pausedLoaders.has(loader)) {
        // A read handle paused its own call (`pauseLoaderFor`): it wants this loader's refs, not a
        // request, so the body stops here without sending.
        return view.value;
      }
      if (options.claim !== undefined && !(await options.claim(route))) {
        // A longer chain in this navigation owns the request: its composed document is a superset of
        // this one's, and the read above has already subscribed this loader's own view to the cache.
        return view.value;
      }
      const signal = context.signal;
      const pending = nextPayload();
      // A background read is outstanding until its response settles, which is exactly how long the
      // loader's own `isLoading` is true and the page's handle must report `fetching`
      // (`pendingBackgroundLoaders`). The mark covers the whole read, `finally` below releases it.
      const unmark = options.background === true ? markBackgroundPending(loader) : null;
      try {
        const request = client.query<ArtifactData<A>>(
          query,
          requestOptions(variables, options.policy, signal, onFirstPayload),
        );
        const settled: QueryResult<ArtifactData<A>> | null = await Promise.race([
          // The first payload reached the cache: the navigation is answerable now, and the request
          // keeps streaming into the same read behind it.
          pending.then(() => null),
          request,
        ]);
        if (settled === null) {
          // Nothing may throw after the navigation settled: the page's own read of this document
          // joined the request and carries whatever it reports next.
          void request.catch(() => undefined);
          // The same rule `failuresOf` applies, over the first payload the runtime handed us: a
          // cache miss is not a failure, and a partial read reports through `partial`.
          const failures =
            firstPayload === null ? [] : failuresOf(firstPayload, query.partial === true);
          if (failures.length > 0) {
            throw new QueryLoaderError(failures);
          }
          if (firstPayload !== null && firstPayload.data !== null) {
            view.sync(firstPayload.data);
          }
          return view.value;
        }
        const failures = failuresOf(settled, query.partial === true);
        if (failures.length > 0) {
          throw new QueryLoaderError(failures);
        }
        if (settled.data !== null) {
          view.sync(settled.data);
        }
        return view.value;
      } catch (error) {
        if (signal?.aborted === true) {
          // the loader machinery only swallows the rejection when it is the signal's own reason
          throw signal.reason;
        }
        if (isAbortError(error, NEVER_ABORTED)) {
          throw error;
        }
        if (error instanceof QueryLoaderError) {
          throw error;
        }
        throw new QueryLoaderError(errorList(error), { cause: error });
      } finally {
        unmark?.();
      }
      // `errors: true` opts this loader into `DataLoaderPlugin`'s `errors` list. vue-router only
      // consults that list when the loader's own `options.errors === true`; without the opt-in an
      // app-level `errors: [QueryLoaderError]` could never keep an expected failure (a missing
      // species) from cancelling the navigation. With no such list configured, the rejection still
      // fails the navigation exactly as before.
    },
    // `lazy` is vue-router's own spelling for "do not hold the client-side navigation on this
    // loader". It is deliberately **not** mirrored into the loader body: the body still awaits its
    // read, which keeps `isLoading` honest for the page's `fetching`, keeps a failure on the loader's
    // `error` ref, and is what the server awaits (vue-router's guard awaits a lazy loader on the
    // server whatever this says), which is the SSR guarantee `background` documents.
    { errors: true, lazy: options.background === true },
  );
  // The loader stays callable and stays the value `meta.loaders` holds; the definition rides on it
  // so `useRouteQuery(loader)` can render the same read without the page naming the document again.
  return Object.assign(loader, definitionOf(options));
}

/** The definition half of a built loader; `Object.assign` keeps the callable loader's identity. */
function definitionOf<A extends Artifact<'query'>>(
  options: QueryLoaderOptions<A>,
): RouteQueryDefinition<ArtifactData<A>> {
  return {
    artifact: asQueryArtifact(options.artifact),
    variables: (route) => resolveVariables(options.variables, route),
    policy: options.policy,
    enabled: options.enabled,
    background: options.background === true,
  };
}

/** A signal that can never abort, so `isAbortError` only inspects the error's own name. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

/** The options {@link prefetch} takes. */
export interface PrefetchOptions {
  /** Overrides the artifact's and the client's cache policy for this request. */
  readonly policy?: CachePolicy;
  /** Cancels the request (a hover that ended, an aborted guard). */
  readonly signal?: AbortSignal;
}

/**
 * Imperatively fetches a query into the cache with no loader and no route involved (hover, idle, a
 * navigation guard).
 *
 * Deduplication is the client's own §5.6 in-flight table (`packages/runtime/src/requests.ts`), so
 * two prefetches of the same `(hash, variables)` share one wire request and a prefetch that races a
 * component `useQuery` joins it; this adapter keeps no second table.
 */
export function prefetch<A extends Artifact<'query'>>(
  client: Client,
  artifact: A,
  variables: ArtifactInput<A>,
  options: PrefetchOptions = {},
): Promise<QueryResult<ArtifactData<A>>> {
  return client.query<ArtifactData<A>>(
    asQueryArtifact(artifact),
    requestOptions(asVariables(variables), options.policy, options.signal),
  );
}

/**
 * The options {@link prefetchFragment} takes: the parent document that spreads the fragment, and the
 * variables that document is fetched with.
 *
 * A fragment has no request of its own (§3.2, D3): its data reaches the cache through a parent
 * document's selection. Warming a fragment therefore means running that parent's query, which is why
 * the parent is part of the call.
 */
export interface PrefetchFragmentOptions<P extends Artifact<'query'>> {
  /** The document whose selection spreads the fragment on the way to the reference's record. */
  readonly parent: P;
  /** The variables the parent document is requested with. */
  readonly variables: ArtifactInput<P>;
  /** Overrides the artifact's and the client's cache policy for the parent request. */
  readonly policy?: CachePolicy;
  /** Cancels the request (a hover that ended, an aborted modal). */
  readonly signal?: AbortSignal;
}

/**
 * Warms one fragment's data for a known parent reference (hover, a modal, a sidebar): the imperative
 * case where a component is about to call `useFragment` with a reference the current route's
 * documents did not produce.
 *
 * Already-warm data is returned without a request, so a prefetch of something the cache holds is a
 * cache read. Otherwise the parent document is fetched and the fragment is re-read from the cache;
 * that request is the client's own §5.6 entry for `(parent hash, variables)`, so a
 * `prefetchFragment` that races an identical in-flight read (a second prefetch, a component's
 * `useQuery`, the route's loader) joins it instead of issuing a second wire request. A failed parent
 * request still resolves when the fragment read produced data, so a partially warm fragment is
 * usable; it rethrows only when the read has nothing.
 */
export async function prefetchFragment<F extends Artifact<'fragment'>, P extends Artifact<'query'>>(
  client: Client,
  fragment: F,
  reference: FragmentReference | null | undefined,
  options: PrefetchFragmentOptions<P>,
): Promise<QueryResult<ArtifactData<F>>> {
  const document = asFragmentArtifact(fragment);
  const cached = readFragment(client, document, reference);
  // A reference that is not a `{ parent, variables }` payload addresses no record, so there is
  // nothing a parent request could warm; the read above is the whole answer (`readFragment`
  // already warned about a malformed payload).
  if (!isFragmentRef(reference) || isWarm(cached)) {
    return cached;
  }
  try {
    await client.query<ArtifactData<P>>(
      asQueryArtifact(options.parent),
      requestOptions(asVariables(options.variables), options.policy, options.signal),
    );
  } catch (error) {
    const partial = readFragment(client, document, reference);
    if (partial.data === null) {
      throw error;
    }
    return partial;
  }
  return readFragment(client, document, reference);
}

/** `true` when a fragment read is complete and fresh, so no request could improve it. */
function isWarm(result: QueryResult): boolean {
  return result.data !== null && !result.partial && !result.stale;
}

/** The masked fragment read `prefetchFragment` resolves with. */
function readFragment<F extends Artifact<'fragment'>>(
  client: Client,
  document: Artifact<'fragment', ArtifactData<F>, unknown, ArtifactKey<F>>,
  reference: FragmentReference | null | undefined,
): QueryResult<ArtifactData<F>> {
  return client.readFragment<ArtifactData<F>, ArtifactKey<F>>(document, reference);
}

/** The variable option of this artifact as a plain `Variables` record. */
function resolveVariables<A extends Artifact<'query'>>(
  option: QueryLoaderOptions<A>['variables'],
  route: RouteLocation,
): Variables {
  if (option === undefined) {
    return {};
  }
  if (isVariablesGetter<A>(option)) {
    return asVariables(option(route));
  }
  return asVariables(option);
}

/** `true` when the variable option is a function of the route. */
function isVariablesGetter<A extends Artifact<'query'>>(
  option: unknown,
): option is (route: RouteLocation) => ArtifactInput<A> {
  return typeof option === 'function';
}

/** Narrows an arbitrary resolved variable value to the `Variables` record the client takes. */
function asVariables(value: unknown): Variables {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a non-null, non-array object is a Variables record at runtime
  return value as Variables;
}

/**
 * The real errors of a settled result: a `CacheOnly` miss is an expected state, not a failure, and a
 * `partial` artifact accepts errors next to the data it did resolve (§5.2). Any other error is the
 * query failing, whatever data came back with it, so it reaches the loader's `error` ref; a result
 * that carries errors and a non-null payload is otherwise indistinguishable from success.
 */
function failuresOf<TData>(
  result: QueryResult<TData>,
  partial: boolean,
): readonly GraphQLResponseError[] {
  if (result.errors === null || partial) {
    return [];
  }
  return result.errors.filter((error) => !isCacheMiss(error));
}

/** The errors a rejection carries: the §5.2 error list, an `Error`, or any other thrown value. */
function errorList(error: unknown): readonly GraphQLResponseError[] {
  if (isResponseErrorList(error)) {
    return error;
  }
  if (error instanceof Error) {
    return [{ message: error.message }];
  }
  return [{ message: String(error) }];
}

/** `true` when a rejection value is the error list `throwOnError` produces for a GraphQL payload. */
function isResponseErrorList(value: unknown): value is readonly GraphQLResponseError[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every((item: unknown) => isResponseError(item));
}

/** `true` for a `GraphQLResponseError`-shaped object. */
function isResponseError(value: unknown): value is GraphQLResponseError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { readonly message?: unknown }).message === 'string';
}

/** The `QueryOptions` one navigation builds; absent options are not sent (exactOptionalPropertyTypes). */
function requestOptions(
  variables: Variables,
  policy: CachePolicy | undefined,
  signal: AbortSignal | undefined,
  onFirstPayload?: (result: QueryResult) => void,
): QueryOptions {
  return {
    variables,
    ...(onFirstPayload === undefined ? {} : { onFirstPayload }),
    ...(policy === undefined ? {} : { policy }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/** The artifact as the result-parameterised type `client.query`/`readQuery` take. */
function asQueryArtifact<A extends Artifact<'query'>>(
  artifact: A,
): Artifact<'query', ArtifactData<A>> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the phantom `__data` carrier is what makes the result type unnameable without this
  return artifact as Artifact<'query', ArtifactData<A>>;
}

/** The fragment as the reference-parameterised type `client.readFragment` takes. */
function asFragmentArtifact<F extends Artifact<'fragment'>>(
  artifact: F,
): Artifact<'fragment', ArtifactData<F>, unknown, ArtifactKey<F>> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the phantom `__data`/`__key` carriers are what make the result and reference types unnameable without this
  return artifact as Artifact<'fragment', ArtifactData<F>, unknown, ArtifactKey<F>>;
}
