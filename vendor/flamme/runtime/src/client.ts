/**
 * The client, its configuration and the transport seam (§5.1).
 *
 * `Client` owns three things: the cache, the plugin list and the in-flight request table that makes
 * §5.6 dedupe work across stores. It never touches `window` and holds no module-level state, so one
 * client per app (or per SSR request) is the whole lifecycle contract.
 *
 * The mutable internals live under a symbol rather than in `#private` fields, so `Client` stays
 * **structurally** typed exactly as §5.1 declares it: a test double that implements the declared
 * surface is still assignable, which is what `packages/runtime/test/cache/fake-client.ts` relies on.
 */
import type {
  Artifact,
  ArtifactKind,
  CachePolicy,
  FragmentReference,
  Variables,
} from './artifact.js';
import { Cache, type ConnectionSnapshot } from './cache.js';
import { keyFieldsForType } from './cache/keys.js';
import { NULL_PAGE_INFO } from './cache/pages.js';
import type { IncrementalPatch } from './incremental.js';
import { NO_DEFERRED } from './incremental.js';
import { DefaultQueryLifecycle } from './lifecycle.js';
import type { QueryLifecycle, QueryLifecycleOptions } from './lifecycle.js';
import { isPending } from './loading.js';
import type { ClientPlugin } from './pipeline.js';
import type { QueryResult } from './result.js';
import type { SerializedCache, SerializedChanges } from './serialize.js';
import { DocumentStore } from './store.js';
import { DisposalStack } from './disposal.js';
import { RequestRegistry } from './requests.js';
import { defaultPlugins } from './plugins/index.js';
import { readDocument, reportPartial } from './reader.js';
import { marshalInputs } from './variables.js';
import { isFragmentRef } from './mask.js';
import { ClientDisposedError } from './errors.js';
import { devWarn } from './dev.js';

export interface TransportRequest {
  /** `artifact.raw` — the operation plus its transitive fragments, already printed. */
  readonly query: string;
  readonly operationName: string;
  /** `artifact.hash`; the document id used for dedupe and persisted queries. */
  readonly hash: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly artifact: Artifact;
  /**
   * Present when the client is configured for persisted queries (additive, §5.1). A transport reads
   * it to decide between sending the id and sending the document; `undefined` means "send the
   * document exactly as before".
   */
  readonly persistedQuery?: PersistedQuerySpec;
}

/**
 * The APQ marker on a transport request (`research/answers-report.md` Q4): the id is
 * `artifact.hash` (`sha256` of the printed document), sent as
 * `extensions.persistedQuery = { version: 1, sha256Hash }`, and the retry sends the same extension
 * alongside the full document.
 */
export interface PersistedQuerySpec {
  /** The only mode in this slice; the Apollo APQ shape. */
  readonly mode: 'apq';
  /** `sha256` hex of `query`, which is `artifact.hash`. */
  readonly hash: string;
  /** `false` sends the id alone; `true` sends the document too (the retry). */
  readonly sendDocument: boolean;
  /** `true` lets the transport/plugin retry once with `sendDocument: true` on a miss. */
  readonly retryOnNotFound: boolean;
}

/** `persistedQueries` after the defaults are applied; `undefined` keeps the pre-persisted behaviour. */
export interface ResolvedPersistedQueryConfig {
  readonly mode: 'apq';
  /** Default `true`: one retry with the full document when the server does not know the id. */
  readonly retryOnNotFound: boolean;
}

/** `persistedQueries: true` or `{ retryOnNotFound }` enables APQ for every request of a client. */
export type PersistedQueryConfig = boolean | PersistedQueryOptions;

/** Options form of {@link PersistedQueryConfig}. */
export interface PersistedQueryOptions {
  /** Retry once with the full document on `PersistedQueryNotFound`. Default `true`. */
  readonly retryOnNotFound?: boolean;
}

