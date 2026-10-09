/**
 * The local-first sync status of the app: the §8-facing half of `createFlamme({ local })`.
 *
 * The status is part of the main surface because the whole mode is: a page that renders "offline,
 * your change is saved here" imports this composable from `@flamme/vue`, the same package it
 * imports `useMutation` and `usePageQuery` from, and never names `@flamme/local`. The store's own
 * Vue binding (`@flamme/local/vue`) stays the explicit path, for an app that installs a store
 * itself.
 *
 * Writing is deliberately absent: {@link useSyncStatus} is the read side plus the queue's controls,
 * and `useMutation` is the one mutation entry point. `useLocalFirst()` (the explicit path) still
 * exposes the store's own `mutate`.
 */
import { useLocalFirst } from '@flamme/local/vue';
import type { LocalError, LocalStatus, StoredMutation } from '@flamme/local';
import type { ComputedRef, ShallowRef } from 'vue';

/** The reactive sync state of the app's local-first store, plus the queue's controls. */
export interface SyncStatusHandle {
  /** The whole status object, replaced on every change. */
  readonly status: ShallowRef<LocalStatus>;
  /** The platform reports connectivity. */
  readonly online: ComputedRef<boolean>;
  /** Mutations the server has not confirmed yet. */
  readonly pending: ComputedRef<number>;
  /** A delivery pass is running. */
  readonly syncing: ComputedRef<boolean>;
  /** The clock reading of the last full drain, or `null`. */
  readonly lastSyncedAt: ComputedRef<number | null>;
  /** The failure that stopped the queue, or `null`. */
  readonly error: ComputedRef<LocalError | null>;
  /** The pending queue, oldest first. */
  readonly queue: ShallowRef<readonly StoredMutation[]>;
  /** Sends the queue now. */
  flush(): Promise<void>;
  /** Clears the parked failure and flushes again. */
  retry(): Promise<void>;
  /** Drops a queued entry and undoes its local write. */
  discard(id: string): Promise<void>;
}

/**
 * The local-first sync state, reactive for the template.
 *
 * ```vue
 * const { online, pending } = useSyncStatus()
 * ```
 *
 * Throws when the app has no store, which is the one thing that cannot be silent: enable the mode
 * with `createFlamme({ local: true })`.
 */
export function useSyncStatus(): SyncStatusHandle {
  const local = useLocalFirst();
  // the store's own `mutate` is deliberately absent: `useMutation` is the one mutation path of the
  // main surface (the explicit `@flamme/local/vue` handle keeps it)
  return {
    status: local.status,
    queue: local.queue,
    online: local.online,
    pending: local.pending,
    syncing: local.syncing,
    lastSyncedAt: local.lastSyncedAt,
    error: local.error,
    flush: () => local.flush(),
    retry: () => local.retry(),
    discard: (id) => local.discard(id),
  };
}
