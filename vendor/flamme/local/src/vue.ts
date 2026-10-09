/**
 * `@flamme/local/vue` — the Vue binding of the local-first layer (§8 conventions).
 *
 * `vue` is a **peer dependency of this entry point only**: `@flamme/local` itself imports nothing from
 * Vue (the runtime's rule for the framework-agnostic half), and an app that never renders the sync
 * status never loads this module. Every reactive value is a `shallowRef` written by a store
 * subscription plus `computed` selectors over it; the store and its cache are never wrapped in
 * `reactive`/`ref`, so a raw write from the queue can never bypass the cache's bookkeeping.
 *
 * ```ts
 * const local = createLocalFirst({ client })
 * await local.restore()
 * app.use(localFirstPlugin(local))
 *
 * // in a component
 * const { online, pending } = useLocalFirst()
 * const { mutate, pending: saving } = useLocalMutation()
 * ```
 *
 * The main entry point does not need any of this: `createFlamme({ local: true })` builds the store,
 * `await flamme.ready` restores it, `app.use(flamme.plugin)` installs it, and the ordinary
 * `useMutation` from `@flamme/vue` is local-first because the store is there. These exports are the
 * explicit path, for a store the app owns itself.
 */
import {
  computed,
  getCurrentScope,
  inject,
  onScopeDispose,
  shallowRef,
  type App,
  type ComputedRef,
  type InjectionKey,
  type ShallowRef,
} from 'vue';
import type { Artifact } from '@flamme/runtime';

import type {
  LocalError,
  LocalFirst,
  LocalMutationOutcome,
  LocalMutateOptions,
  LocalStatus,
  StoredMutation,
} from './types.js';

/** The injection key {@link localFirstPlugin} provides and {@link useLocalFirst} reads. */
export const LOCAL_KEY: InjectionKey<LocalFirst> = Symbol.for('flamme.local');

/** Installs a store: `app.use(localFirstPlugin(local))`. */
export function localFirstPlugin(local: LocalFirst): { install(app: App): void } {
  return {
    install(app: App): void {
      app.provide(LOCAL_KEY, local);
    },
  };
}

/** The reactive sync state and the mutating surface a component uses. */
export interface LocalFirstHandle {
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
  /**
   * Applies a mutation locally and queues it; the same call the store exposes.
   *
   * The queue-wide state is {@link LocalFirstHandle.pending}, which is not a call's lifetime: a
   * delivery pass or a queued entry elsewhere keeps it up. A control that has to disable itself
   * while its own write is on the wire wants {@link useLocalMutation} instead.
   */
  mutate<TData = unknown>(
    artifact: Artifact<'mutation', TData>,
    options: LocalMutateOptions,
  ): Promise<LocalMutationOutcome<TData>>;
  /** Sends the queue now. */
  flush(): Promise<void>;
  /** Drops a queued entry and undoes its local write. */
  discard(id: string): Promise<void>;
  /** Clears the parked failure and flushes again. */
  retry(): Promise<void>;
}

/** The store the plugin provided, or the same error `useLocalFirst` has always thrown. */
function useLocalStore(): LocalFirst {
  const local = inject(LOCAL_KEY);
  if (local === undefined) {
    throw new Error(
      'no local-first store found; enable it with createFlamme({ local: true }), or install a ' +
        'store yourself with app.use(localFirstPlugin(local)) and the store createLocalFirst() returned',
    );
  }
  return local;
}

/**
 * One mutation surface of the component: `mutate`, plus the lifetime of the calls made through it.
 *
 * This is `useMutation`'s shape (`@flamme/vue`) with the queue behind it, and it is what a control
 * needs to disable itself: `pending` is `true` only between a call through **this** handle and that
 * call's outcome, so the star does not re-enable itself because some other entry's delivery pass is
 * running, and a store that is still replaying a queued write does not disable a control that is
 * not waiting for anything.
 *
 * ```vue
 * const { mutate, pending: favoritePending } = useLocalMutation()
 * // <SpeciesPanel :favorite-pending="favoritePending" @toggle="toggleFavorite" />
 * ```
 */
export interface LocalMutationHandle {
  /** Applies a mutation locally and queues it; the same call the store exposes. */
  mutate<TData = unknown>(
    artifact: Artifact<'mutation', TData>,
    options: LocalMutateOptions,
  ): Promise<LocalMutationOutcome<TData>>;
  /**
   * A call made through this handle has not returned its outcome yet.
   *
   * The outcome is what settles it: `confirmed` and `parked` mean the delivery this call started is
   * over, and `queued` means it is in {@link LocalFirstHandle.queue} for a later pass, which the
   * queue-wide {@link LocalFirstHandle.pending} counts.
   */
  readonly pending: ComputedRef<boolean>;
  /** The outcome of the last call made through this handle, or `null`. */
  readonly result: ShallowRef<LocalMutationOutcome | null>;
}

/**
 * The per-call local mutation handle of the app's store, reactive for the template.
 *
 * ```vue
 * const { mutate, pending: favoritePending } = useLocalMutation()
 * const outcome = await mutate(ToggleFavorite, { variables: { id }, optimistic: { … } })
 * ```
 */
export function useLocalMutation(): LocalMutationHandle {
  const local = useLocalStore();
  const inFlight = shallowRef(0);
  const result = shallowRef<LocalMutationOutcome | null>(null);
  return {
    pending: computed(() => inFlight.value > 0),
    result,
    async mutate<TData = unknown>(
      artifact: Artifact<'mutation', TData>,
      options: LocalMutateOptions,
    ): Promise<LocalMutationOutcome<TData>> {
      inFlight.value += 1;
      try {
        const outcome = await local.mutate(artifact, options);
        result.value = outcome;
        return outcome;
      } finally {
        inFlight.value -= 1;
      }
    },
  };
}

/**
 * The local-first handle of the app's store, reactive for the template.
 *
 * ```vue
 * const { online, pending, mutate } = useLocalFirst()
 * ```
 */
export function useLocalFirst(): LocalFirstHandle {
  const local = useLocalStore();
  const status = shallowRef<LocalStatus>(local.status);
  const queue = shallowRef<readonly StoredMutation[]>(local.queue);
  const off = local.subscribe((event) => {
    if (event.type !== 'change') {
      return;
    }
    status.value = event.payload;
    queue.value = local.queue;
  });
  if (getCurrentScope() !== undefined) {
    onScopeDispose(off);
  }
  return {
    status,
    queue,
    online: computed(() => status.value.online),
    pending: computed(() => status.value.pending),
    syncing: computed(() => status.value.syncing),
    lastSyncedAt: computed(() => status.value.lastSyncedAt),
    error: computed(() => status.value.error),
    mutate<TData = unknown>(artifact: Artifact<'mutation', TData>, options: LocalMutateOptions) {
      return local.mutate(artifact, options);
    },
    flush: () => local.flush(),
    discard: (id) => local.discard(id),
    retry: () => local.retry(),
  };
}
