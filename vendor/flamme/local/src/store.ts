/**
 * The local-first store: a durable cache, a durable queue of local writes, and their replay.
 *
 * The design rests on one invariant: **the serialized cache is the confirmed state, the queue is
 * the local intent**. A local mutation writes into an optimistic layer and is queued; `serialize()`
 * is base-layer only (§6.10 rule 6), so a reload restores the confirmed cache and re-derives every
 * pending layer from the queue. No optimistic payload is ever applied twice.
 *
 * The queue replays strictly in order. A GraphQL error parks the head entry and stops the pass, so a
 * later mutation never reaches the server before an earlier one; a transport failure retries the
 * head entry with exponential backoff. `research/local-first-report.md` records the conflict policy
 * and the cases it does not cover.
 */
import {
  GraphQLHttpError,
  HttpError,
  applyOperations,
  isAbortError,
  isPersistedQueryMiss,
  writeDocument,
} from '@flamme/runtime';
import type {
  Artifact,
  CacheLayer,
  Client,
  ClientPlugin,
  GraphQLResponseError,
  RecordId,
  TransportRequest,
  TransportResponse,
} from '@flamme/runtime';
import { browserAdapter } from './adapter.js';
import { SnapshotEncoder } from './encode.js';
import { describeError, dropLayer, notifyRecords, recordsOf } from './internal.js';
import { decodeSnapshot } from './snapshot.js';
import type {
  LocalAdapter,
  LocalError,
  LocalErrorKind,
  LocalEvent,
  LocalFirst,
  LocalFirstOptions,
  LocalMutationOutcome,
  LocalMutateOptions,
  LocalScheduler,
  LocalStatus,
  StoredMutation,
} from './types.js';

/** The adapter key a store uses when the options name none. */
export const DEFAULT_KEY = 'flamme.local.v1';

/** The first retry delay when the options name none. */
const DEFAULT_INITIAL_DELAY_MS = 1000;

/** The retry ceiling when the options name none. */
const DEFAULT_MAX_DELAY_MS = 30_000;

/** The multiplier between attempts when the options name none. */
const DEFAULT_FACTOR = 2;

/** The persist window when the options name none: a burst of navigation writes becomes one write. */
const DEFAULT_PERSIST_DELAY_MS = 250;

/** The ceiling on the persist deferral when the options name none. */
const DEFAULT_PERSIST_MAX_DELAY_MS = 1000;

/** The outcome of one delivery attempt. */
interface Delivery {
  readonly kind: 'confirmed' | 'parked' | 'retry' | 'aborted';
  readonly data?: unknown;
  readonly errors?: readonly GraphQLResponseError[] | null;
  readonly error?: LocalError;
}

/** The platform's connectivity, without a `navigator` outside a browser. */
function platformOnline(): boolean {
  const navigatorLike: Navigator | undefined = globalThis.navigator;
  return navigatorLike === undefined || navigatorLike.onLine;
}

/** The default scheduler: `setTimeout`, with the canceller the store keeps. */
function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  return () => {
    clearTimeout(timer);
  };
}

/**
 * The default persist scheduler: the window first, then the first idle moment after it.
 *
 * The write happens `delayMs` after the last change (the window), at idle time when the browser
 * offers one, and no later than one more `delayMs` after that (`timeout` is the idle callback's own
 * deadline). Idle time is the right moment for a write nothing is waiting on, but it is **not** the
 * window: scheduling the callback directly on `requestIdleCallback` made every burst element its own
 * persist, because the thread goes idle between two network answers. `requestIdleCallback` is
 * missing outside a browser (and in jsdom), and then the timer's own callback is the write.
 */
function idleSchedule(run: () => void, delayMs: number): () => void {
  let idle: number | null = null;
  let cancelled = false;
  const timer = setTimeout(() => {
    if (cancelled) {
      return;
    }
    const request = globalThis.requestIdleCallback;
    if (typeof request === 'function') {
      idle = request(
        () => {
          idle = null;
          run();
        },
        { timeout: delayMs },
      );
      return;
    }
    run();
  }, delayMs);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    const cancel = globalThis.cancelIdleCallback;
    if (idle !== null && typeof cancel === 'function') {
      cancel(idle);
    }
  };
}

