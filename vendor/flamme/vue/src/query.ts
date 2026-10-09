/**
 * `useQuery` (§8.3).
 *
 * One `shallowRef` for the store's snapshot, seeded synchronously from the cache read at setup so SSR
 * and the first client render see the same values, plus `computed` selectors the template reads.
 * The pagination surface lives here and nowhere else; a page request runs through the runtime's
 * `cursorHandlers` (§6.8), which owns the cursor arithmetic, the page-cache hit test and the
 * arrow predicates, and never flips `fetching`.
 */
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type ShallowRef,
} from 'vue';
import {
  cursorHandlers,
  marshalInputs,
  offsetHandlers,
  type Artifact,
  type DeferredState,
  type ArtifactData,
  type ArtifactInput,
  type CachePolicy,
  type ConnectionSnapshot,
  type DataSource,
  type DocumentStore,
  type GraphQLResponseError,
  type PageInfo,
  type QueryResult,
  type Variables,
} from '@flamme/runtime';

import { useFlamme } from './client.js';
import { warnOnce } from './dev.js';
import { isVariables, sameVariables } from './keys.js';
import { acquireStore, releaseStore, type StoreEntry } from './stores.js';

/** The reactive query handle of §8.3. */
export interface QueryHandle<TData> {
  /** The result's data, including the loading branch of a `@loading` selection. */
  readonly data: ShallowRef<TData | null>;
  /** The GraphQL errors of the last response, or `null`. */
  readonly errors: ShallowRef<readonly GraphQLResponseError[] | null>;
  /** A request is in flight for the current variables. */
  readonly fetching: ComputedRef<boolean>;
  /** Some selected fields are absent from the cache. */
  readonly partial: ComputedRef<boolean>;
  /** The data is present but known to be out of date. */
  readonly stale: ComputedRef<boolean>;
  /** Incremental delivery: the transport still has `@defer`/`@stream` patches to deliver (§7.13). */
  readonly hasNext: ComputedRef<boolean>;
  /** Per-label delivery state of this document's `@defer`/`@stream` targets (§7.13). */
  readonly deferred: ComputedRef<DeferredState>;
  /** Where the current data came from. */
  readonly source: ComputedRef<DataSource | null>;
  /** The variables the handle is currently using. */
  readonly variables: ShallowRef<Variables | null>;
  /**
   * The paginated connection's `pageInfo`, or `null` when the artifact has no `refetch` spec.
   *
   * **Cursor pagination only.** An offset-paginated list has no cursors and no `pageInfo`
   * (Houdini never computes one), so the property is absent from that handle rather than reported as
   * an all-false page that keeps an arrow live.
   */
  readonly pageInfo?: ComputedRef<PageInfo | null>;
  /** The unmasked connection snapshot behind {@link QueryHandle.pageInfo}; cursor pagination only. */
  readonly connection?: ComputedRef<ConnectionSnapshot | null>;
  /** `pageInfo.hasNextPage`; cursor pagination only. */
  readonly hasNextPage?: ComputedRef<boolean>;
  /** `pageInfo.hasPreviousPage`; cursor pagination only. */
  readonly hasPreviousPage?: ComputedRef<boolean>;
  /** A next-page request is in flight. */
  readonly loadingNextPage: ComputedRef<boolean>;
  /** A previous-page request is in flight; cursor pagination only. */
  readonly loadingPreviousPage?: ComputedRef<boolean>;
  /** Fetches and merges the next page. */
  loadNextPage(): Promise<void>;
  /** Fetches and merges the previous page; cursor pagination only. */
  loadPreviousPage?(): Promise<void>;
  /** Re-sends with `NetworkOnly` and replaces the data. */
  refetch(): Promise<void>;
  /** The shared store behind this handle (advanced). */
  readonly store: DocumentStore<TData>;
  /**
   * Resolves once the request this handle started has settled (it never starts one).
   *
   * The awaited SSR read (§8.11) needs the data before `setup` returns: `useQuery` has already sent
   * by then, so this joins that request through the §5.6 in-flight table rather than issuing a
   * second one. A handle that sent nothing (disabled, `fetchOnMount: false`) resolves immediately,
   * and a failed request resolves too: the failure is on `errors`, which is what a render shows.
   *
   * Optional because a handle need not own a request: every handle `useQuery` builds implements it,
   * while a route query handle (which always has a loader) has nothing to await.
   */
  settled?(): Promise<void>;
}

/** The `useQuery` options of §8.3. */
export interface UseQueryOptions {
  /** Cache policy for the requests this handle makes. */
  readonly policy?: CachePolicy;
  /** `false` pauses the query without unsubscribing (the data stays). */
  readonly enabled?: MaybeRefOrGetter<boolean>;
  /** Default `true`; `false` defers the first request to `refetch()`. */
  readonly fetchOnMount?: boolean;
  /** Keep the previous data visible while a variable change is in flight. Default `true`. */
  readonly keepPreviousData?: boolean;
}

