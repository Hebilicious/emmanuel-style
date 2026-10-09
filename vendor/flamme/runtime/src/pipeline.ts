/**
 * The plugin pipeline (§5.2, D5).
 *
 * Five stages in a forward pass (`start`, `beforeNetwork`, `network`) and a backward pass
 * (`afterNetwork`, `end`); `setup: true` skips the forward pass entirely. `cleanup` is a hook, never
 * a stage. `runPipeline` is the runner; the seven default plugins live under `./plugins/**`.
 */
import type {
  Artifact,
  ArtifactKind,
  CachePolicy,
  DeferredState,
  FragmentReference,
  Variables,
} from './artifact.js';
import type { Cache, CacheLayer } from './cache.js';
import { NO_DEFERRED } from './incremental.js';
import type { Client, TransportFn, TransportResponse } from './client.js';
import type { OptimisticKeySite } from './optimistic.js';
// the runner is generic over the store's data; nothing here narrows it
import type { QueryResult } from './result.js';

export type PipelineStage = 'start' | 'beforeNetwork' | 'network' | 'afterNetwork' | 'end';

export interface RequestContext<TData = unknown> {
  readonly client: Client;
  readonly cache: Cache;
  readonly artifact: Artifact<ArtifactKind, TData>;
  readonly variables: Variables;
  readonly policy: CachePolicy;
  readonly signal: AbortSignal;
  /** Monotonic per store; a plugin that sees a different id has been superseded. */
  readonly requestId: number;
  /** The request was created with `setup: true`. */
  readonly setup: boolean;
  /** Suppress a write when the new data is identical to the previous data. */
  readonly silenceEcho: boolean;
  /** The optimistic layer currently open for this request, if any. */
  readonly layer: CacheLayer | null;
  readonly result: QueryResult<TData>;
  /** Merge a partial result into the store and notify subscribers. */
  commit(patch: Partial<QueryResult<TData>>): void;
  /** Perform the transport call (only meaningful inside `network`). */
  fetchNetwork(): Promise<TransportResponse>;
}

export interface ClientPlugin {
  readonly name: string;
  start?(ctx: RequestContext): void | Promise<void>;
  beforeNetwork?(ctx: RequestContext): void | Promise<void>;
  network?(ctx: RequestContext): void | Promise<void>;
  afterNetwork?(ctx: RequestContext): void | Promise<void>;
  end?(ctx: RequestContext): void | Promise<void>;
  /** Called when the last subscriber leaves, or on `client.dispose()`. */
  cleanup?(ctx: RequestContext): void;
}

/* ------------------------------------------------------------------- the runner (§5.2, additive) */

/**
 * The mutable per-request state the seven default plugins share. It hangs off the context under
 * {@link REQUEST_STATE}, so no plugin needs module-level state and two concurrent requests cannot
 * see each other's fields.
 */
