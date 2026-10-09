/**
 * `QueryLifecycle`: the seam for a future `@flamme/xstate` (§5.8, D5).
 *
 * `DocumentStore` **wraps** a lifecycle rather than implementing it: it is constructed with the
 * `createQueryLifecycle` result (or `ClientConfig.lifecycle`) and forwards `result`, `snapshot`,
 * `subscribe`, `fetch`, `invalidate` and `dispose`, adding only the store-level surface.
 *
 * `DefaultQueryLifecycle` is the hand-rolled implementation behind `createQueryLifecycle` (D5). It
 * owns the store's state, its listeners, the monotonic request id and the request's abort
 * controller, and it runs the plugin pipeline in `fetch`. Teardown is restartable: `dispose()`
 * aborts, unsubscribes and clears the listeners, and the next `subscribe`/`fetch` starts it again,
 * which is what lets `DocumentStore.cleanup()` and a later subscriber share one store (§5.3).
 */
import type { Artifact, ArtifactKind, CachePolicy, FragmentReference, Variables } from './artifact.js';
import type { Client, QueryOptions, TransportRequest, TransportResponse } from './client.js';
import type { ClientPlugin, RequestContext } from './pipeline.js';
import { cleanupPlugins, createRequestContext, requestStateOf, runPipeline } from './pipeline.js';
import type { QueryResult } from './result.js';
import {
  dedupeConfigOf,
  requestKey,
  resolveCachePolicy,
  type InFlightRequest,
  type RequestRegistry,
} from './requests.js';
import { isLoadingFrame } from './loading.js';
import { cacheDeferredState } from './incremental.js';
import { ROOT_RECORD, readDocument, reportPartial } from './reader.js';
import { marshalInputs } from './variables.js';
import { isClientDisposed } from './client.js';
import { ClientDisposedError } from './errors.js';

export interface QueryLifecycle<TData = unknown> {
  /** Current result. Plain object; never a Vue ref (this package does not import vue). */
  readonly result: QueryResult<TData>;
  /** Frozen snapshot identity that changes only when the result changes. */
  readonly snapshot: unknown;
  subscribe(listener: (result: QueryResult<TData>) => void): () => void;
  fetch(variables: Variables, options?: QueryOptions): Promise<QueryResult<TData>>;
  /** Mark the data stale and re-read; does not necessarily hit the network. */
  invalidate(): void;
  dispose(): void;
}

/**
 * The factory the `Client` accepts. A replacement implementation (e.g. `@flamme/xstate`) is
 * installed with `ClientConfig.lifecycle`; nothing else changes.
 */
export interface QueryLifecycleOptions<TData> {
  readonly client: Client;
  readonly artifact: Artifact<ArtifactKind, TData>;
  readonly variables?: Variables;
  readonly initialValue?: TData | null;
  readonly fetching?: boolean;
  readonly plugins: readonly ClientPlugin[];
  /** The client's in-flight table, so two stores share one request (§5.6, additive). */
  readonly requests?: RequestRegistry;
  /** The fragment reference a fragment store reads through (§5.3, additive). */
  readonly reference?: FragmentReference;
  /** `Client.subscribe`'s payload-channel open hook (additive). */
  readonly onSubscriptionOpen?: () => void;
  /** `Client.subscribe`'s payload-channel close hook (additive). */
  readonly onSubscriptionClose?: () => void;
}

/** The lifecycle every store is built on in v1. */
export interface DefaultQueryLifecycle<TData = unknown> extends QueryLifecycle<TData> {}

/** The outcome of one `fetch`, including the failure the `throwOnError` plugin produced. */
export interface RequestOutcome<TData> {
  readonly result: QueryResult<TData>;
  readonly failure: unknown;
  readonly aborted: boolean;
  readonly abortReason: unknown;
}

