/**
 * The public types of `@flamme/local` (the local-first layer).
 *
 * Nothing here imports `vue`: the framework-agnostic entry is the store, the queue, the adapters and
 * the status object, and the composable lives in `@flamme/local/vue` (a separate entry point that
 * may import `vue`).
 */
import type {
  Artifact,
  Client,
  ClientPlugin,
  GraphQLResponseError,
  SerializedCache,
  Variables,
} from '@flamme/runtime';

/**
 * The persistence boundary: a string-keyed blob store, injectable so tests and non-browser hosts can
 * substitute their own (a memory map, `localStorage`, IndexedDB, or a server-side file).
 *
 * Values are strings because that is the one shape `localStorage` and IndexedDB agree on; the
 * snapshot is written with `JSON.stringify` by the store and never by the adapter.
 */
export interface LocalAdapter {
  /** Reads the record under `key`, or `null` when there is none. */
  get(key: string): Promise<string | null>;
  /** Writes `value` under `key`, replacing whatever was stored there. */
  set(key: string, value: string): Promise<void>;
  /** Removes `key`; removing a missing key is not an error. */
  remove(key: string): Promise<void>;
}

/** Why the queue stopped, for the UI and for the event payloads. */
export type LocalErrorKind =
  /** The server answered a GraphQL error (`errors` with no `data`): the entry is parked. */
  | 'graphql'
  /** The transport failed in a way that will not succeed on retry (a 4xx, or `maxAttempts` spent). */
  | 'transport'
  /** The adapter failed; the store keeps working in memory and reports this. */
  | 'storage'
  /** An optimistic layer could not be rebuilt because another layer sat above it. */
  | 'stack';

/** One failure the local-first layer wants the app to see. */
export interface LocalError {
  /** Which rule produced the failure; the queue's reaction depends on it. */
  readonly kind: LocalErrorKind;
  /** The queue entry the failure belongs to, or `null` for a failure outside a delivery. */
  readonly mutationId: string | null;
  /** A human-readable message; for a GraphQL failure it is the first error's message. */
  readonly message: string;
  /** The response's GraphQL errors, when the failure carried them. */
  readonly errors: readonly GraphQLResponseError[] | null;
  /** The HTTP status of a transport failure that had one, else `null`. */
  readonly status: number | null;
  /** The clock reading of the failure. */
  readonly at: number;
}

/** The sync state a UI renders: `{ online, pending, syncing, lastSyncedAt, error }`. */
export interface LocalStatus {
  /** Whether the platform reports connectivity (and no `offline` event has arrived since). */
  readonly online: boolean;
  /** Queue entries the server has not confirmed yet. */
  readonly pending: number;
  /** A delivery pass is running. */
  readonly syncing: boolean;
  /** The clock reading of the last full drain, or `null` when the queue never drained. */
  readonly lastSyncedAt: number | null;
  /** The failure that last stopped the queue, or `null`. */
  readonly error: LocalError | null;
}

/** One queued mutation, as persisted. */
export interface StoredMutation {
  /** Stable id, unique within the queue and used by `discard()`. */
  readonly id: string;
  /** The mutation artifact, stored verbatim so replay needs no app-side registry. */
  readonly artifact: Artifact<'mutation'>;
  /** The variables the mutation was queued with. */
  readonly variables: Variables;
  /** The optimistic payload written locally, when the caller supplied one. */
  readonly optimistic?: Variables;
  /** The clock reading of the enqueue. */
  readonly createdAt: number;
  /** Delivery attempts that ended in a retryable failure. */
  readonly attempts: number;
}

/**
 * The persisted envelope: the **confirmed** cache plus the **pending** queue.
 *
 * The layer invariant is what makes a reload safe: `cache` is `client.serialize()`, which is
 * base-layer only, so it never contains a local write; the local writes are derived from `queue` on
 * restore. A snapshot can therefore never double-apply an optimistic payload.
 */
export interface LocalSnapshot {
  /** The envelope version; a different value is refused and reported as a storage error. */
  readonly v: 1;
  /** `client.serialize()` verbatim: records, links, lists, pages and `fetchedAt`. */
  readonly cache: SerializedCache;
  /** The pending mutations, oldest first. */
  readonly queue: readonly StoredMutation[];
  /** The last full drain, carried across reloads. */
  readonly lastSyncedAt: number | null;
}