export interface TransportResponse {
  readonly data?: Readonly<Record<string, unknown>> | null;
  readonly errors?: readonly GraphQLResponseError[] | null;
  readonly extensions?: Readonly<Record<string, unknown>> | null;
  /**
   * Incremental delivery (§7.13): this part announced more parts. `false`/absent for a single-part
   * response, which is what keeps every non-incremental transport unchanged.
   */
  readonly hasNext?: boolean;
  /**
   * The remaining incremental payloads, already normalized, when the response is multipart. A
   * transport that answers in one part leaves this absent. Consumed once, by the client's cache
   * stage, which merges each patch and commits the result before the next one is read.
   */
  readonly patches?: AsyncIterable<IncrementalPatch>;
}

export interface GraphQLResponseError {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly locations?: readonly { readonly line: number; readonly column: number }[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/** The transport seam. Always receives a signal; must reject with an AbortError when aborted. */
export type TransportFn = (
  request: TransportRequest,
  signal: AbortSignal,
) => Promise<TransportResponse>;

export type SubscribeFn = (
  request: TransportRequest,
  handlers: {
    readonly next: (value: TransportResponse) => void;
    readonly error: (error: unknown) => void;
    readonly complete: () => void;
  },
) => () => void;

/**
 * The payload channel `Client.subscribe` delivers a subscription's results to (additive, §8.6).
 *
 * `next` runs synchronously with the store's current result and again after every payload or
 * transport failure, so a composable can mirror `data`/`errors` without touching the raw transport.
 * `open` fires when the transport accepts and `close` fires exactly once when it completes, fails,
 * or the returned unsubscribe runs, which is what a `connected` flag needs.
 */
export interface SubscriptionHandlers<TData = unknown> {
  next(result: QueryResult<TData>): void;
  open?(): void;
  close?(): void;
}

export interface ClientConfig {
  readonly fetch: TransportFn;
  readonly subscribe?: SubscribeFn;
  readonly cache?: Cache;
  readonly plugins?: readonly ClientPlugin[];
  readonly cachePolicy?: CachePolicy;
  readonly partial?: boolean;
  /** Cache-key configuration: type name → key fields. The compiler merges schema `@key` with `config.types`. */
  readonly keys?: Readonly<Record<string, readonly string[]>>;
  readonly defaultKeys?: readonly string[];
  readonly scalars?: Readonly<Record<string, { readonly unmarshal?: (value: unknown) => unknown }>>;
  /** `false` disables all fetching (tests, SSR of a fully hydrated page). */
  readonly enabled?: boolean;
  /**
   * Replaces `createQueryLifecycle` (§5.8) for every store this client creates. Type-only hook for
   * a future `@flamme/xstate`; `DocumentStore` wraps the result (REQ-2.9, D5).
   */
  readonly lifecycle?: <TData>(options: QueryLifecycleOptions<TData>) => QueryLifecycle<TData>;
  /** `false` makes `send` resolve with the errors in the state instead of rejecting (additive, §12.1). */
  readonly throwOnError?: boolean;
  /**
   * Persisted queries (`research/answers-report.md` Q4): send
   * `{ variables, extensions: { persistedQuery: { version: 1, sha256Hash } } }` with the document
   * left out, and retry once with the full document when the server answers
   * `PersistedQueryNotFound`. Absent or `false` (the default) leaves every request byte-identical
   * to the pre-persisted behaviour.
   */
  readonly persistedQueries?: PersistedQueryConfig;
}

/**
 * `ClientConfig` after the defaults are applied. The required members here are exactly the ones the
 * client resolves once, so a plugin or a store reads them without a fallback of its own (§5.1).
 */
export interface ResolvedClientConfig extends ClientConfig {
  readonly cache: Cache;
  readonly plugins: readonly ClientPlugin[];
  readonly cachePolicy: CachePolicy;
  readonly partial: boolean;
  readonly keys: Readonly<Record<string, readonly string[]>>;
  readonly defaultKeys: readonly string[];
  readonly scalars: Readonly<Record<string, { readonly unmarshal?: (value: unknown) => unknown }>>;
  readonly enabled: boolean;
  readonly lifecycle: <TData>(options: QueryLifecycleOptions<TData>) => QueryLifecycle<TData>;
  /** Resolved {@link PersistedQueryConfig}; absent when persisted queries are off. */
  readonly persistedQueries?: ResolvedPersistedQueryConfig;
}

/** The client: the cache, the plugin list and the §5.6 in-flight table (one per app or SSR request). */
export class Client {
  readonly cache: Cache;
  readonly config: ResolvedClientConfig;

  constructor(config: ClientConfig) {
    const cache =
      config.cache ??
      new Cache({
        ...(config.keys === undefined ? {} : { keys: config.keys }),
        ...(config.defaultKeys === undefined ? {} : { defaultKeys: config.defaultKeys }),
        ...(config.scalars === undefined ? {} : { scalars: config.scalars }),
      });
    this.cache = cache;
    const persisted = resolvePersistedQueries(config.persistedQueries);
    const { persistedQueries: _configured, ...rest } = config;
    void _configured;
    this.config = {
      ...rest,
      cache,
      plugins: config.plugins ?? [],
      cachePolicy: config.cachePolicy ?? 'CacheOrNetwork',
      partial: config.partial ?? false,
      keys: config.keys ?? {},
      defaultKeys: config.defaultKeys ?? ['id'],
      scalars: config.scalars ?? {},
      enabled: config.enabled ?? true,
      lifecycle: config.lifecycle ?? ((options) => new DefaultQueryLifecycle(options)),
      throwOnError: config.throwOnError ?? true,
      ...(persisted === undefined ? {} : { persistedQueries: persisted }),
    };
    Object.defineProperty(this, INTERNALS, {
      value: {
        requests: new RequestRegistry(),
        stack: new DisposalStack(),
        stores: new Set<DocumentStore>(),
        disposed: false,
      } satisfies ClientInternals,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  /** Monotonic counter bumped whenever a notification flush completes (the cache's counter). */
  get epoch(): number {
    return this.cache.epoch;
  }

  /** Constructs a store without sending anything (Houdini's `observe`). */
  observe<TData>(options: ObserveOptions<TData>): DocumentStore<TData> {
    assertAlive(this, 'observe');
    const store = new DocumentStore<TData>({
      client: this,
      artifact: options.artifact,
      plugins: pluginsFor(this, options.artifact.kind),
      ...(options.variables === undefined ? {} : { variables: options.variables }),
      ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
      ...(options.fetching === undefined ? {} : { fetching: options.fetching }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.reference === undefined ? {} : { reference: options.reference }),
    });
    retainStore(this, store);
    return store;
  }

  /** One-shot: observe, send, dispose. */
  async query<TData>(
    artifact: Artifact<'query', TData>,
    options: QueryOptions = {},
  ): Promise<QueryResult<TData>> {
    assertAlive(this, 'query');
    const lifecycle = lifecycleFor(this, artifact, options.variables);
    try {
      const result = await lifecycle.fetch(options.variables ?? {}, queryOptionsOf(options));
      if (options.signal?.aborted === true) {
        throw abortReasonOf(options.signal);
      }
      if (isClientDisposed(this)) {
        // a disposed client aborted this request: resolving would hand the caller a loading frame
        // it cannot tell apart from data (`review-slice34-adversarial.md` M6)
        throw new ClientDisposedError(
          'The client was disposed while this query was in flight (FLM4006).',
          { hint: 'keep one client per app (or per SSR request) alive for the whole request' },
        );
      }
      return result;
    } finally {
      lifecycle.dispose();
    }
  }

  /**
   * One-shot mutation: the optimistic layer is opened and resolved by the mutation plugin.
   *
   * `options.signal` (additive) is bridged into the request's `AbortController` exactly as
   * `Client.query` does, so an interrupt reaches the transport; the mutation plugin already treats
   * an aborted request as a failure and rolls the optimistic layer back. The pipeline records an
   * abort instead of failing, so the post-check below turns it into the rejection a caller that
   * passed a signal expects — without it an interrupted mutation would resolve as if it succeeded.
   */
  async mutate<TData>(
    artifact: Artifact<'mutation', TData>,
    options: MutationOptions,
  ): Promise<QueryResult<TData>> {
    assertAlive(this, 'mutate');
    const lifecycle = lifecycleFor(this, artifact, options.variables);
    try {
      const optimistic = options.optimistic;
      const result = await lifecycle.fetch(options.variables, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(optimistic === undefined ? {} : { sendOptions: { optimistic } }),
      });
      if (options.signal?.aborted === true) {
        throw abortReasonOf(options.signal);
      }
      return result;
    } finally {
      lifecycle.dispose();
    }
  }

  /**
   * Opens the subscription transport for a store and returns its close function (§8.6).
   *
   * With `handlers` the payload channel is live: `next` receives the store's masked result
   * immediately and after every payload or failure, `open` fires when the transport accepts and
   * `close` fires exactly once when it ends or the returned unsubscribe runs.
   */
  subscribe<TData>(
    artifact: Artifact<'subscription', TData>,
    options: QueryOptions,
    handlers: SubscriptionHandlers<TData>,
  ): () => void;
  subscribe<TData>(artifact: Artifact<'subscription', TData>, options?: QueryOptions): () => void;
  subscribe<TData>(
    artifact: Artifact<'subscription', TData>,
    options: QueryOptions = {},
    handlers?: SubscriptionHandlers<TData>,
  ): () => void {
    assertAlive(this, 'subscribe');
    const lifecycle = lifecycleFor(this, artifact, options.variables, handlers);
    const off = lifecycle.subscribe((result) => handlers?.next(result));
    void lifecycle.fetch(options.variables ?? {}, queryOptionsOf(options)).catch(() => {
      // a subscription transport failure is already in the store's errors
    });
    let closed = false;
    return () => {
      if (closed) {
        return;
      }
      closed = true;
      off();
      lifecycle.dispose();
    };
  }

  /** Masked read plus a subscription at fragment granularity. */
  readFragment<TData, TKey>(
    artifact: Artifact<'fragment', TData, unknown, TKey>,
    reference: FragmentReference | null | undefined,
  ): QueryResult<TData> {
    assertAlive(this, 'readFragment');
    this.cache.registerFragment(artifact.name, artifact.selection);
    if (reference === null || reference === undefined || !isFragmentRef(reference)) {
      if (reference !== null && reference !== undefined) {
        devWarn(
          `The reference for fragment "${artifact.name}" is not a { parent, variables } payload (FLM4002).`,
          'read the fragment through the ` $fragments` entry the parent result carries',
        );
      }
      return emptyResult<TData>(null);
    }
    const read = readDocument<TData>(this.cache, artifact, reference.variables, {
      parent: reference.parent,
    });
    return freezeResult<TData>({
      data: read.data,
      errors: null,
      fetching: false,
      partial: reportPartial(read.partial, artifact.partial ?? this.config.partial),
      stale: read.stale,
      source: 'cache',
      variables: reference.variables,
      extensions: null,
      hasNext: false,
      deferred: NO_DEFERRED,
    });
  }

  /** The subscription form of `readFragment`: one listener per cache update of the parent. */
  subscribeFragment<TData, TKey>(
    artifact: Artifact<'fragment', TData, unknown, TKey>,
    reference: FragmentReference,
    listener: (result: QueryResult<TData>) => void,
  ): () => void {
    assertAlive(this, 'subscribeFragment');
    const read = (): void => listener(this.readFragment(artifact, reference));
    read();
    return this.cache.subscribe({
      key: `${reference.parent}::${artifact.hash}`,
      rootType: artifact.rootType,
      selection: artifact.selection,
      parentID: reference.parent,
      variables: () => reference.variables,
      onMessage: () => read(),
    });
  }

  /** The masked cache read of a document, as a `QueryResult` a composable can seed from. */
  readQuery<TData>(artifact: Artifact<'query', TData>, variables: Variables): QueryResult<TData> {
    assertAlive(this, 'readQuery');
    const resolved = marshalInputs(artifact, variables);
    const read = readDocument<TData>(this.cache, artifact, resolved);
    return freezeResult<TData>({
      data: read.data,
      errors: null,
      fetching: false,
      partial: reportPartial(read.partial, artifact.partial ?? this.config.partial),
      stale: read.stale,
      source: 'cache',
      variables: resolved,
      extensions: null,
      hasNext: false,
      deferred: NO_DEFERRED,
    });
  }

  /** The unmasked connection snapshot of an artifact's paginated field (§6.8). */
  readConnection<TData>(
    artifact: Artifact<'query', TData>,
    variables: Variables,
  ): ConnectionSnapshot {
    assertAlive(this, 'readConnection');
    const resolved = marshalInputs(artifact, variables);
    return (
      this.cache.connection(artifact, resolved) ?? {
        path: artifact.refetch?.path ?? [],
        ids: [],
        edges: [],
        pageInfo: { ...NULL_PAGE_INFO },
        complete: false,
      }
    );
  }

  /** Fetches the next page into the cache; `cursorHandlers` owns the cursor arithmetic (§6.8). */
  fetchNextPage(artifact: Artifact, variables: Variables): Promise<void> {
    return fetchPage(this, artifact, variables, 'forward');
  }

  /** Fetches the previous page into the cache (§6.8). */
  fetchPreviousPage(artifact: Artifact, variables: Variables): Promise<void> {
    return fetchPage(this, artifact, variables, 'backward');
  }

  /**
   * Fetches one page of a **paginated fragment** through its companion document (§6.8, §7.3).
   *
   * `companion` is the query artifact the compiler generates for the fragment
   * (`<Name>_Pagination_Query`): the fragment's fields inlined into a query rooted at the fragment's
   * owner type. The owner's key fields are read off `reference.parent` and layered **under** the
   * fragment's own variables and the page's cursor variables, exactly as Houdini's
   * `pagination.ts:62-109` builds them, so `user(id: $id)` resolves to the record the fragment is
   * reading. The request then goes through the same {@link fetchPage} path a query page does:
   * `Infinite` pagination is `NetworkOnly`, the artifact's own policy applies otherwise, the merge
   * direction follows the page direction and `cacheParams.disableSubscriptions` keeps the write from
   * committing anyone's document state.
   *
   * A reference that is a pending loading frame has no owner record to read yet, and a companion
   * that is not a query has no page to fetch: both are no-ops.
   *
   * The page lands on the owner record because the companion's inlined fragment selection keeps the
   * fragment's own `::paginated` field key and its `updates: ['append']` metadata.
   */
  async fetchFragmentPage(
    companion: Artifact,
    reference: FragmentReference,
    direction: 'forward' | 'backward',
    pageVariables: Variables,
  ): Promise<void> {
    assertAlive(this, 'fetchFragmentPage');
    if (isPending(reference) || companion.kind !== 'query') {
      return;
    }
    const refetch = companion.refetch;
    if (refetch === undefined) {
      devWarn(
        `A page request was made for "${companion.name}", which has no @paginate field (FLM4004).`,
        'add @paginate(mode: Infinite) to the connection field the fragment reads',
      );
      return;
    }

    const variables: Record<string, unknown> = {
      ...companion.input?.defaults,
      ...entityVariables(this, reference, refetch.targetType),
      ...reference.variables,
      ...pageVariables,
    };
    return fetchPage(this, companion, variables, direction, 'fetchFragmentPage');
  }

  /** The one wire format (§6.10). */
  serialize(): SerializedCache {
    assertAlive(this, 'serialize');
    return this.cache.serialize();
  }

  /**
   * The changes since the previous call, for a consumer that already holds the snapshot (§6.10).
   *
   * `{ full: true }` carries the whole snapshot (the cache was hydrated or reset); otherwise the
   * delta names exactly the records, lists and pages that changed. Drain semantics: one change is
   * reported once.
   */
  serializeChanges(): SerializedChanges {
    assertAlive(this, 'serializeChanges');
    return this.cache.serializeChanges();
  }

  /** `true` when {@link Client.serializeChanges} would report anything, without draining it. */
  hasSerializedChanges(): boolean {
    assertAlive(this, 'hasSerializedChanges');
    return this.cache.hasSerializedChanges();
  }

  /** Replaces the cache with a serialized snapshot; a malformed one is ignored with FLM4005. */
  hydrate(snapshot: SerializedCache): void {
    assertAlive(this, 'hydrate');
    this.cache.hydrate(snapshot);
  }

  /**
   * Fills the cache from a serialized snapshot without replacing what it already holds (§6.10).
   *
   * The records, links, lists and pages the cache already carries win; the snapshot supplies only
   * what is missing. A durable local snapshot is restored this way (`LocalFirst.restore`), so the
   * fresh payload hydrated into the same client outranks a device's older copy of those records.
   * A malformed or foreign snapshot is refused with FLM4005, leaving the cache untouched.
   */
  hydrateMissing(snapshot: SerializedCache): void {
    assertAlive(this, 'hydrateMissing');
    this.cache.hydrateMissing(snapshot);
  }

  /** Deliver coalesced notifications now instead of on the next microtask. */
  flushNow(): void {
    this.cache.flush();
  }

  /** Register a disposable that outlives no component (detached composable use). */
  retain(disposable: { dispose(): void }): void {
    internalsOf(this, 'retain').stack.push(() => disposable.dispose());
  }

  /** Aborts every request, tears every store down, runs the stack LIFO and empties the cache. */
  dispose(): void {
    const internals = internalsOf(this, 'dispose');
    if (internals.disposed) {
      return;
    }
    internals.disposed = true;
    for (const store of Array.from(internals.stores)) {
      store.cleanup();
    }
    internals.stores.clear();
    internals.requests.abortAll();
    let failure: unknown;
    try {
      internals.stack.dispose();
    } catch (error) {
      failure = error;
    } finally {
      this.cache.dispose();
    }
    if (failure !== undefined) {
      throw failure;
    }
  }
}

/** The constructor function equivalent; this is what the Vue plugin calls. */
export function createClient(config: ClientConfig): Client {
  return new Client(config);
}

/** `persistedQueries` normalized to the resolved shape; `false`/absent means off. */
function resolvePersistedQueries(
  config: PersistedQueryConfig | undefined,
): ResolvedPersistedQueryConfig | undefined {
  if (config === undefined || config === false) {
    return undefined;
  }
  if (config === true) {
    return { mode: 'apq', retryOnNotFound: true };
  }
  return { mode: 'apq', retryOnNotFound: config.retryOnNotFound ?? true };
}

export interface ObserveOptions<TData> {
  readonly artifact: Artifact<ArtifactKind, TData>;
  readonly variables?: Variables;
  readonly initialValue?: TData | null;
  readonly fetching?: boolean;
  readonly policy?: CachePolicy;
  /** The fragment reference a fragment store reads through (§5.3, additive). */
  readonly reference?: FragmentReference;
}

export interface QueryOptions {
  readonly variables?: Variables;
  readonly policy?: CachePolicy;
  /** Skip the forward pass: install state and subscriptions without a request. */
  readonly setup?: boolean;
  /** Bridged into the request's `AbortController` (used by the router adapter). */
  readonly signal?: AbortSignal;
  readonly fetch?: TransportFn;
  /**
   * Observe the first payload of the response this read uses (§7.13, additive).
   *
   * A `@defer`/`@stream` response is several payloads on one request: this read's own when it leads,
   * the leader's when it joins an identical in-flight one. The hook runs with that request's result
   * (`hasNext: true`, every declared target `pending`) while the remaining patches are still on
   * the wire, which is what a route loader settles its navigation on (`@flamme/router`'s
   * `queryLoader`). The read itself still settles with the whole response, so a caller that awaits
   * it sees the last patch like any other read.
   */
  readonly onFirstPayload?: (result: QueryResult) => void;
  /** The store-level §5.3 send fields `DocumentStore.send` forwards (additive). */
  readonly sendOptions?: {
    readonly silenceEcho?: boolean;
    readonly cacheParams?: {
      readonly disableSubscriptions?: boolean;
      readonly applyUpdates?: readonly ('append' | 'prepend')[];
    };
    readonly optimistic?: Readonly<Record<string, unknown>>;
  };
}

export interface MutationOptions {
  readonly variables: Variables;
  /** Applied as an optimistic layer before the request and rolled back on error. */
  readonly optimistic?: Readonly<Record<string, unknown>>;
  /**
   * Bridged into the request's `AbortController`, like `QueryOptions.signal`: an aborted mutation
   * rejects with the abort reason, the transport sees the abort and the optimistic layer is rolled
   * back (additive; existing callers are unaffected).
   */
  readonly signal?: AbortSignal;
}

/* ------------------------------------------------------------------- the client's own state */

const INTERNALS: unique symbol = Symbol('flamme.client');

interface ClientInternals {
  readonly requests: RequestRegistry;
  readonly stack: DisposalStack;
  readonly stores: Set<DocumentStore>;
  disposed: boolean;
}

/** The symbol-keyed internals of a client (never part of the declared `Client` surface). */
function internalsOf(client: Client, member: string): ClientInternals {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the symbol key is private to this module
  const carrier = client as unknown as Record<symbol, ClientInternals | undefined>;
  const internals = carrier[INTERNALS];
  if (internals === undefined) {
    throw new Error(
      `Client.${member} needs a client built by createClient (or new Client); this object is a double.`,
    );
  }
  return internals;
}

/** `true` when `client.dispose()` has run and every further store call must throw FLM4006. */
export function isClientDisposed(client: Client): boolean {
  return internalsOf(client, 'disposed').disposed;
}

/** The client's in-flight request table; the lifecycle dedupes through it (§5.6). */
export function clientRequests(client: Client): RequestRegistry {
  return internalsOf(client, 'requests').requests;
}

/** Registers a live store so `dispose()` can tear it down. */
export function retainStore(client: Client, store: DocumentStore): void {
  internalsOf(client, 'retainStore').stores.add(store);
}

/** Removes a store that cleaned itself up from the teardown set. */
export function releaseStore(client: Client, store: DocumentStore): void {
  internalsOf(client, 'releaseStore').stores.delete(store);
}

/** The default plugin list for one artifact kind, with this client's user plugins (§5.2). */
export function pluginsFor(client: Client, kind: ArtifactKind): readonly ClientPlugin[] {
  return defaultPlugins(kind, {
    userPlugins: client.config.plugins,
    throwOnError: client.config.throwOnError ?? true,
  });
}

function assertAlive(client: Client, member: string): void {
  if (isClientDisposed(client)) {
    throw new ClientDisposedError(
      `Client.${member} was called on a client that has been disposed (FLM4006).`,
      { hint: 'create one client per app (or per SSR request) and keep it alive for that request' },
    );
  }
}

/** The lifecycle one one-shot call or page request runs on. */
function lifecycleFor<TData>(
  client: Client,
  artifact: Artifact<ArtifactKind, TData>,
  variables: Variables | undefined,
  hooks?: { readonly open?: () => void; readonly close?: () => void },
): QueryLifecycle<TData> {
  return client.config.lifecycle({
    client,
    artifact,
    plugins: pluginsFor(client, artifact.kind),
    requests: clientRequests(client),
    ...(variables === undefined ? {} : { variables }),
    ...(hooks?.open === undefined ? {} : { onSubscriptionOpen: hooks.open }),
    ...(hooks?.close === undefined ? {} : { onSubscriptionClose: hooks.close }),
  });
}

/** Fetches one page and writes it into the cache; the caller adopts it (§6.8). */
async function fetchPage(
  client: Client,
  artifact: Artifact,
  variables: Variables,
  direction: 'forward' | 'backward',
  member?: string,
): Promise<void> {
  assertAlive(client, member ?? (direction === 'forward' ? 'fetchNextPage' : 'fetchPreviousPage'));
  const refetch = artifact.refetch;
  if (refetch === undefined) {
    devWarn(
      `A page request was made for "${artifact.name}", which has no @paginate field (FLM4004).`,
      'add @paginate(mode: SinglePage) to the connection field the document reads',
    );
    return;
  }
  const mode = refetch.mode;
  const policy: CachePolicy =
    mode === 'Infinite' ? 'NetworkOnly' : (artifact.policy ?? client.config.cachePolicy);
  // A SinglePage page replaces its window, so it never merges; an Infinite offset page always
  // appends, because the pages are the field's own array entries whatever direction the caller
  // asked for (`selection.go:1373-1394`); an Infinite cursor page follows the direction.
  const applyUpdates: readonly ('append' | 'prepend')[] =
    mode !== 'Infinite'
      ? []
      : refetch.method === 'offset'
        ? ['append']
        : [direction === 'forward' ? 'append' : 'prepend'];
  const lifecycle = lifecycleFor(client, artifact, variables);
  try {
    await lifecycle.fetch(variables, {
      policy,
      sendOptions: {
        cacheParams: {
          disableSubscriptions: true,
          ...(applyUpdates.length === 0 ? {} : { applyUpdates }),
        },
      },
    });
  } finally {
    lifecycle.dispose();
  }
}

/**
 * The fragment owner's key fields, read off the record the reference points at (§6.8).
 *
 * A key the record holds no value for is skipped rather than sent as `undefined`: the request would
 * otherwise carry a key the write never produced. Houdini reads the same fields off
 * `reference.parent` in `pagination.ts:62-109`.
 */
function entityVariables(
  client: Client,
  reference: FragmentReference,
  targetType: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keyFieldsForType(client.cache.config, targetType)) {
    const resolved = client.cache.storage.resolve(reference.parent, key);
    if (!resolved.found || resolved.value === undefined || resolved.value === null) {
      continue;
    }
    out[key] = resolved.value;
  }
  return out;
}

/** The `QueryOptions` a one-shot call builds from its own options. */
function queryOptionsOf(options: QueryOptions): QueryOptions {
  return {
    ...(options.variables === undefined ? {} : { variables: options.variables }),
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.setup === true ? { setup: true } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.onFirstPayload === undefined ? {} : { onFirstPayload: options.onFirstPayload }),
    ...(options.sendOptions === undefined ? {} : { sendOptions: options.sendOptions }),
  };
}

/** The abort reason of a signal, or a fresh `AbortError`. */
function abortReasonOf(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  if (reason !== undefined) {
    return reason;
  }
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** A result for a fragment with no reference (or an absent fragment spread): no data, no errors. */
function emptyResult<TData>(variables: Variables | null): QueryResult<TData> {
  return freezeResult<TData>({
    data: null,
    errors: null,
    fetching: false,
    partial: false,
    stale: false,
    source: null,
    variables,
    extensions: null,
    hasNext: false,
    deferred: NO_DEFERRED,
  });
}

/** Freezes a result once; nested data is frozen by the cache's read. */
function freezeResult<TData>(value: QueryResult<TData>): QueryResult<TData> {
  return Object.isFrozen(value) ? value : Object.freeze(value);
}