/** The hand-rolled lifecycle: state, listeners, request ids, dedupe and the plugin pipeline. */
class DefaultLifecycle<TData = unknown> implements QueryLifecycle<TData> {
  readonly #client: Client;
  readonly #artifact: Artifact<ArtifactKind, TData>;
  readonly #plugins: readonly ClientPlugin[];
  readonly #requests: RequestRegistry | undefined;
  readonly #reference: FragmentReference | null;
  readonly #onSubscriptionOpen: (() => void) | undefined;
  readonly #onSubscriptionClose: (() => void) | undefined;
  readonly #listeners = new Set<(result: QueryResult<TData>) => void>();

  #variables: Variables;
  #result: QueryResult<TData>;
  #requestId = 0;
  #generation = 0;
  #silentRequestId: number | null = null;
  #controller: AbortController | null = null;
  #context: RequestContext<TData> | null = null;
  #subscription: (() => void) | null = null;
  /** Unregisters this request's first-payload observer (`QueryOptions.onFirstPayload`). */
  #stopFirstPayload: (() => void) | null = null;

  constructor(options: QueryLifecycleOptions<TData>) {
    this.#client = options.client;
    this.#artifact = options.artifact;
    this.#plugins = options.plugins;
    this.#requests = options.requests;
    this.#reference = options.reference ?? null;
    this.#onSubscriptionOpen = options.onSubscriptionOpen;
    this.#onSubscriptionClose = options.onSubscriptionClose;
    this.#variables = marshalInputs(options.artifact, options.variables ?? {});
    // §7.13: a document that declares `@defer`/`@stream` starts *pending* — the very first render
    // must show the boundary's fallback rather than flash the content and then take it away when
    // the initial payload announces `hasNext`. `hasNext` is `true` for exactly that window; a
    // response that ignored the directives flips every label to `ready` in one commit.
    const deferred = cacheDeferredState(options.client.cache, options.artifact, this.#variables);
    this.#result = freezeResult<TData>({
      data: options.initialValue ?? null,
      errors: null,
      fetching: options.fetching ?? options.artifact.kind === 'query',
      partial: false,
      stale: false,
      source: null,
      variables: Object.keys(this.#variables).length === 0 ? null : this.#variables,
      extensions: null,
      hasNext: Object.values(deferred).includes('pending'),
      deferred,
    });
  }

  /** The current result: a frozen object, replaced rather than mutated on every change. */
  get result(): QueryResult<TData> {
    return this.#result;
  }

  /** The frozen snapshot identity; the result object itself, which changes only when it changes. */
  get snapshot(): unknown {
    return this.#result;
  }

  /** The store's variables as the last non-page request left them. */
  get variables(): Variables {
    return this.#variables;
  }