/**
 * What `mutate()` did with the call.
 *
 * `TData` is the confirmed payload's type, named by the caller's artifact exactly as
 * `Client.mutate<TData>` names it; the default keeps `LocalMutationOutcome` nameable on its own.
 */
export type LocalMutationOutcome<TData = unknown> =
  /** The server confirmed it during this call, and its payload is in the cache. */
  | { readonly status: 'confirmed'; readonly id: string; readonly data: TData }
  /** It is queued (offline, or an earlier entry is still pending) and visible locally. */
  | { readonly status: 'queued'; readonly id: string }
  /** The server rejected it with a GraphQL error; it stays parked until `retry()`/`discard()`. */
  | { readonly status: 'parked'; readonly id: string; readonly error: LocalError };

/** The options of one local mutation. */
export interface LocalMutateOptions {
  /** The mutation's variables. */
  readonly variables: Variables;
  /**
   * The payload written into an optimistic layer before anything is sent, which is what makes the
   * write visible immediately and derivable after a reload. Without it the mutation is still queued,
   * but nothing changes locally until the server answers.
   */
  readonly optimistic?: Variables;
}

/** The backoff of a retryable transport failure. */
export interface LocalRetryOptions {
  /** The first retry's delay. Default `1000`. */
  readonly initialDelayMs?: number;
  /** The delay's ceiling. Default `30000`. */
  readonly maxDelayMs?: number;
  /** The multiplier between attempts. Default `2`. */
  readonly factor?: number;
}

/** The minimal event target the browser wiring attaches to; `window` satisfies it structurally. */
export interface LocalEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Schedules one delayed callback and returns its canceller; tests inject a fake timer. */
export type LocalScheduler = (run: () => void, delayMs: number) => () => void;

/** The payload of every event `LocalFirst.on()` delivers. */
export interface LocalEvents {
  /** The status changed (any field). */
  readonly change: LocalStatus;
  /** A mutation was written locally and queued. */
  readonly queued: StoredMutation;
  /** The server confirmed a queued mutation and its payload is in the cache. */
  readonly confirmed: { readonly mutation: StoredMutation; readonly data: unknown };
  /** A mutation is parked: it failed with a GraphQL error, or spent `maxAttempts`. */
  readonly parked: { readonly mutation: StoredMutation; readonly error: LocalError };
  /** Any failure, including the storage failures that do not stop the queue. */
  readonly error: LocalError;
  /** The queue drained to empty. */
  readonly synced: { readonly lastSyncedAt: number };
}

/** The event names {@link LocalFirst.subscribe} delivers. */
export type LocalEventName = keyof LocalEvents;

/**
 * One delivered event, as a discriminated union.
 *
 * The union is what keeps `subscribe()` free of assertions: the payload type follows the `type`
 * member through an ordinary `if (event.type === 'change')` check.
 */
export type LocalEvent = {
  readonly [K in LocalEventName]: { readonly type: K; readonly payload: LocalEvents[K] };
}[LocalEventName];

/** What {@link LocalFirstOptions.online} overrides. */
export type OnlineSource = () => boolean;

/**
 * How a burst of cache writes is coalesced into one adapter write.
 *
 * A navigation writes several payloads into the cache (the route's loader, a route group, a bar),
 * each in its own task, so a per-task persist wrote the whole snapshot several times per navigation.
 * The window is **trailing**: the write happens `delayMs` after the last change, but never later
 * than `maxDelayMs` after the first one, so a stream of changes cannot defer durability forever. A
 * mutation's own queue write and `pagehide`/`freeze`/a hidden tab do not wait for the window at all:
 * they call {@link LocalFirst.persist} directly.
 */
export interface LocalPersistOptions {
  /** The trailing window. Default `250`. `0` writes as soon as the current task ends. */
  readonly delayMs?: number;
  /** The ceiling on the deferral, however many changes arrive. Default `1000`. */
  readonly maxDelayMs?: number;
  /**
   * Schedules the window and returns its canceller; tests inject a fake. The default is the window
   * (`setTimeout(delayMs)`), and the write then runs at the first idle moment when the host offers
   * `requestIdleCallback`, with `delayMs` as that callback's own deadline.
   */
  readonly schedule?: LocalScheduler;
}