export interface RequestState<TData = unknown> {
  /** The variables the request was sent with (for a page request: the page's cursor variables). */
  readonly requestVariables: Variables;
  /** The store's own variables; what a commit read and a cache subscription use. */
  readonly storeVariables: Variables;
  /** `cacheParams.disableSubscriptions`: a page request writes but never commits cache data. */
  readonly pageRequest: boolean;
  readonly pageUpdates: readonly ('append' | 'prepend')[];
  readonly setup: boolean;
  readonly silenceEcho: boolean;
  readonly optimistic: Readonly<Record<string, unknown>> | undefined;
  /** A per-request transport override (`QueryOptions.fetch`). */
  readonly fetcher: TransportFn | undefined;
  /** The fragment reference a fragment store reads through, when it was given one. */
  readonly reference: FragmentReference | null;
  /** The optimistic layer open for this request (mutations only). */
  layer: CacheLayer | null;
  /** The `@optimisticKey` sites the optimistic payload stamped, for the remap on confirmation (§7.14). */
  optimisticKeySites: readonly OptimisticKeySite[];
  /** The store's data before this request, so a rollback restores it rather than re-reading. */
  beforeData: TData | null | undefined;
  /** The last masked cache read, for the loading-frame decision. */
  read: { readonly partial: boolean; readonly stale: boolean; readonly hasData: boolean } | null;
  /** The incremental-delivery state of every `@defer`/`@stream` target (§7.13). */
  deferred: DeferredState;
  response: TransportResponse | null;
  /** The policy resolved this request to a transport call. */
  shouldFetch: boolean;
  fetched: boolean;
  /** A classified transport failure (a `FlammeRuntimeError`), or `undefined`. */
  error: unknown;
  aborted: boolean;
  abortReason: unknown;
  /** The open subscription transport's close function, if any. */
  closeSubscription: (() => void) | null;
  /** Installs (and replaces) the store's cache subscription (§5.2 `queryPlugin.end`). */
  readonly installSubscription: (dispose: () => void) => void;
  /** Commit from outside a request; used by the cache subscription of a query or fragment store. */
  readonly commitBackground: (patch: Partial<QueryResult<TData>>) => void;
  /** Re-sends this store with another policy (`kind: 'refetch'` cache messages). */
  readonly resend: (policy: CachePolicy) => void;
  /** Called on the first payload of a subscription transport (additive, `Client.subscribe`). */
  readonly onSubscriptionOpen: (() => void) | undefined;
  /** `true` once the open hook has fired, so it never fires twice for one request (additive). */
  subscriptionOpened: boolean;
  /** Called once when a subscription transport completes, fails, or is torn down (additive). */
  readonly onSubscriptionClose: (() => void) | undefined;
  /** `true` once the close hook has fired, so it never fires twice for one request (additive). */
  subscriptionClosed: boolean;
}

/** The symbol the request state is stored under; `Symbol.for` keeps two copies agreeing. */
export const REQUEST_STATE: unique symbol = Symbol.for('flamme.requestState');

export interface RequestContextInit<TData = unknown> {
  readonly client: Client;
  readonly cache: Cache;
  readonly artifact: Artifact<ArtifactKind, TData>;
  readonly variables: Variables;
  readonly storeVariables: Variables;
  readonly policy: CachePolicy;
  readonly signal: AbortSignal;
  readonly requestId: number;
  readonly setup: boolean;
  readonly silenceEcho: boolean;
  readonly pageRequest: boolean;
  readonly pageUpdates: readonly ('append' | 'prepend')[];
  readonly optimistic?: Readonly<Record<string, unknown>>;
  readonly fetcher?: TransportFn;
  readonly reference?: FragmentReference;
  /** Merge a partial result into the store and notify subscribers. */
  readonly commit: (patch: Partial<QueryResult<TData>>) => void;
  /** Merge a result that is not tied to one request (a cache subscription message). */
  readonly commitBackground: (patch: Partial<QueryResult<TData>>) => void;
  /** Perform the transport call. */
  readonly fetchNetwork: () => Promise<TransportResponse>;
  /** The store's cache-subscription slot; installing replaces (and disposes) the previous one. */
  readonly installSubscription: (dispose: () => void) => void;
  /** The store's current result, so `ctx.result` is live rather than a snapshot. */
  readonly currentResult: () => QueryResult<TData>;
  /** Re-send this store with another policy. */
  readonly resend: (policy: CachePolicy) => void;
  /** The `Client.subscribe` payload channel's open hook (additive). */
  readonly onSubscriptionOpen?: () => void;
  /** The `Client.subscribe` payload channel's close hook (additive). */
  readonly onSubscriptionClose?: () => void;
}

/**
 * Builds the frozen-shape `RequestContext` the plugins receive, with `layer` and `result` as live
 * getters so a plugin that reads them after a commit sees the request's current values.
 */