/** Reads the resolved variables of a `MaybeRefOrGetter`, or `null` when none were given. */
function readVariables<A extends Artifact<'query'>>(
  variables: MaybeRefOrGetter<ArtifactInput<A>> | undefined,
): Variables | null {
  if (variables === undefined) {
    return null;
  }
  const value: unknown = toValue(variables);
  return isVariables(value) ? value : null;
}

/** The `DocumentStore` behind a query handle, shared per `(artifact, variables)` (§8.3). */
export function useQuery<A extends Artifact<'query'>>(
  artifact: A,
  variables?: MaybeRefOrGetter<ArtifactInput<A>>,
  options?: UseQueryOptions,
): QueryHandle<ArtifactData<A>> {
  type TData = ArtifactData<A>;

  const client = useFlamme();
  const fetchOnMount = options?.fetchOnMount ?? true;
  const keepPreviousData = options?.keepPreviousData ?? true;
  const resolvedVariables = readVariables(variables);
  // The generated artifact is `Artifact<'query', TData>`; the generic `A` only guarantees the
  // constraint, so the document is re-typed once at this boundary (the same narrowing the generated
  // module performs with `const document: Info = artifact as unknown as Info`, §3.1).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the phantom carriers are not reachable through the constraint, so the document is re-typed once here (the generated module performs the same narrow)
  const document = artifact as Artifact<'query', TData>;

  const initialVariables: Variables = resolvedVariables ?? {};
  const seed = client.readQuery<TData>(document, initialVariables);
  let entry: StoreEntry<TData> = acquireStore(client, document, initialVariables, seed.data);

  const result = shallowRef<QueryResult<TData>>(entry.store.state);
  // seeded in two steps: `shallowRef` cannot pick an overload for a deferred conditional type
  const data: ShallowRef<TData | null> = shallowRef<TData | null>(null);
  data.value = seed.data;
  const errors = shallowRef<readonly GraphQLResponseError[] | null>(seed.errors);
  const variablesRef = shallowRef<Variables | null>(resolvedVariables);
  const loadingNext = shallowRef(false);
  const loadingPrevious = shallowRef(false);
  /** The request the automatic send started, so an awaited SSR read can join it (§8.11). */
  let inFlight: Promise<unknown> | null = null;
  let hasFetched = false;
  /** The data on screen when the variables changed, kept there until the new store settles. */
  let switchedFrom: TData | null = null;

  /** The one place a new snapshot reaches the refs, with the `keepPreviousData` rule. */
  function apply(next: QueryResult<TData>): void {
    result.value = next;
    errors.value = next.errors;
    // a variable change is in flight: the previous panel stays until the new one has data (§8.3)
    if (keepPreviousData && switchedFrom !== null && next.fetching && next.errors === null) {
      return;
    }
    switchedFrom = null;
    data.value = next.data;
  }

  function subscribeCurrent(): () => void {
    return entry.store.subscribe(apply);
  }

  let unsubscribe: () => void = subscribeCurrent();

  function enabled(): boolean {
    return options?.enabled === undefined ? true : toValue(options.enabled);
  }

  /** Fires the store's request, swallowing the rejection: failures surface through `errors`. */
  function sendInBackground(target: StoreEntry<TData>, policy?: CachePolicy): void {
    hasFetched = true;
    target.started = true;
    const request = target.store.send({
      variables: variablesRef.value ?? {},
      ...(policy === undefined ? {} : { policy }),
    });
    inFlight = request.then(
      () => undefined,
      () => undefined,
    );
  }

  /** The automatic send: once per store, gated by `enabled` and by `fetchOnMount` on first mount. */
  function startIfNeeded(): void {
    if (entry.started || !enabled()) {
      return;
    }
    if (!fetchOnMount && !hasFetched) {
      return;
    }
    sendInBackground(entry, options?.policy);
  }

  /** Re-points the handle at the store for the new variables, keeping the old data on screen. */
  function switchVariables(next: Variables | null): void {
    const vars = next ?? {};
    if (variablesRef.value !== null && sameVariables(variablesRef.value, vars)) {
      return;
    }
    variablesRef.value = next;
    switchedFrom = keepPreviousData ? data.value : null;
    const previous = entry;
    unsubscribe();
    const nextSeed = client.readQuery<TData>(document, vars);
    entry = acquireStore(client, document, vars, nextSeed.data);
    unsubscribe = subscribeCurrent();
    startIfNeeded();
    releaseStore(client, previous);
  }

  const stopVariables = watch(() => (variables === undefined ? null : readVariables(variables)), switchVariables, {
    flush: 'pre',
  });
  const stopEnabled = watch(
    () => enabled(),
    (on) => {
      if (on) {
        startIfNeeded();
      }
    },
    { flush: 'pre' },
  );

  startIfNeeded();

  function dispose(): void {
    stopVariables();
    stopEnabled();
    unsubscribe();
    releaseStore(client, entry);
  }

  // `getCurrentScope()` is `undefined` (not `null`) outside a scope, so the check is truthiness
  if (getCurrentScope()) {
    onScopeDispose(dispose);
  } else {
    client.retain({ dispose });
    warnOnce(
      'detached-use',
      'useQuery() was called outside a component scope (a plain function, a test or a route loader); ' +
        'the query is retained by the client and disposed with it (D6, §8.10).',
    );
  }

  // The pagination surface is the runtime's page helpers (§6.8): the cursor arithmetic, the
  // page-cache hit test and the "is this arrow usable?" test all live there. `useQuery` supplies the
  // variables and the reactive reads, and never re-implements a cursor rule (§8.3).
  //
  // The **method** the compiler computed decides the surface, exactly as Houdini's handles do: a
  // cursor connection gets `pageInfo` and both arrows, an offset list gets `loadNextPage` and
  // nothing cursor-shaped.
  const method = artifact.refetch?.method ?? 'cursor';
  const pages = cursorHandlers(document, client);
  const offsets = offsetHandlers(document, client);
  const connection = computed<ConnectionSnapshot | null>(() => {
    // the cache is not reactive (D6), so the one reactive dependency a connection read has is the
    // store's own snapshot: reading it here re-runs this computation exactly when the page that is
    // on screen changes, and never when an unrelated record does
    void data.value;
    return artifact.refetch === undefined || variablesRef.value === null
      ? null
      : client.readConnection<TData>(document, variablesRef.value);
  });
  const pageInfo = computed<PageInfo | null>(() => {
    const snapshot = connection.value;
    if (snapshot === null) {
      return null;
    }
    const info = snapshot.pageInfo;
    // A server that reports `hasNextPage: true` with a `null` `endCursor` would otherwise leave the
    // arrow enabled forever: every click re-requests the page the document already has, because
    // there is no cursor to build the next request from
    // (`review-slice34-adversarial.md` M7). The arrow reports what pagination can actually do.
    return {
      ...info,
      hasNextPage: info.hasNextPage && info.endCursor !== null,
      hasPreviousPage: info.hasPreviousPage && info.startCursor !== null,
    };
  });

  /** Runs one imperative page load with its own in-flight flag; the handle's `fetching` never flips. */
  async function loadPage(
    direction: 'forward' | 'backward',
    loading: ShallowRef<boolean>,
  ): Promise<void> {
    loading.value = true;
    try {
      // the connection is read *outside* the loading flag's first render so the arrows reflect the
      // page that is on screen now, not the one the click is about to fetch
      if (variablesRef.value !== null) {
        // The page helpers evaluate field keys from the variables they are given, and the cache
        // stored them from the *marshalled* request variables (document defaults such as
        // `$first: Int = 1` included). Passing the display variables unmarshalled evaluates a
        // different key, `buildConnection` finds nothing, and every page load silently no-ops
        // (`client.readConnection` marshals for the same reason).
        const pageVariables = marshalInputs(document, variablesRef.value);
        await (direction === 'forward'
          ? pages.loadNextPage(pageVariables)
          : pages.loadPreviousPage(pageVariables));
      }
    } finally {
      loading.value = false;
    }
  }

  /** The offset page load: `limit`/`offset` variables, no direction. */
  async function loadOffsetPage(loading: ShallowRef<boolean>): Promise<void> {
    loading.value = true;
    try {
      if (variablesRef.value !== null) {
        await offsets.loadNextPage(marshalInputs(document, variablesRef.value));
      }
    } finally {
      loading.value = false;
    }
  }

  const cursorSurface =
    method === 'offset'
      ? {}
      : {
          connection,
          pageInfo,
          hasNextPage: computed(() => pageInfo.value?.hasNextPage ?? false),
          hasPreviousPage: computed(() => pageInfo.value?.hasPreviousPage ?? false),
          loadingPreviousPage: computed(() => loadingPrevious.value),
          loadPreviousPage: async (): Promise<void> => {
            await loadPage('backward', loadingPrevious);
          },
        };

  return {
    data,
    errors,
    fetching: computed(() => result.value.fetching),
    partial: computed(() => result.value.partial),
    stale: computed(() => result.value.stale),
    hasNext: computed(() => result.value.hasNext),
    deferred: computed(() => result.value.deferred),
    source: computed(() => result.value.source),
    variables: variablesRef,
    ...cursorSurface,
    loadingNextPage: computed(() => loadingNext.value),
    async loadNextPage(): Promise<void> {
      if (method === 'offset') {
        await loadOffsetPage(loadingNext);
      } else {
        await loadPage('forward', loadingNext);
      }
    },
    async refetch(): Promise<void> {
      hasFetched = true;
      entry.started = true;
      await entry.store.send({ variables: variablesRef.value ?? {}, policy: 'NetworkOnly' });
    },
    get store(): DocumentStore<TData> {
      return entry.store;
    },
    async settled(): Promise<void> {
      await inFlight;
    },
  };
}