  /** Subscribe to result changes; the listener runs immediately with the current result (§5.3). */
  subscribe(listener: (result: QueryResult<TData>) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#result);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.#listeners.delete(listener);
    };
  }

  /** Runs one request through the pipeline and resolves with the store's final state. */
  async fetch(variables: Variables, options: QueryOptions = {}): Promise<QueryResult<TData>> {
    const outcome = await this.run(variables, options);
    if (outcome.failure !== undefined) {
      throw outcome.failure;
    }
    return this.#result;
  }

  /** `fetch` without the `throwOnError` rejection, for callers that need the abort reason. */
  async run(variables: Variables, options: QueryOptions = {}): Promise<RequestOutcome<TData>> {
    const client = this.#client;
    if (isClientDisposed(client)) {
      throw new ClientDisposedError(
        'This store belongs to a client that has been disposed, so it can never be delivered (FLM4006).',
        { hint: 'create one client per app (or per SSR request) and keep it alive for that request' },
      );
    }

    const artifact = this.#artifact;
    const send = options.sendOptions ?? {};
    const pageRequest = send.cacheParams?.disableSubscriptions === true;
    const setup = options.setup === true;
    const resolved = marshalInputs(artifact, variables);
    const policy = resolveCachePolicy(options.policy, artifact, client.config.cachePolicy);
    const requestId = ++this.#requestId;
    const generation = this.#generation;
    if (!pageRequest) {
      this.#variables = resolved;
    }

    const controller = new AbortController();
    this.#controller = controller;
    const detach = bridgeSignal(options.signal, controller);
    const before = this.#result;
    this.#silentRequestId = send.silenceEcho === true ? requestId : null;

    const entry = setup ? null : this.#acquire(artifact, resolved, controller, requestId);
    const joined = entry !== null && entry.controller !== controller;
    const ctx = this.#buildContext({
      options,
      controller,
      requestId,
      setup,
      policy,
      resolved,
      send,
      entry,
    });
    this.#context = ctx;
    const state = requestStateOf(ctx);
    this.#observeFirstPayload(entry, requestId, generation, options);

    try {
      if (entry !== null && joined) {
        return await this.#join(entry, requestId, generation, resolved, before);
      }
      if (setup) {
        this.#seed(ctx, false);
        const failure = await this.#complete(
          runPipeline(this.#plugins, ctx, { setup: true }),
          entry,
          requestId,
          generation,
          before,
        );
        return { result: this.#result, failure, aborted: false, abortReason: undefined };
      }
      if (policy === 'CacheAndNetwork' && !pageRequest) {
        // the cache value is delivered first; the network keeps updating the same store
        this.#seed(ctx, true);
        const background = runPipeline(this.#plugins, ctx, { setup: false });
        void this.#complete(background, entry, requestId, generation, before);
        return { result: this.#result, failure: undefined, aborted: false, abortReason: undefined };
      }
      const failure = await this.#complete(
        runPipeline(this.#plugins, ctx, { setup: false }),
        entry,
        requestId,
        generation,
        before,
      );
      return { result: this.#result, failure, aborted: state.aborted, abortReason: state.abortReason };
    } finally {
      detach();
      if (this.#controller === controller) {
        this.#controller = null;
      }
    }
  }

  /** Marks the data stale and re-reads it, so the next `CacheOrNetwork` send refetches (§6.9). */
  invalidate(): void {
    this.#client.cache.markRecordStale(ROOT_RECORD);
    const read = readDocument<TData>(this.#client.cache, this.#artifact, this.#variables, {
      previous: this.#result.data,
    });
    this.commitResult({
      data: read.data,
      partial: this.#partial(read.partial),
      stale: true,
      source: read.partial ? 'partial' : 'cache',
    });
  }

  /** Aborts the request in flight, drops the cache subscription and clears the listeners. */
  dispose(): void {
    this.#generation += 1;
    this.#silentRequestId = null;
    this.#controller?.abort();
    this.#controller = null;
    this.#subscription?.();
    this.#subscription = null;
    this.#stopFirstPayload?.();
    this.#stopFirstPayload = null;
    cleanupPlugins(this.#plugins, this.#context);
    this.#context = null;
    this.#listeners.clear();
    if (this.#result.fetching || isLoadingFrame(this.#result.data)) {
      // teardown is not a state change a component should render, so this never notifies. A
      // loading frame is cleared with the request that would have filled it: a torn-down store must
      // not claim data is still coming (`review-slice34-adversarial.md` M6).
      this.#result = freezeResult({
        ...this.#result,
        fetching: false,
        ...(isLoadingFrame(this.#result.data) ? { data: null } : {}),
      });
    }
  }

  /** Replaces the result and notifies (backing `DocumentStore.set`). */
  setResult(value: QueryResult<TData>): void {
    this.#result = freezeResult(value);
    this.#notify();
  }

  /** Merges a patch into the result and notifies (the lifecycle's own public commit). */
  commitResult(patch: Partial<QueryResult<TData>>): void {
    const next = mergeResult(this.#result, patch);
    if (next === this.#result) {
      return;
    }
    this.#result = next;
    this.#notify();
  }

  /* ------------------------------------------------------------------ request plumbing */

  /**
   * Attaches this request's `onFirstPayload` observer to the entry it leads or joined (§7.13).
   *
   * One channel serves both: the leader publishes from the commit that announced `hasNext: true`,
   * a joiner is handed the same result through the entry. The read itself still settles with the
   * whole response, so the observation never changes what `fetch` resolves with.
   */
  #observeFirstPayload(
    entry: InFlightRequest<TData> | null,
    requestId: number,
    generation: number,
    options: QueryOptions,
  ): void {
    this.#stopFirstPayload?.();
    this.#stopFirstPayload = null;
    const observer = options.onFirstPayload;
    if (entry === null || observer === undefined) {
      return;
    }
    this.#stopFirstPayload = entry.onFirstPayload((result) => {
      if (requestId !== this.#requestId || generation !== this.#generation) {
        // a superseded or torn-down read must not hand its caller a payload any more
        return;
      }
      observer(result);
    });
  }

  #buildContext(init: {
    readonly options: QueryOptions;
    readonly controller: AbortController;
    readonly requestId: number;
    readonly setup: boolean;
    readonly policy: CachePolicy;
    readonly resolved: Variables;
    readonly send: NonNullable<QueryOptions['sendOptions']>;
    /** The in-flight entry this store leads, when no other store led it first. */
    readonly entry: InFlightRequest<TData> | null;
  }): RequestContext<TData> {
    return createRequestContext<TData>({
      client: this.#client,
      cache: this.#client.cache,
      artifact: this.#artifact,
      variables: init.resolved,
      storeVariables: this.#variables,
      policy: init.policy,
      signal: init.controller.signal,
      requestId: init.requestId,
      setup: init.setup,
      silenceEcho: init.send.silenceEcho === true,
      pageRequest: init.send.cacheParams?.disableSubscriptions === true,
      pageUpdates: init.send.cacheParams?.applyUpdates ?? [],
      ...(init.send.optimistic === undefined ? {} : { optimistic: init.send.optimistic }),
      ...(init.options.fetch === undefined ? {} : { fetcher: init.options.fetch }),
      ...(this.#reference === null ? {} : { reference: this.#reference }),
      commit: (patch) => {
        const entry = init.entry;
        if (!this.#commit(init.requestId, patch)) {
          return;
        }
        // §7.13: a store that joined this request shares the leader's commits as they happen, so its
        // `hasNext`, `deferred` and data track the stream rather than freezing until the leader
        // settles. Only the leader publishes: an entry this request merely joined has its own leader.
        if (entry !== null && entry.controller === init.controller) {
          entry.joins.publish(patch);
          if (patch.hasNext === true) {
            // the commit that announces more payloads is the first payload: every read that asked
            // for it (this one and every joiner) settles on the state it just wrote
            entry.publishFirstPayload(this.#result);
          }
        }
      },
      commitBackground: (patch) => this.#write(patch, false),
      fetchNetwork: async (): Promise<TransportResponse> =>
        this.#client.config.fetch(
          buildRequest(this.#artifact, init.resolved),
          init.controller.signal,
        ),
      installSubscription: (dispose) => this.#installSubscription(dispose),
      currentResult: () => this.#result,
      resend: (policy: CachePolicy) => {
        void this.fetch(this.#variables, { policy }).catch(() => {
          // the resend's failure is already in the store's errors; nothing else to do here
        });
      },
      ...(this.#onSubscriptionOpen === undefined
        ? {}
        : { onSubscriptionOpen: this.#onSubscriptionOpen }),
      ...(this.#onSubscriptionClose === undefined
        ? {}
        : { onSubscriptionClose: this.#onSubscriptionClose }),
    });
  }

  #acquire(
    artifact: Artifact<ArtifactKind, TData>,
    variables: Variables,
    controller: AbortController,
    requestId: number,
  ): InFlightRequest<TData> | null {
    const registry = this.#requests;
    if (registry === undefined) {
      return null;
    }
    const key = requestKey(artifact, variables);
    const existing = registry.get<TData>(key);
    if (existing === undefined) {
      return registry.create<TData>(key, requestId, controller);
    }
    if (dedupeConfigOf(artifact).cancelFirst) {
      registry.cancel(existing);
      return registry.create<TData>(key, requestId, controller);
    }
    return existing;
  }

  /** A store that joined an in-flight request: it follows the leader's commits, then copies its result. */
  async #join(
    entry: InFlightRequest<TData>,
    requestId: number,
    generation: number,
    resolved: Variables,
    before: QueryResult<TData>,
  ): Promise<RequestOutcome<TData>> {
    entry.refs += 1;
    this.#commit(requestId, { fetching: true, variables: resolved, errors: null });
    // §7.13: the leader publishes every commit it accepts, so a store that joined mid-stream sees
    // the patches as they land — its `hasNext`/`deferred` and the data a patch wrote — instead of
    // only the final result. The guard is the same one the copy below uses: a joiner that was
    // superseded, or torn down, writes nothing.
    const leave = entry.joins.add((patch) => {
      if (requestId === this.#requestId && generation === this.#generation) {
        this.#write(patch, false);
      }
    });
    let failure: unknown;
    try {
      await entry.promise;
      failure = entry.failure;
      const shared = entry.result;
      if (shared !== null && requestId === this.#requestId && generation === this.#generation) {
        this.#commit(requestId, {
          data: shared.data,
          errors: shared.errors,
          partial: shared.partial,
          stale: shared.stale,
          source: shared.source,
          extensions: shared.extensions,
          // §7.13: a store that joined an in-flight request shares the leader's whole result,
          // incremental state included — otherwise its `@defer` labels would stay pending forever
          // while the data they gate is already on screen.
          hasNext: shared.hasNext,
          deferred: shared.deferred,
          fetching: false,
          variables: resolved,
        });
      }
    } finally {
      leave();
      this.#stopFirstPayload?.();
      this.#stopFirstPayload = null;
      this.#requests?.release(entry);
    }
    this.#finish(requestId, generation, before);
    return { result: this.#result, failure, aborted: false, abortReason: undefined };
  }

  /** Awaits one pipeline run, finalises the state and settles the shared entry. */
  async #complete(
    running: Promise<void>,
    entry: InFlightRequest<TData> | null,
    requestId: number,
    generation: number,
    before: QueryResult<TData>,
  ): Promise<unknown> {
    let failure: unknown;
    try {
      await running;
    } catch (error) {
      failure = error;
    }
    this.#finish(requestId, generation, before);
    if (entry !== null) {
      entry.failure = failure;
      entry.result = this.#result;
      entry.resolve(this.#result);
      this.#requests?.release(entry);
    }
    this.#stopFirstPayload?.();
    this.#stopFirstPayload = null;
    return failure;
  }

  /** The tail of a request: the final state, and the `silenceEcho` comparison (§5.2). */
  #finish(requestId: number, generation: number, before: QueryResult<TData>): void {
    if (requestId !== this.#requestId || generation !== this.#generation) {
      return;
    }
    const produced = this.#result.fetching
      ? freezeResult({ ...this.#result, fetching: false })
      : this.#result;
    if (this.#silentRequestId === requestId) {
      if (Object.is(produced.data, before.data)) {
        // the request changed nothing the store renders: the whole send stays invisible
        this.#result = before;
        return;
      }
      this.#result = produced;
      this.#notify();
      return;
    }
    if (produced === this.#result) {
      return;
    }
    this.#result = produced;
    this.#notify();
  }

  /** Seeds the store from the cache without a request (`setup: true` and `CacheAndNetwork`). */
  #seed(ctx: RequestContext<TData>, fetching: boolean): void {
    const state = requestStateOf(ctx);
    const reference = this.#reference;
    const parent = reference?.parent ?? ROOT_RECORD;
    const variables = reference?.variables ?? state.storeVariables;
    const read = readDocument<TData>(this.#client.cache, this.#artifact, variables, {
      parent,
      previous: this.#result.data,
      ...(state.layer === null ? {} : { layer: state.layer }),
    });
    if (read.hasData) {
      this.#commit(ctx.requestId, {
        data: read.data,
        partial: this.#partial(read.partial),
        stale: read.stale,
        source: read.partial ? 'partial' : 'cache',
        variables: state.storeVariables,
      });
    }
    this.#commit(ctx.requestId, {
      fetching,
      errors: null,
      variables: state.storeVariables,
    });
  }

  #installSubscription(dispose: () => void): void {
    if (this.#context === null) {
      // the request finished after teardown: a late subscription must not leak
      dispose();
      return;
    }
    this.#subscription?.();
    this.#subscription = dispose;
  }

  /**
   * A commit from a stage of `requestId`; a superseded request's write is dropped (§5.6). The return
   * value says whether the store accepted the commit, which is what the leader's fan-out to joined
   * stores is gated on.
   */
  #commit(requestId: number, patch: Partial<QueryResult<TData>>): boolean {
    if (requestId !== this.#requestId) {
      return false;
    }
    this.#write(patch, this.#silentRequestId === requestId);
    return true;
  }

  #write(patch: Partial<QueryResult<TData>>, silent: boolean): void {
    const next = mergeResult(this.#result, patch);
    if (next === this.#result) {
      return;
    }
    this.#result = next;
    if (!silent && this.#listeners.size > 0) {
      this.#notify();
    }
  }

  #notify(): void {
    const result = this.#result;
    // copied before iterating: a listener may unsubscribe during notification
    for (const listener of Array.from(this.#listeners)) {
      listener(result);
    }
  }

  /** The `partial` flag this store reports (`@cache(partial:)` declares missing fields fine). */
  #partial(partial: boolean): boolean {
    return reportPartial(partial, this.#artifact.partial ?? this.#client.config.partial);
  }
}