export function createRequestContext<TData>(
  init: RequestContextInit<TData>,
): RequestContext<TData> {
  const state: RequestState<TData> = {
    requestVariables: init.variables,
    storeVariables: init.storeVariables,
    pageRequest: init.pageRequest,
    pageUpdates: init.pageUpdates,
    setup: init.setup,
    silenceEcho: init.silenceEcho,
    optimistic: init.optimistic,
    fetcher: init.fetcher,
    reference: init.reference ?? null,
    closeSubscription: null,
    installSubscription: init.installSubscription,
    beforeData: undefined,
    commitBackground: init.commitBackground,
    layer: null,
    read: null,
    deferred: NO_DEFERRED,
    response: null,
    shouldFetch: false,
    fetched: false,
    error: undefined,
    aborted: false,
    abortReason: undefined,
    resend: init.resend,
    onSubscriptionOpen: init.onSubscriptionOpen,
    optimisticKeySites: [],
    onSubscriptionClose: init.onSubscriptionClose,
    subscriptionOpened: false,
    subscriptionClosed: false,
  };

  const ctx: RequestContext<TData> & { readonly [REQUEST_STATE]: RequestState<TData> } = {
    client: init.client,
    cache: init.cache,
    artifact: init.artifact,
    variables: init.variables,
    policy: init.policy,
    signal: init.signal,
    requestId: init.requestId,
    setup: init.setup,
    silenceEcho: init.silenceEcho,
    get layer(): CacheLayer | null {
      return state.layer;
    },
    get result(): QueryResult<TData> {
      return init.currentResult();
    },
    commit: init.commit,
    fetchNetwork: init.fetchNetwork,
    [REQUEST_STATE]: state,
  };
  return ctx;
}

/** The mutable state of a request context. Throws when handed a context this package did not build. */
export function requestStateOf<TData>(ctx: RequestContext<TData>): RequestState<TData> {
  const carrier = ctx as RequestContext<TData> & {
    readonly [REQUEST_STATE]?: RequestState<TData>;
  };
  const state = carrier[REQUEST_STATE];
  if (state === undefined) {
    throw new Error(
      'This RequestContext carries no request state. Use the context createRequestContext built.',
    );
  }
  return state;
}

/** The stage order of the forward pass, as §5.2 lists it. */
const FORWARD_STAGES = ['start', 'beforeNetwork', 'network'] as const;

/**
 * Walks the five stages over the plugin list: `start`, `beforeNetwork`, `network` in array order,
 * then `afterNetwork`, `end` in reverse array order. `setup: true` skips the forward pass entirely
 * so the caller's seeded state is the only state, and the subscription is installed without a
 * request. `afterNetwork` runs before `end` so the payload write lands before `throwOnError.end`
 * inspects the state (§5.2).
 */
export async function runPipeline<TData>(
  plugins: readonly ClientPlugin[],
  ctx: RequestContext<TData>,
  options: { readonly setup?: boolean } = {},
): Promise<void> {
  if (options.setup !== true) {
    for (const stage of FORWARD_STAGES) {
      for (const plugin of plugins) {
        // the stages are sequential by contract: a plugin's `beforeNetwork` sees every earlier
        // plugin's `start`, so each call is awaited before the next one begins
        // oxlint-disable-next-line eslint/no-await-in-loop -- plugin stages are ordered by §5.2
        await plugin[stage]?.(ctx);
      }
    }
  }
  // the backward pass unwinds the plugin list for `afterNetwork` (the write side), then walks it
  // forward for `end`, so the plugin §5.2 places last (`throwOnError`) really does see the state
  // every other plugin produced, including a rolled-back optimistic layer
  for (const plugin of plugins.toReversed()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- the write side unwinds one plugin at a time
    await plugin.afterNetwork?.(ctx);
  }
  for (const plugin of plugins) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- `throwOnError` must observe every earlier `end`
    await plugin.end?.(ctx);
  }
}

/** Runs every plugin's `cleanup` hook in reverse order: the hook is never a stage (§5.2). */
export function cleanupPlugins<TData>(
  plugins: readonly ClientPlugin[],
  ctx: RequestContext<TData> | null,
): void {
  if (ctx === null) {
    return;
  }
  for (const plugin of plugins.toReversed()) {
    plugin.cleanup?.(ctx);
  }
}
