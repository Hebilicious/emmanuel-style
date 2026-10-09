/**
 * `@flamme/effect/vue` — the Flamme-to-Effect direction of the seam: atoms over the same client.
 *
 * The package's main entry is Effect-shaped: queries, mutations and subscriptions as `Effect`s and
 * `Stream`s. This entry is the other half. An app builds one atom client ({@link createFlammeAtoms})
 * over its Flamme layer, installs it on the Vue app ({@link flammeAtomsPlugin}), and reads documents
 * with `useAtom` / `useAtomValue` from `@effect/atom-vue`:
 *
 * ```ts
 * // main.ts — one client for the router's loaders and for the atoms
 * const atoms = createFlammeAtoms(flammeLayer({ url: '/graphql', local }))
 * app.use(flammeAtomsPlugin(atoms))
 * app.use(createFlammeRouter({ client: atoms.client }).plugin)
 * ```
 * ```vue
 * <!-- a component: nothing here is Flamme-specific except the artifact -->
 * <script setup lang="ts">
 * import { AsyncResult, useAtomValue } from '@effect/atom-vue'
 * import { atoms } from '../atoms'
 *
 * const species = useAtomValue(() => atoms.query(Info, { id: 1 }))
 * </script>
 * <template>
 *   <p v-if="AsyncResult.isWaiting(species)">loading</p>
 *   <p v-else-if="AsyncResult.isFailure(species)">{{ species.cause }}</p>
 *   <p v-else>{{ species.value.species?.name }}</p>
 * </template>
 * ```
 *
 * Every value is the natural Effect shape: `AsyncResult` for anything that loads, `AtomResultFn`
 * for a mutation, a `Stream`-backed atom for a subscription. The Flamme-specific signals an
 * `AsyncResult` cannot carry live in {@link FlammeAtoms.meta}, one derived atom away.
 */

/* --------------------------------------------------------------------------------- the runtime */

export { createFlammeAtoms, flammeAtomsKey, flammeAtomsPlugin, useFlammeAtoms } from './app.js';
export type { FlammeAtoms, FlammeAtomsOptions } from './app.js';

/* --------------------------------------------------------------------------------- the queries */

export type { FlammeAtomMeta, QueryAtom, QueryAtomOptions } from './query.js';

/* ------------------------------------------------------------------------------- the fragments */

export type { FragmentAtom, FragmentAtomKey, FragmentKeyValue } from './fragment.js';

/* ------------------------------------------------------------------------------- the mutations */

export type { MutationAtom, MutationInput } from './mutation.js';

/* --------------------------------------------------------------------------- the subscriptions */

export type { SubscriptionAtom } from './subscription.js';

/* ---------------------------------------------------------------------------- the Effect types */

export type {
  FlammeError,
  FlammeMutationResult,
  FlammeParkedError,
  FlammeQueue,
  FlammeQueueOutcome,
} from '../index.js';