/** Everything {@link createLocalFirst} accepts. */
export interface LocalFirstOptions {
  /**
   * The client whose cache and transport the layer mirrors. Optional: an app that builds its client
   * inside `createFlamme()` passes {@link LocalFirst.plugin} to the factory and calls
   * {@link LocalFirst.connect} with the client it got back.
   */
  readonly client?: Client;
  /** Where the snapshot lives. Default {@link browserAdapter}: IndexedDB, then `localStorage`. */
  readonly adapter?: LocalAdapter;
  /** The adapter key of the snapshot. Default `'flamme.local.v1'`. */
  readonly key?: string;
  /** Connectivity source; default reads `navigator.onLine` and is `true` outside a browser. */
  readonly online?: OnlineSource;
  /** The backoff of a retryable transport failure. */
  readonly retry?: LocalRetryOptions;
  /** How a burst of cache writes is coalesced. Defaults to a 250 ms trailing window. */
  readonly persist?: LocalPersistOptions;
  /** Attempts before a retryable failure parks the entry. Default `Infinity`. */
  readonly maxAttempts?: number;
  /** The clock every timestamp comes from. Default `Date.now`. */
  readonly now?: () => number;
  /** The delayed-retry scheduler. Default `setTimeout`; tests inject a fake. */
  readonly schedule?: LocalScheduler;
  /**
   * The event target for the browser wiring: `online`/`offline` update the status, and
   * `pagehide`/`freeze`/`visibilitychange` persist. Default `globalThis.window`; `null` disables it.
   */
  readonly events?: LocalEventTarget | null;
}

/**
 * The local-first store: the durable cache, the queued local writes and their replay.
 *
 * ```ts
 * const local = createLocalFirst({ client, adapter: indexedDBAdapter() })
 * await local.restore()          // before the first render
 * app.use(localFirstPlugin(local))
 * await local.mutate(ToggleFavorite, { variables: { id }, optimistic: { … } })
 * ```
 */
export interface LocalFirst {
  /** The current sync state; a fresh object per change, safe to compare by reference. */
  readonly status: LocalStatus;
  /** The pending queue, oldest first. */
  readonly queue: readonly StoredMutation[];
  /** The pipeline hook that persists after every request; pass it to `createFlamme({ plugins })`. */
  readonly plugin: ClientPlugin;
  /** Binds the store to the client it mirrors, when the options carried none. */
  connect(client: Client): void;
  /**
   * Restores the durable snapshot: the confirmed cache is hydrated, the queue is adopted, and every
   * queued local write is re-applied into its own optimistic layer.
   *
   * The restore **fills, it does not replace**: a record, link, list or page this page load's fresh
   * payload already carries wins, and the snapshot supplies what it does not. `createFlamme({
   * hydrate })` hydrates that payload before `ready` (which is this promise), so the device's copy
   * of a record can never outrank the server's: after a deploy the page renders the new build's
   * values and still paints from the device whatever the payload never carried.
   *
   * Named `restore`, not `hydrate`: `hydrate` is SSR cache hydration throughout Flamme
   * (`createFlamme({ hydrate })`, `Client.hydrate`, `Cache.hydrate`), and this method does something
   * else — it brings back what this device persisted and replays it.
   */
  restore(): Promise<void>;
  /**
   * The retired name of {@link LocalFirst.restore}.
   *
   * @deprecated Use {@link LocalFirst.restore}. This member only names its replacement.
   */
  readonly hydrate: never;
  /**
   * Opens (or re-arms) the coalescing window; the adapter is written once, when it closes.
   *
   * A no-op until a client is bound, and a no-op when the cache and the queue hold nothing the
   * adapter does not already have, so a read that writes an identical payload schedules nothing.
   */
  schedulePersist(): void;
  /** Writes the confirmed cache plus the queue to the adapter, now rather than at the window. */
  persist(): Promise<void>;
  /** Sends the queued mutations in order; a no-op while offline, syncing, or parked. */
  flush(): Promise<void>;
  /** Applies a mutation locally, queues it durably, and delivers it when it is the queue's turn. */
  mutate<TData = unknown>(
    artifact: Artifact<'mutation', TData>,
    options: LocalMutateOptions,
  ): Promise<LocalMutationOutcome<TData>>;
  /** Drops a queued entry and undoes its local write; the queue becomes replayable again. */
  discard(id: string): Promise<void>;
  /** Clears the parked failure and the retry backoff, then flushes. */
  retry(): Promise<void>;
  /** Subscribes to every queue event; the returned function unsubscribes. */
  subscribe(listener: (event: LocalEvent) => void): () => void;
  /** Removes the browser listeners, cancels the retry timer and detaches from the client. */
  dispose(): void;
}