/**
 * The v1 implementation under its public name. It is a value alias rather than a merged
 * `class DefaultQueryLifecycle`, so the frozen `DefaultQueryLifecycle` interface stays the only
 * *type* declaration of that name (REQ-2.9, D5).
 */
export const DefaultQueryLifecycle = DefaultLifecycle;

/** A `DefaultQueryLifecycle` or any lifecycle that can also replace its result (additive members). */
export interface StoreLifecycle<TData = unknown> extends QueryLifecycle<TData> {
  /** Replace the result and notify (backing `DocumentStore.set`). */
  setResult(value: QueryResult<TData>): void;
}

/** The factory behind `ClientConfig.lifecycle`; returns the hand-rolled v1 lifecycle (D5). */
export function createQueryLifecycle<TData>(
  options: QueryLifecycleOptions<TData>,
): QueryLifecycle<TData> {
  return new DefaultLifecycle<TData>(options);
}

/** `true` when a lifecycle exposes the additive members `DocumentStore` uses when it has them. */
export function isStoreLifecycle<TData>(
  lifecycle: QueryLifecycle<TData>,
): lifecycle is StoreLifecycle<TData> {
  return typeof (lifecycle as Partial<StoreLifecycle<TData>>).setResult === 'function';
}

/** The `QueryResult` members a patch may carry. */
const RESULT_KEYS = [
  'data',
  'errors',
  'fetching',
  'partial',
  'stale',
  'source',
  'variables',
  'extensions',
  'hasNext',
  'deferred',
] as const satisfies readonly (keyof QueryResult)[];

/** Merges a patch into a result, returning the same object when nothing observable changed. */
function mergeResult<TData>(
  current: QueryResult<TData>,
  patch: Partial<QueryResult<TData>>,
): QueryResult<TData> {
  for (const key of RESULT_KEYS) {
    if (!Object.is(current[key], patch[key])) {
      return freezeResult({ ...current, ...patch });
    }
  }
  return current;
}

/** Freezes a result once; nested data is frozen by the cache's read. */
function freezeResult<TData>(value: QueryResult<TData>): QueryResult<TData> {
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

/** Bridges an external signal into the request's controller (§11, the router adapter). */
function bridgeSignal(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (external === undefined) {
    return () => {};
  }
  if (external.aborted) {
    controller.abort(external.reason);
    return () => {};
  }
  const onAbort = (): void => {
    controller.abort(external.reason);
  };
  external.addEventListener('abort', onAbort);
  return () => external.removeEventListener('abort', onAbort);
}

/** The transport request one lifecycle fetch builds. */
function buildRequest<TData>(
  artifact: Artifact<ArtifactKind, TData>,
  variables: Variables,
): TransportRequest {
  return {
    query: artifact.raw,
    operationName: artifact.name,
    hash: artifact.hash,
    variables,
    artifact,
  };
}
