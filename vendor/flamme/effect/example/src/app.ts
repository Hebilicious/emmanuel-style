/**
 * The app: one Flamme layer, one atom client, one local-first store, and the atoms the components
 * read.
 *
 * This is the whole wiring an Effect-plus-atoms app needs, and nothing in it is Flamme-specific
 * except the three artifact imports:
 *
 * ```ts
 * const app = createApp({ transport, online: () => navigator.onLine });
 * await app.ready;        // restores the durable cache and the queue
 * vueApp.use(app.plugin); // installs the atom registry and this app
 * ```
 *
 * The atoms it exposes are ordinary `@effect/atom-vue` atoms:
 *
 * - {@link App.list} is the query atom: `AsyncResult<SpeciesList$data, FlammeError>`, re-rendering
 *   from the cache whenever a row changes;
 * - {@link App.keyOf} derives one row's `$key` from that atom, so a card reads its fragment without
 *   the list passing a value down by hand;
 * - {@link App.cardOf} is the fragment atom for one row: `AsyncResult<SpeciesCard$data, FlammeError>`,
 *   which cannot see the list's own fields;
 * - {@link App.toggle} is the mutation atom: write it with `{ variables, optimistic }` and its value
 *   is `AsyncResult<{ status: 'confirmed' | 'queued' }, FlammeError>`;
 * - {@link App.queue} is the sync status the shell renders, mirrored from the store's own events.
 */
import * as Atom from 'effect/unstable/reactivity/Atom';
import type * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry';
import type * as AsyncResult from 'effect/unstable/reactivity/AsyncResult';
import { createLocalFirst, memoryAdapter } from '@flamme/local';
import type { LocalAdapter, LocalEventTarget, LocalFirst, LocalStatus } from '@flamme/local';
import { flammeLayer } from '@flamme/effect';
import type { FlammeError } from '@flamme/effect';
import { createFlammeAtoms, flammeAtomsPlugin } from '@flamme/effect/vue';
import type { FlammeAtoms, FragmentAtom, MutationAtom, QueryAtom } from '@flamme/effect/vue';
import type { TransportFn } from '@flamme/runtime';
import { inject, type App as VueApp, type InjectionKey } from 'vue';

import { SpeciesCard, SpeciesList, ToggleFavorite } from './graphql.js';
import type {
  SpeciesCardData,
  SpeciesCardKey,
  SpeciesListData,
  ToggleFavoriteData,
} from './graphql.js';

/** What {@link createApp} accepts. */
export interface AppOptions {
  /** Any `TransportFn`; the example passes the fixture's. */
  readonly transport: TransportFn;
  /** The queue's connectivity source. Defaults to "always online". */
  readonly online?: (() => boolean) | undefined;
  /** Where the durable snapshot lives. Defaults to memory, so the example needs no browser store. */
  readonly adapter?: LocalAdapter | undefined;
  /** The browser wiring for the store. Defaults to none, which keeps tests deterministic. */
  readonly events?: LocalEventTarget | null | undefined;
  /** The registry the app uses. Defaults to a fresh one. */
  readonly registry?: AtomRegistry.AtomRegistry | undefined;
}

/** One row's key, as the list atom derives it: the card reads its fragment from this. */
export type RowKeyAtom = Atom.Atom<AsyncResult.AsyncResult<SpeciesCardKey | null, FlammeError>>;

/** The atoms and the store behind the app's components. */
export interface App {
  /** The atom client every component reads. */
  readonly atoms: FlammeAtoms;
  /** The local-first store the layer routes mutations through, once the layer has been built. */
  readonly local: () => LocalFirst | null;
  /** Resolves when the durable snapshot and the queue have been restored. */
  readonly ready: Promise<void>;
  /** The query atom: the list, masked. */
  readonly list: QueryAtom<SpeciesListData>;
  /** The `$key` of one row, derived from the list atom. */
  readonly keyOf: (id: number) => RowKeyAtom;
  /** The fragment atom of one row. */
  readonly cardOf: (id: number) => FragmentAtom<SpeciesCardData>;
  /** The mutation atom. */
  readonly toggle: MutationAtom<ToggleFavoriteData, { id: number }>;
  /** The sync status the shell renders. */
  readonly queue: Atom.Atom<LocalStatus>;
  /** Installs the registry and this app on a Vue app. */
  readonly plugin: { install(app: VueApp): void };
  /** Disposes the registry, and with it the client and the queue. */
  dispose(): void;
}

/** The context key {@link useApp} reads. */
export const appKey: InjectionKey<App> = Symbol('effect-example-app');

/** The app an ancestor installed. */
export function useApp(): App {
  const app = inject(appKey, null);
  if (app === null) {
    throw new Error('The example app was not installed; call `vueApp.use(app.plugin)`.');
  }
  return app;
}

/** Builds the app over one transport. */
export function createApp(options: AppOptions): App {
  let local: LocalFirst | null = null;
  /** The store the layer built; a function, so the closure is not narrowed to `null` by the reader. */
  const localStore = (): LocalFirst | null => local;
  const atoms = createFlammeAtoms(
    flammeLayer({
      transport: options.transport,
      // the layer builds the client, so the store is built from the client it built: the one object
      // the atoms, the route loaders and the queue all share
      local: (client) => {
        const store = createLocalFirst({
          client,
          adapter: options.adapter ?? memoryAdapter(),
          online: options.online ?? (() => true),
          events: options.events ?? null,
        });
        local = store;
        return store;
      },
    }),
    options.registry === undefined ? {} : { registry: options.registry },
  );

  const list = atoms.query(SpeciesList);
  const toggle = atoms.mutate(ToggleFavorite);

  /**
   * One row's key, as an atom derived from the list atom.
   *
   * `Atom.mapResult` maps the value *inside* the `AsyncResult`, so a row's key is available exactly
   * when the list's data is, and the card re-renders when its own row changes. `Atom.family`
   * memoizes one atom per id, which is what makes `cardOf(id)` safe to call on every render.
   */
  const keyOf = Atom.family((id: number): RowKeyAtom =>
    Atom.mapResult(list, (data) => data.species.find((row) => row.id === id) ?? null),
  );

  const cardOf = Atom.family((id: number): FragmentAtom<SpeciesCardData> =>
    atoms.fragment(SpeciesCard, keyOf(id)),
  );

  // The queue's status is the store's, not the library's: the app mirrors it into an atom so a
  // component renders it with `useAtomValue` like everything else.
  const registry = atoms.registry;
  const queue = Atom.make<LocalStatus>({
    online: options.online?.() ?? true,
    pending: 0,
    syncing: false,
    lastSyncedAt: null,
    error: null,
  });
  let stopQueue: (() => void) | null = null;

  const app: App = {
    atoms,
    local: localStore,
    ready: (async () => {
      const store = localStore();
      if (store === null) {
        return;
      }
      await store.restore();
      stopQueue = store.subscribe((event) => {
        if (event.type === 'change') {
          registry.set(queue, event.payload);
        }
      });
      registry.set(queue, store.status);
    })(),
    list,
    keyOf,
    cardOf,
    toggle,
    queue,
    plugin: {
      install(vueApp: VueApp): void {
        vueApp.use(flammeAtomsPlugin(atoms));
        vueApp.provide(appKey, app);
      },
    },
    dispose(): void {
      stopQueue?.();
      stopQueue = null;
      atoms.dispose();
    },
  };

  return app;
}