/** The structural event target; `window` satisfies it. */
interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** The store behind {@link LocalFirst}. */
class LocalFirstStore implements LocalFirst {
  #client: Client | undefined;
  readonly #adapter: LocalAdapter;
  readonly #key: string;
  readonly #online: () => boolean;
  readonly #retry: { readonly initial: number; readonly max: number; readonly factor: number };
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #schedule: LocalScheduler;
  readonly #persistDelay: number;
  readonly #persistMaxDelay: number;
  readonly #persistSchedule: LocalScheduler;
  readonly #events: EventTargetLike | null;
  readonly #controller = new AbortController();
  /** Entry id → its optimistic layer; every entry with an optimistic payload has exactly one. */
  readonly #layers = new Map<string, CacheLayer>();
  /** Entries the server rejected, which no pass may re-send until `retry()` clears them. */
  readonly #parked = new Set<string>();
  /** The payload of each confirmed entry, handed to its `mutate()` caller exactly once. */
  readonly #settled = new Map<string, unknown>();
  readonly #listeners = new Set<(event: LocalEvent) => void>();

  #pending: StoredMutation[] = [];
  /** Bumped whenever {@link #pending} changes, so a drain can tell that the queue moved. */
  #queueRevision = 0;
  /** Set by an `online`/`offline` event; `null` means "ask the connectivity source". */
  #forcedOnline: boolean | null = null;
  #syncing = false;
  #lastSyncedAt: number | null = null;
  #error: LocalError | null = null;
  #disposed = false;
  #sequence = 0;
  #writeChain: Promise<void> = Promise.resolve();
  /** The encoder holding the envelope as fragments; built from the cache on the first persist. */
  #encoder: SnapshotEncoder | null = null;
  /** The payload the adapter last accepted, so an unchanged snapshot is not written twice. */
  #written: string | null = null;
  /** Writes queued on {@link #writeChain} and not settled yet. */
  #writing = 0;
  /** The canceller of the open coalescing window, or `null` when none is open. */
  #cancelWindow: (() => void) | null = null;
  /** The clock reading the open window started at, for its ceiling. */
  #windowOpenedAt = 0;
  #cancelRetry: (() => void) | null = null;
  #status: LocalStatus;

