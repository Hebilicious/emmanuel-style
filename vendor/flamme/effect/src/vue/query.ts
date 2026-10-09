/**
 * The query atom.
 *
 * The value is `AsyncResult<Data, FlammeError>`: the document's **masked data** in the natural
 * Effect shape, not a bespoke `{ data, loading, error }` union. Before the first read it is
 * `Initial`; while a request is in flight it is `Success(data, { waiting: true })` (or
 * `Initial(true)` when there is no data yet); a failure is `Failure(cause)` carrying the last
 * success as `previousSuccess`, so `AsyncResult.value` still renders what is on screen while the
 * error goes to the error channel.
 *
 * Two things feed it, which is what makes the atom both cache-native and Effect-native:
 *
 * - **The cache.** The atom observes the document with `client.observe` and follows its cache
 *   subscription, so a write to any record the document read re-renders exactly the atoms that read
 *   it. This is the mechanism `useQuery` uses, so an atom and a route loader share one cache entry
 *   and one request.
 * - **The effect.** The request is the `query` effect of this package, run by the atom runtime with
 *   `Flamme` provided and a `Scope` of its own: typed errors arrive in the failure channel,
 *   disposing the atom (or refreshing it) interrupts the request, and a refetch re-runs it with the
 *   previous value still on screen.
 *
 * Everything a read needs that is not data lives in {@link FlammeAtomMeta}, one derived atom away,
 * because `AsyncResult` has no room for it and none of it is a loading state.
 */
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult';
import * as Atom from 'effect/unstable/reactivity/Atom';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';

import { isCacheMiss } from '@flamme/runtime';
import type {
  Artifact,
  CachePolicy,
  Client,
  DataSource,
  DeferredState,
  DocumentStore,
  GraphQLResponseError,
  QueryResult,
  Variables,
} from '@flamme/runtime';

import { resultError } from '../errors.js';
import type { FlammeError } from '../errors.js';
import { query as queryEffect } from '../fns.js';
import type { Flamme } from '../service.js';

/** One query as an atom: the masked data, or the failure, or the previous data while it reloads. */
export type QueryAtom<TData> = Atom.Atom<AsyncResult.AsyncResult<TData, FlammeError>>;

/** What a query atom accepts besides the document and its variables. */
export interface QueryAtomOptions {
  /** Overrides the artifact's baked cache policy for every request this atom makes. */
  readonly policy?: CachePolicy | undefined;
  /**
   * `false` reads the cache and never sends: the atom stays a live view of what the cache holds.
   * Defaults to `true`.
   */
  readonly enabled?: boolean | undefined;
}

/**
 * The Flamme signals an `AsyncResult` cannot carry, as an atom derived from the same cache read.
 *
 * `AsyncResult.isWaiting` is the loading state; nothing here repeats it. `partial` and `stale` say
 * something about the data that is present, `source` says where it came from, `errors` is the
 * GraphQL error list of a result that still has data (a result with no data fails the atom
 * instead), and `hasNext`/`deferred` describe a `@defer`/`@stream` response still arriving.
 */
export interface FlammeAtomMeta {
  /** Some selected fields are absent from the cache. */
  readonly partial: boolean;
  /** The data is present but known to be out of date. */
  readonly stale: boolean;
  /** Where the current data came from. */
  readonly source: DataSource | null;
  /** The GraphQL errors of the last result, or `null`. */
  readonly errors: readonly GraphQLResponseError[] | null;
  /** Incremental delivery: more `@defer`/`@stream` patches are on the way. */
  readonly hasNext: boolean;
  /** Per-label delivery state of this document's `@defer`/`@stream` targets. */
  readonly deferred: DeferredState;
  /** The variables the read used. */
  readonly variables: Variables | null;
}

/** The meta atom of one cache read: everything the `AsyncResult` value does not carry. */
function metaOf<TData>(cached: Atom.Atom<QueryResult<TData>>): Atom.Atom<FlammeAtomMeta> {
  return Atom.map(cached, (result) => ({
    partial: result.partial,
    stale: result.stale,
    source: result.source,
    errors: result.errors,
    hasNext: result.hasNext,
    deferred: result.deferred,
    variables: result.variables,
  }));
}

/** A request is in flight: the atom's own, or one the store behind the cache read started. */
function waitingOf<TData>(
  cached: QueryResult<TData>,
  request: AsyncResult.AsyncResult<QueryResult<TData>, FlammeError>,
): boolean {
  return cached.fetching || AsyncResult.isWaiting(request);
}

/**
 * Folds the cache's read and the request's `AsyncResult` into the one value a component reads.
 *
 * The cache wins over the request for the data itself (it is the masked read of the same document,
 * and it is what updates when another path writes the record); the request supplies the typed error.
 * A result that has data and errors is a success: those errors are in the meta, and the data is
 * still readable, which is what `partial: true` means.
 */
