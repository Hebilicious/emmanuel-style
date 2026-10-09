/**
 * `@flamme/local` — local-first support for a Flamme app: a durable normalized cache, local
 * mutations that survive a reload, an ordered offline queue with replay, and a reactive sync status.
 *
 * This entry is framework-agnostic: it imports `@flamme/runtime`, never `vue`. The composable and the
 * app plugin live in the `./vue` entry point (`@flamme/local/vue`), which is where `vue` is a peer.
 *
 * ```ts
 * const local = createLocalFirst({ client })
 * await local.restore()                       // before the first render
 * app.use(localFirstPlugin(local))            // from '@flamme/local/vue'
 * await local.mutate(ToggleFavorite, { variables: { id }, optimistic: { … } })
 * ```
 *
 * An app that installs the store through `createFlamme({ local: … })` never calls this module: the
 * container builds the store, restores it (`await flamme.ready`) and installs it with its own
 * plugin. This entry stays the explicit path, for a non-Vue host or a store the app owns itself.
 */

/** A `Map`-backed adapter: the test adapter and the last-resort fallback. */
export { memoryAdapter } from './adapter.js';
/** A `localStorage` adapter; `setItem` throws on a quota failure, which the store reports. */
export { localStorageAdapter } from './adapter.js';
/** An IndexedDB adapter: one database, one object store, one record per key. */
export { indexedDBAdapter } from './adapter.js';
/** The browser default: IndexedDB, then `localStorage`, then memory. */
export { browserAdapter } from './adapter.js';
export type {
  /** The options of {@link browserAdapter}: the union of both adapter options. */
  BrowserAdapterOptions,
  /** The opened database, to the extent the adapter needs it. */
  IDBDatabaseLike,
  /** The object store: three request-returning operations. */
  IDBObjectStoreLike,
  /** An open request: the upgrade hook, the result and the failure. */
  IDBOpenRequestLike,
  /** One request: its result, its failure and the success hook. */
  IDBRequestLike,
  /** A transaction: its store, its failure and the completion hook `set` waits for. */
  IDBTransactionLike,
  /** The options of {@link indexedDBAdapter}, `factory` included for an injected fake. */
  IndexedDBAdapterOptions,
  /** The `IDBFactory` surface the adapter uses, satisfied by the DOM type and by a fake. */
  IndexedDBFactoryLike,
  /** The options of {@link localStorageAdapter}. */
  LocalStorageAdapterOptions,
  /** The subset of the DOM `Storage` interface the `localStorage` adapter needs. */
  StorageLike,
} from './adapter.js';

/** The adapter key a store uses when the options name none (`'flamme.local.v1'`). */
export { DEFAULT_KEY } from './store.js';
/** The store factory: the durable cache, the queue, the replay and the sync status. */
export { createLocalFirst } from './store.js';

/** The envelope version this package writes (`1`). */
export { SNAPSHOT_VERSION } from './snapshot.js';
/** Encodes a snapshot to the JSON string an adapter stores. */
export { encodeSnapshot } from './snapshot.js';
/** Decodes and validates a stored payload, dropping unreadable queue entries. */
export { decodeSnapshot } from './snapshot.js';
export type {
  /** The result of {@link decodeSnapshot}: the snapshot plus how many entries were dropped. */
  DecodeResult,
} from './snapshot.js';

/** The cache payload a snapshot carries, re-exported so an adapter or a test can name it. */
export type { SerializedCache } from '@flamme/runtime';

export type {
  /** The persistence boundary: a string-keyed blob store, injectable. */
  LocalAdapter,
  /** One failure the local-first layer wants the app to see. */
  LocalError,
  /** Why the queue stopped: a GraphQL error, a dead transport, storage, or the layer stack. */
  LocalErrorKind,
  /** One delivered event, as a discriminated union over `type`. */
  LocalEvent,
  /** The event names {@link LocalFirst.subscribe} delivers. */
  LocalEventName,
  /** The payload of every event, keyed by event name. */
  LocalEvents,
  /** The minimal event target the browser wiring attaches to; `window` satisfies it. */
  LocalEventTarget,
  /** The local-first store: the durable cache, the queued local writes and their replay. */
  LocalFirst,
  /** Everything {@link createLocalFirst} accepts. */
  LocalFirstOptions,
  /** What `mutate()` did with the call: confirmed, queued, or parked. */
  LocalMutationOutcome,
  /** The options of one local mutation: its variables and its optimistic payload. */
  LocalMutateOptions,
  /** How a burst of cache writes is coalesced into one adapter write. */
  LocalPersistOptions,
  /** The backoff of a retryable transport failure. */
  LocalRetryOptions,
  /** Schedules one delayed callback and returns its canceller; tests inject a fake timer. */
  LocalScheduler,
  /** The persisted envelope: the confirmed cache plus the pending queue. */
  LocalSnapshot,
  /** The sync state a UI renders: online, pending, syncing, lastSyncedAt and error. */
  LocalStatus,
  /** What {@link LocalFirstOptions.online} overrides. */
  OnlineSource,
  /** One queued mutation, as persisted. */
  StoredMutation,
} from './types.js';