  constructor(options: LocalFirstOptions) {
    this.#client = options.client;
    this.#adapter = options.adapter ?? browserAdapter();
    this.#key = options.key ?? DEFAULT_KEY;
    this.#online = options.online ?? platformOnline;
    this.#retry = {
      initial: options.retry?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
      max: options.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      factor: options.retry?.factor ?? DEFAULT_FACTOR,
    };
    this.#maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#persistDelay = options.persist?.delayMs ?? DEFAULT_PERSIST_DELAY_MS;
    this.#persistMaxDelay = options.persist?.maxDelayMs ?? DEFAULT_PERSIST_MAX_DELAY_MS;
    this.#persistSchedule = options.persist?.schedule ?? idleSchedule;
    const events = options.events === undefined ? globalThis.window : options.events;
    this.#events = events ?? null;
    this.#status = this.#buildStatus();
    this.#attachEvents();
    this.#client?.retain(this);
  }

  get status(): LocalStatus {
    return this.#status;
  }

  get queue(): readonly StoredMutation[] {
    return [...this.#pending];
  }

  /**
   * The pipeline hook that persists after every request.
   *
   * `end` runs for every artifact kind, so a query's payload reaches the adapter without the app
   * waiting for `pagehide`. The write is coalesced, and a failure is reported as a storage error
   * rather than thrown into the pipeline.
   */
  get plugin(): ClientPlugin {
    return {
      name: 'localFirst',
      end: (): void => {
        this.schedulePersist();
      },
    };
  }

  connect(client: Client): void {
    if (this.#client !== undefined && this.#client !== client) {
      throw new Error(
        'LocalFirst.connect() was called with a second client; one store mirrors one client.',
      );
    }
    this.#client = client;
    client.retain(this);
    this.#emitChange();
  }

  async restore(): Promise<void> {
    const client = this.#requireClient();
    let raw: string | null;
    try {
      raw = await this.#adapter.get(this.#key);
    } catch (error) {
      this.#fail(
        'storage',
        null,
        `could not read the stored snapshot: ${describeError(error)}`,
        null,
        null,
        false,
      );
      return;
    }
    if (raw === null || raw === '') {
      this.#emitChange();
      return;
    }
    const decoded = decodeSnapshot(raw);
    if (!decoded.ok) {
      this.#fail('storage', null, decoded.problem, null, null, false);
      return;
    }
    try {
      // **Fill, never replace.** The cache may already hold this page load's fresh payload
      // (`createFlamme({ hydrate })` hydrates it before `ready`, and this restore is what `ready`
      // awaits), and the device's snapshot can be a build behind it. A record, list or page the
      // payload carries therefore wins; the snapshot supplies what it does not, so an offline
      // reload still paints and a deploy cannot resurrect the previous build's values.
      client.hydrateMissing(decoded.snapshot.cache);
    } catch (error) {
      this.#fail(
        'storage',
        null,
        `the stored cache was refused: ${describeError(error)}`,
        null,
        null,
        false,
      );
      return;
    }
    if (decoded.dropped > 0) {
      this.#fail(
        'storage',
        null,
        `${decoded.dropped} queued mutation${decoded.dropped === 1 ? '' : 's'} could not be replayed and were dropped`,
        null,
        null,
        false,
      );
    }
    this.#pending = [...decoded.snapshot.queue];
    this.#queueRevision += 1;
    this.#lastSyncedAt = decoded.snapshot.lastSyncedAt;
    // the adapter already holds this payload, so the first persist compares against it instead of
    // writing it back; the encoder itself is rebuilt from the cache when that persist runs
    this.#encoder = null;
    this.#written = raw;
    this.#rebuild();
    this.#emitChange();
    if (this.#isOnline()) {
      await this.flush();
    }
  }

  /**
   * The retired name of {@link LocalFirstStore.restore}.
   *
   * `hydrate` already means SSR cache hydration in this codebase (`createFlamme({ hydrate })`,
   * `client.hydrate`, `Cache.hydrate`), so the method that restores the durable snapshot is
   * `restore()`. This member is kept only to fail loudly: it is typed `never`, so a caller still
   * using the old name gets a compile error, and a caller that reaches it at runtime gets the
   * replacement's name instead of `undefined is not a function`.
   *
   * @deprecated Use {@link LocalFirstStore.restore}.
   */
  get hydrate(): never {
    throw new Error(
      'LocalFirst.hydrate() was renamed to restore(): "hydrate" already means SSR cache hydration ' +
        'in Flamme (createFlamme({ hydrate }), client.hydrate, Cache.hydrate). Call local.restore() ' +
        'to restore the durable snapshot.',
    );
  }

  /**
   * Opens the coalescing window, or re-arms it when one is already open.
   *
   * A no-op when the adapter already holds everything the cache and the queue carry: an unchanged
   * payload must not cost a write, and a lane that is already open is re-armed rather than doubled,
   * so a burst of navigation writes produces exactly one adapter write. The window is trailing, but
   * it never runs longer than `persist.maxDelayMs` from the first change, so a stream of writes
   * cannot defer durability forever.
   */
  schedulePersist(): void {
    if (this.#disposed || this.#client === undefined || !this.#needsPersist()) {
      return;
    }
    const now = this.#now();
    if (this.#cancelWindow !== null) {
      if (now - this.#windowOpenedAt >= this.#persistMaxDelay) {
        // the ceiling is reached: the pending window fires on its own rather than being pushed out
        return;
      }
      this.#cancelWindow();
    } else {
      this.#windowOpenedAt = now;
    }
    this.#cancelWindow = this.#persistSchedule(() => {
      this.#cancelWindow = null;
      void this.persist();
    }, this.#persistDelay);
  }

  /**
   * Writes the confirmed cache plus the queue to the adapter.
   *
   * The encode happens before anything is awaited, so a later queue change cannot leak into the
   * snapshot this call promises. Only the cache entries that changed are re-encoded
   * ({@link SnapshotEncoder}), and a payload the adapter already holds is not written again.
   */
  persist(): Promise<void> {
    this.#cancelPersistWindow();
    const changes = this.#requireClient().serializeChanges();
    const encoder = (this.#encoder ??= new SnapshotEncoder());
    if (changes.full) {
      encoder.reset(changes.snapshot, this.#pending, this.#lastSyncedAt);
    } else {
      encoder.apply(changes, this.#pending, this.#lastSyncedAt);
    }
    const encoded = encoder.encode();
    if (encoded === this.#written && this.#writing === 0) {
      // the adapter already holds exactly this payload: nothing changed worth a write
      return Promise.resolve();
    }
    this.#writing += 1;
    const write = this.#writeChain.then(() => this.#writeSnapshot(encoded));
    this.#writeChain = write;
    return write;
  }

  /** One adapter write, with the failure turned into a reported storage error. */
  async #writeSnapshot(encoded: string): Promise<void> {
    try {
      await this.#adapter.set(this.#key, encoded);
      this.#written = encoded;
    } catch (error) {
      this.#fail(
        'storage',
        null,
        `could not write the snapshot: ${describeError(error)}`,
        null,
        null,
        false,
      );
    } finally {
      this.#writing -= 1;
    }
  }

  /** `true` when the cache or the queue holds something the adapter has not been given. */
  #needsPersist(): boolean {
    const client = this.#client;
    if (client === undefined) {
      return false;
    }
    if (client.hasSerializedChanges()) {
      return true;
    }
    return this.#encoder === null || this.#encoder.queueDiffers(this.#pending, this.#lastSyncedAt);
  }

  /** Closes the open window without writing: a direct `persist()` writes everything it covered. */
  #cancelPersistWindow(): void {
    this.#cancelWindow?.();
    this.#cancelWindow = null;
  }

  mutate<TData = unknown>(
    artifact: Artifact<'mutation', TData>,
    options: LocalMutateOptions,
  ): Promise<LocalMutationOutcome<TData>> {
    return this.#enqueue(artifact, options);
  }

  discard(id: string): Promise<void> {
    return this.#drop(id);
  }

  retry(): Promise<void> {
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#parked.clear();
    if (this.#error !== null && this.#error.kind !== 'storage') {
      this.#error = null;
      this.#emitChange();
    }
    return this.flush();
  }

  /** One entry at a time, in order; a `parked` head and an offline host both end the pass. */
  async flush(): Promise<void> {
    if (this.#disposed || this.#syncing || !this.#isOnline() || this.#pending.length === 0) {
      // nothing to send: a pass that cannot change the status must not publish one
      return;
    }
    this.#syncing = true;
    this.#emitChange();
    const revision = this.#queueRevision;
    try {
      await this.#drain();
    } finally {
      this.#syncing = false;
      this.#emitChange();
    }
    if (this.#queueRevision !== revision) {
      // The pass confirmed or parked an entry, so the durable queue is now a lie: it still holds a
      // write the server has already accepted. Writing it here is what keeps a reload from
      // replaying that entry a second time, and `persist()` skips the write when nothing else moved.
      await this.persist();
    }
  }

  /**
   * Delivers the head entry, then the next one.
   *
   * Written as a recursive step rather than a loop because the order is the contract: entry N+1 is
   * never sent before entry N is confirmed, so the sends cannot be batched or parallelised.
   */
  async #drain(): Promise<void> {
    const entry = this.#pending[0];
    if (this.#disposed || entry === undefined || this.#parked.has(entry.id)) {
      return;
    }
    const delivery = await this.#deliver(entry);
    if (delivery.kind === 'aborted' || this.#disposed) {
      return;
    }
    if (delivery.kind === 'confirmed') {
      this.#confirm(entry, delivery.data ?? null, delivery.errors ?? null);
      return this.#drain();
    }
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    const error = delivery.error;
    if (error === undefined) {
      return;
    }
    if (delivery.kind === 'parked') {
      this.#park(entry, error, true);
    } else {
      this.#backoff(entry, error);
    }
  }

  subscribe(listener: (event: LocalEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#cancelPersistWindow();
    // the fragments mirror a cache this store no longer follows: holding them keeps a whole
    // snapshot's worth of strings alive for nothing
    this.#encoder = null;
    this.#written = null;
    this.#controller.abort();
    this.#detachEvents();
    this.#listeners.clear();
  }

  /* ------------------------------------------------------------------------- the queue */

  /** Writes the mutation locally, queues it durably, and delivers it when it is the queue's turn. */
  async #enqueue<TData>(
    artifact: Artifact<'mutation', TData>,
    options: LocalMutateOptions,
  ): Promise<LocalMutationOutcome<TData>> {
    const client = this.#requireClient();
    if (this.#disposed) {
      throw new Error('LocalFirst.mutate() was called on a disposed store.');
    }
    const entry: StoredMutation = {
      id: `${this.#now()}-${this.#sequence}-${artifact.name}`,
      artifact,
      variables: options.variables,
      ...(options.optimistic === undefined ? {} : { optimistic: options.optimistic }),
      createdAt: this.#now(),
      attempts: 0,
    };
    this.#sequence += 1;
    this.#pending.push(entry);
    this.#queueRevision += 1;
    if (entry.optimistic !== undefined) {
      // the local write is applied before anything is awaited, so a caller that reads the cache
      // synchronously after `mutate()` (or after an `await` on it) sees the new value
      const layer = client.cache.createLayer(true);
      this.#layers.set(entry.id, layer);
      this.#writeEntry(entry, layer);
      client.cache.flush();
    }
    this.#emit({ type: 'queued', payload: entry });
    this.#emitChange();
    await this.persist();
    if (this.#isOnline()) {
      await this.flush();
    }
    return this.#outcomeOf<TData>(entry);
  }

  /** What happened to one entry: parked, still queued, or confirmed during this call. */
  #outcomeOf<TData>(entry: StoredMutation): LocalMutationOutcome<TData> {
    const error = this.#parked.has(entry.id) ? this.#error : null;
    if (error !== null) {
      return { status: 'parked', id: entry.id, error };
    }
    if (this.#pending.some((queued) => queued.id === entry.id)) {
      return { status: 'queued', id: entry.id };
    }
    const data = this.#settled.get(entry.id) ?? null;
    this.#settled.delete(entry.id);
    // the settled payload is stored untyped (any artifact can be queued); `TData` is the caller's own
    // artifact type, which is the same boundary `Client.mutate<TData>` names its result with
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the payload's type is the caller's phantom carrier, never checked here
    return { status: 'confirmed', id: entry.id, data: data as TData };
  }

  /** Drops an entry and undoes its local write; an unknown id is a no-op. */
  async #drop(id: string): Promise<void> {
    const index = this.#pending.findIndex((entry) => entry.id === id);
    if (index < 0) {
      return;
    }
    this.#pending.splice(index, 1);
    this.#queueRevision += 1;
    this.#parked.delete(id);
    if (this.#error?.mutationId === id) {
      this.#error = null;
    }
    this.#rebuild();
    this.#emitChange();
    await this.persist();
    if (this.#isOnline()) {
      await this.flush();
    }
  }

  /* ------------------------------------------------------------------------- the delivery */

  /** Sends one entry and classifies the answer. */
  async #deliver(entry: StoredMutation): Promise<Delivery> {
    const client = this.#requireClient();
    const persisted = client.config.persistedQueries;
    const request: TransportRequest = {
      query: entry.artifact.raw,
      operationName: entry.artifact.name,
      hash: entry.artifact.hash,
      variables: entry.variables,
      artifact: entry.artifact,
      ...(persisted === undefined
        ? {}
        : {
            persistedQuery: {
              mode: 'apq' as const,
              hash: entry.artifact.hash,
              sendDocument: false,
              retryOnNotFound: persisted.retryOnNotFound,
            },
          }),
    };
    const signal = this.#controller.signal;
    let response: TransportResponse;
    try {
      response = await client.config.fetch(request, signal);
      const spec = request.persistedQuery;
      if (
        spec !== undefined &&
        !spec.sendDocument &&
        spec.retryOnNotFound &&
        isPersistedQueryMiss(response)
      ) {
        response = await client.config.fetch(
          { ...request, persistedQuery: { ...spec, sendDocument: true } },
          signal,
        );
      }
    } catch (error) {
      if (isAbortError(error, signal)) {
        return { kind: 'aborted' };
      }
      const failure = this.#failure(
        'transport',
        entry,
        describeError(error),
        null,
        statusOf(error),
      );
      // a 4xx and a GraphQL-error body are answers, not glitches: retrying cannot change them
      if (error instanceof GraphQLHttpError || permanent(error)) {
        return { kind: 'parked', error: failure };
      }
      return { kind: 'retry', error: failure };
    }

    const errors = response.errors ?? null;
    if (response.data !== undefined && response.data !== null) {
      return { kind: 'confirmed', data: response.data, errors };
    }
    if (errors !== null && errors.length > 0) {
      return {
        kind: 'parked',
        error: this.#failure(
          'graphql',
          entry,
          errors[0]?.message ?? 'the mutation failed',
          errors,
          null,
        ),
      };
    }
    return {
      kind: 'parked',
      error: this.#failure(
        'graphql',
        entry,
        'the response carried neither data nor errors, so the mutation cannot be confirmed',
        null,
        null,
      ),
    };
  }

  /** Applies a confirmed payload to the base layer, drops the entry, and rebuilds the queue's layers. */
  #confirm(
    entry: StoredMutation,
    data: unknown,
    errors: readonly GraphQLResponseError[] | null,
  ): void {
    const client = this.#requireClient();
    this.#settled.set(entry.id, data);
    this.#pending = this.#pending.filter((queued) => queued.id !== entry.id);
    this.#queueRevision += 1;
    this.#parked.delete(entry.id);
    if (this.#error?.mutationId === entry.id) {
      // the entry that failed has now been delivered: the transient failure is over
      this.#error = null;
    }
    // The server's answer is authoritative, and it has to be written while the stack is **empty**:
    // the entry's own optimistic layer is dropped by this rebuild, and `ListHandle.toggle` computes
    // the next membership from the stack-resolved ids, so applying the operation one layer lower
    // would compute the inverse of the state the server just confirmed. Dropping first also means
    // the queue's remaining layers are re-derived from the confirmed base rather than from a base
    // that is one answer behind.
    const applied = this.#rebuild(() => {
      if (data === null) {
        return;
      }
      writeDocument(client.cache, entry.artifact, data, entry.variables);
      // The payload's **list operations** land in the base layer too, exactly as the runtime's own
      // mutation plugin does after a network answer (`plugins/mutation.ts`, `afterNetwork`). Writing
      // the payload alone is not enough: the layer holding the queued entry's membership is dropped
      // here, so without seeding the confirmed membership the record silently leaves every `@list`
      // the payload touched. A paid-for lesson: the Pokédex's favourites bar lost its entry the
      // moment the queued toggle was confirmed (`research/pokedex-local-report.md`), and this
      // package's own tests missed it because they only read the list while the entry was queued.
      applyOperations(
        client.cache,
        entry.artifact,
        data,
        entry.variables,
        client.cache.storage.baseLayer(),
      );
    });
    if (!applied && data !== null) {
      // the stack refused the rebuild (a foreign optimistic layer above the store's): the payload is
      // still recorded, without the list operations this pass could not place
      writeDocument(client.cache, entry.artifact, data, entry.variables);
    }
    this.#emit({ type: 'confirmed', payload: { mutation: entry, data } });
    if (errors !== null && errors.length > 0) {
      // a partial success: the payload is applied and the errors are surfaced, without parking
      this.#fail(
        'graphql',
        entry.id,
        errors[0]?.message ?? 'the mutation reported errors',
        errors,
        null,
        false,
      );
    }
    if (this.#pending.length === 0) {
      // the queue drained: whatever stopped it last is no longer stopping anything
      this.#error = null;
      this.#lastSyncedAt = this.#now();
      this.#emit({ type: 'synced', payload: { lastSyncedAt: this.#lastSyncedAt } });
      this.#emitChange();
    }
  }

  /** Parks an entry: it stays queued and no later pass re-sends it until `retry()`/`discard()`. */
  #park(entry: StoredMutation, error: LocalError, emit: boolean): void {
    this.#parked.add(entry.id);
    this.#fail(error.kind, entry.id, error.message, error.errors, error.status, true);
    if (emit) {
      this.#emit({ type: 'parked', payload: { mutation: entry, error } });
    }
  }

  /** A retryable transport failure: bump the attempt count and schedule the next pass. */
  #backoff(entry: StoredMutation, error: LocalError): void {
    const attempts = entry.attempts + 1;
    const index = this.#pending.findIndex((queued) => queued.id === entry.id);
    if (index >= 0) {
      this.#pending[index] = { ...entry, attempts };
      this.#queueRevision += 1;
    }
    if (attempts >= this.#maxAttempts) {
      this.#park(
        entry,
        { ...error, message: `${error.message} (gave up after ${attempts} attempts)` },
        true,
      );
      void this.persist();
      return;
    }
    this.#fail('transport', entry.id, error.message, error.errors, error.status, true);
    const delay = Math.min(
      this.#retry.max,
      this.#retry.initial * this.#retry.factor ** (attempts - 1),
    );
    this.#cancelRetry = this.#schedule(() => {
      this.#cancelRetry = null;
      void this.flush();
    }, delay);
    void this.persist();
  }

  /* ------------------------------------------------------------------------- the layers */

  /**
   * Re-derives the layer stack from the queue.
   *
   * The storage resolves layers in LIFO order and refuses to drop anything but the topmost layer, so
   * the stack is rebuilt from the top. When another optimistic layer sits above the store's (a plain
   * `client.mutate()` with an `optimistic` payload still in flight), the rebuild is refused and
   * reported as a `stack` error rather than corrupting the stack.
   *
   * `write` runs between the two halves: every layer is gone and no queued layer exists yet, so it is
   * the one moment at which a **confirmed** payload can be written to the base layer and have its
   * list operations computed against the confirmed membership instead of against the optimistic
   * guess they replace. It reports whether it ran; a refused rebuild skips it.
   */
  #rebuild(write?: () => void): boolean {
    const client = this.#requireClient();
    const dropped: RecordId[] = [];
    for (const [id, layer] of [...this.#layers].toReversed()) {
      this.#layers.delete(id);
      if (!client.cache.storage.layers.includes(layer)) {
        continue;
      }
      dropped.push(...recordsOf(layer));
      try {
        dropLayer(client.cache, layer);
      } catch (error) {
        this.#fail(
          'stack',
          this.#pending[0]?.id ?? null,
          `a local write could not be replaced because another optimistic layer is open: ${describeError(error)}`,
          null,
          null,
          false,
        );
        return false;
      }
    }
    write?.();
    for (const entry of this.#pending) {
      if (entry.optimistic === undefined) {
        continue;
      }
      const layer = client.cache.createLayer(true);
      this.#layers.set(entry.id, layer);
      this.#writeEntry(entry, layer);
    }
    // the records a dropped layer held may have lost their values entirely; the writer already
    // dirtied the keys it re-wrote, so only the vanished records need an extra notification
    notifyRecords(client.cache, dropped);
    client.cache.flush();
    return true;
  }

  /** Writes one entry's optimistic payload and its `@list` operations into a layer. */
  #writeEntry(entry: StoredMutation, layer: CacheLayer): void {
    const optimistic = entry.optimistic;
    if (optimistic === undefined) {
      return;
    }
    const client = this.#requireClient();
    writeDocument(client.cache, entry.artifact, optimistic, entry.variables, { layer });
    applyOperations(client.cache, entry.artifact, optimistic, entry.variables, layer);
  }

  /* ------------------------------------------------------------------------- status and events */

  #buildStatus(): LocalStatus {
    return {
      online: this.#isOnline(),
      pending: this.#pending.length,
      syncing: this.#syncing,
      lastSyncedAt: this.#lastSyncedAt,
      error: this.#error,
    };
  }

  #emitChange(): void {
    const next = this.#buildStatus();
    if (
      next.online === this.#status.online &&
      next.pending === this.#status.pending &&
      next.syncing === this.#status.syncing &&
      next.lastSyncedAt === this.#status.lastSyncedAt &&
      next.error === this.#status.error
    ) {
      return;
    }
    this.#status = next;
    this.#emit({ type: 'change', payload: next });
  }

  #failure(
    kind: LocalErrorKind,
    entry: StoredMutation,
    message: string,
    errors: readonly GraphQLResponseError[] | null,
    status: number | null,
  ): LocalError {
    return { kind, mutationId: entry.id, message, errors, status, at: this.#now() };
  }

  /** Publishes a failure. `stopped` is `true` only for the failure that stopped the queue. */
  #fail(
    kind: LocalErrorKind,
    mutationId: string | null,
    message: string,
    errors: readonly GraphQLResponseError[] | null,
    status: number | null,
    stopped: boolean,
  ): void {
    const error: LocalError = { kind, mutationId, message, errors, status, at: this.#now() };
    if (stopped) {
      this.#error = error;
    }
    this.#emit({ type: 'error', payload: error });
    if (stopped) {
      this.#emitChange();
    }
  }

  /**
   * Publishes one event to every subscriber.
   *
   * A subscriber that throws must never stop the queue or the other subscribers, so each call is
   * isolated. The failure lands on the status instead of being emitted: emitting from inside this
   * loop would re-enter the subscriber that just threw.
   */
  #emit(event: LocalEvent): void {
    let failures = 0;
    // copied first: a listener may unsubscribe while the event is being delivered
    const listeners = Array.from(this.#listeners);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        failures += 1;
      }
    }
    if (failures > 0) {
      this.#error = {
        kind: 'storage',
        mutationId: null,
        message: `${failures} local-first listener${failures === 1 ? '' : 's'} threw while handling "${event.type}"`,
        errors: null,
        status: null,
        at: this.#now(),
      };
    }
  }

  /** The connectivity the store acts on: an event overrides the source, which is re-read live. */
  #isOnline(): boolean {
    return this.#forcedOnline ?? this.#online();
  }

  #requireClient(): Client {
    const client = this.#client;
    if (client === undefined) {
      throw new Error(
        'This local-first store has no client yet: pass { client } to createLocalFirst(), or call connect(client) after createFlamme() built one.',
      );
    }
    return client;
  }

  /* ------------------------------------------------------------------------- the browser wiring */

  #onOnline = (): void => {
    this.#forcedOnline = true;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#emitChange();
    void this.flush();
  };

  #onOffline = (): void => {
    this.#forcedOnline = false;
    this.#emitChange();
  };

  #onPersist = (): void => {
    if (this.#client !== undefined) {
      void this.persist();
    }
  };

  #onVisibility = (): void => {
    if (this.#client !== undefined && globalThis.document?.visibilityState === 'hidden') {
      void this.persist();
    }
  };

  /** `online`/`offline` drive the status; `pagehide`/`freeze`/a hidden tab persist. */
  #attachEvents(): void {
    const events = this.#events;
    if (events === null) {
      return;
    }
    events.addEventListener('online', this.#onOnline);
    events.addEventListener('offline', this.#onOffline);
    events.addEventListener('pagehide', this.#onPersist);
    events.addEventListener('freeze', this.#onPersist);
    events.addEventListener('visibilitychange', this.#onVisibility);
  }

  #detachEvents(): void {
    const events = this.#events;
    if (events === null) {
      return;
    }
    events.removeEventListener('online', this.#onOnline);
    events.removeEventListener('offline', this.#onOffline);
    events.removeEventListener('pagehide', this.#onPersist);
    events.removeEventListener('freeze', this.#onPersist);
    events.removeEventListener('visibilitychange', this.#onVisibility);
  }
}

/** The HTTP status of a transport failure that carried one, else `null`. */
function statusOf(error: unknown): number | null {
  if (error instanceof HttpError || error instanceof GraphQLHttpError) {
    return error.status;
  }
  return null;
}

/** `true` when a 4xx means the request itself is wrong, so a retry cannot change the answer. */
function permanent(error: unknown): boolean {
  return error instanceof HttpError && error.status >= 400 && error.status < 500;
}

/**
 * Creates the local-first store for one client.
 *
 * ```ts
 * const local = createLocalFirst({ client })
 * await local.restore()
 * ```
 */
export function createLocalFirst(options: LocalFirstOptions): LocalFirst {
  return new LocalFirstStore(options);
}