function shape<TData>(
  cached: QueryResult<TData>,
  request: AsyncResult.AsyncResult<QueryResult<TData>, FlammeError>,
  fallbackError: (cached: QueryResult<TData>) => FlammeError | null,
): AsyncResult.AsyncResult<TData, FlammeError> {
  const fromRequest = Option.getOrNull(AsyncResult.value(request));
  const data = cached.data ?? fromRequest?.data ?? null;
  const error =
    Option.getOrNull(AsyncResult.error(request)) ?? (data === null ? fallbackError(cached) : null);
  const waiting = waitingOf(cached, request);
  const previousSuccess =
    data === null ? Option.none() : Option.some(AsyncResult.success<TData, FlammeError>(data));
  if (error !== null) {
    return AsyncResult.fail(error, { previousSuccess, waiting });
  }
  if (data !== null) {
    return AsyncResult.success(data, { waiting });
  }
  return AsyncResult.initial(waiting);
}

/** The store of one query atom, so the request can publish its result through it. */
interface StoreBox<TData> {
  current: DocumentStore<TData> | null;
}

/** The cache read behind one query atom: the store, its subscription and the value it reports. */
function cacheAtom<TData, TInput>(
  client: Client,
  artifact: Artifact<'query', TData, TInput>,
  variables: Variables,
  options: QueryAtomOptions,
  box: StoreBox<TData>,
): Atom.Atom<QueryResult<TData>> {
  return Atom.readable((get) => {
    const store: DocumentStore<TData> = client.observe<TData>({
      artifact,
      variables,
      initialValue: client.readQuery<TData>(artifact, variables).data,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
    });
    box.current = store;
    // the first delivery restates the store's own cache read; every later one is a cache change
    const off = store.subscribe((result) => {
      get.setSelf(result);
    });
    get.addFinalizer(() => {
      off();
      store.cleanup();
      if (box.current === store) {
        box.current = null;
      }
    });
    return store.state;
  });
}

/** One query atom plus the meta atom derived from the same cache read. */
export interface QueryAtoms<TData> {
  /** The value a component reads: `AsyncResult<Data, FlammeError>`. */
  readonly atom: QueryAtom<TData>;
  /** The Flamme signals the value cannot carry. */
  readonly meta: Atom.Atom<FlammeAtomMeta>;
  /** When `true`, the next request is `NetworkOnly`: what a refetch sets before refreshing. */
  readonly network: Atom.Writable<boolean>;
}

/**
 * Builds one query atom over a client and the runtime that provides `Flamme`.
 *
 * `variables` are the atom's own; the store marshals them again against the artifact's defaults,
 * which is idempotent.
 */
export function makeQueryAtoms<TData, TInput>(
  runtime: Atom.AtomRuntime<Flamme>,
  client: Client,
  artifact: Artifact<'query', TData, TInput>,
  variables: Variables,
  options: QueryAtomOptions = {},
): QueryAtoms<TData> {
  const box: StoreBox<TData> = { current: null };
  const cached = cacheAtom<TData, TInput>(client, artifact, variables, options, box);
  /**
   * `true` makes the next request `NetworkOnly`: a refetch is a request, not a cache read.
   *
   * The flag is cleared once that request has run, so a refetch does not turn the atom into a
   * permanently network-first reader for the components that mount later.
   */
  const network = Atom.make(false);
  const request: Atom.Atom<AsyncResult.AsyncResult<QueryResult<TData>, FlammeError>> =
    options.enabled === false
      ? Atom.make(AsyncResult.initial<QueryResult<TData>, FlammeError>(false))
      : runtime.atom(
          Effect.flatMap(Atom.get(network), (only) =>
            queryEffect<TData>(artifact, {
              variables,
              ...(only
                ? { policy: 'NetworkOnly' as const }
                : options.policy === undefined
                  ? {}
                  : { policy: options.policy }),
            }),
          ).pipe(
            // one refetch, one forced request
            Effect.ensuring(Atom.set(network, false)),
            // publish the response's own result: it is the store's `source`, `partial`, `errors`,
            // `hasNext` and `deferred` for the value the request produced. A later write by another
            // path commits a cache read over it, which is what makes those signals honest again.
            Effect.tap((result) =>
              Effect.sync(() => {
                box.current?.set(result);
              }),
            ),
          ),
        );

  const atom: QueryAtom<TData> = Atom.readable(
    (get) =>
      shape<TData>(get(cached), get(request), (result) =>
        resultError(result, artifact.name, variables, isCacheMiss),
      ),
    (refresh) => {
      // a refetch is the request's refresh: the cache read is already live, and refreshing it would
      // only re-read the records it is subscribed to
      refresh(request);
    },
  );

  return { atom, meta: metaOf(cached), network };
}
