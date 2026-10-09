/**
 * The client app's atom runtime: one Flamme layer, one registry, one client, and the atom factories
 * that use them.
 *
 * `createFlammeAtoms(flammeLayer({ url: '/graphql' }))` is the whole client-side wiring. The layer is
 * built once, eagerly, in the registry's own memo map: the runtime atom is kept alive for the
 * registry's whole life, so the client never goes away and never gets built twice, and
 * `registry.dispose()` (what the Vue plugin does on unmount) closes the layer's scope, which
 * disposes the client and the local-first queue and aborts whatever is in flight.
 *
 * The client is exposed because the rest of an app needs it: `createFlammeRouter({ client })` binds
 * the generated route loaders to the same client the atoms use, which is what makes a page query
 * cost one request instead of two.
 *
 * ```ts
 * // main.ts
 * const atoms = createFlammeAtoms(flammeLayer({ url: '/graphql' }))
 * app.use(flammeAtomsPlugin(atoms))
 * ```
 * ```vue
 * <!-- a component: the atoms are the same ones an Effect-only app would write -->
 * <script setup lang="ts">
 * import { useAtomValue } from '@effect/atom-vue'
 * import { AsyncResult } from '@effect/atom-vue'
 * const species = useAtomValue(() => atoms.query(Info, { id: 1 }))
 * </script>
 * ```
 */
import * as Atom from 'effect/unstable/reactivity/Atom';
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry';
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult';
import * as Cause from 'effect/Cause';
import * as Context from 'effect/Context';
import * as Option from 'effect/Option';
import type * as Layer from 'effect/Layer';

import { registryKey } from '@effect/atom-vue';
import { fragmentKey, stableStringify } from '@flamme/runtime';
import type { Artifact, ArtifactData, Client } from '@flamme/runtime';
import { inject, type App, type InjectionKey } from 'vue';

import { Flamme } from '../service.js';
import { makeFragmentAtoms, type FragmentAtom, type FragmentAtomKey } from './fragment.js';
import { asVariables, queryKey } from './keys.js';
import { mutationAtom, type MutationAtom } from './mutation.js';
import {
  makeQueryAtoms,
  type FlammeAtomMeta,
  type QueryAtom,
  type QueryAtomOptions,
} from './query.js';
import { subscriptionAtom, type SubscriptionAtom } from './subscription.js';

/** What {@link createFlammeAtoms} accepts besides the layer. */
export interface FlammeAtomsOptions {
  /** The registry the app owns. Defaults to a fresh `AtomRegistry.make()`. */
  readonly registry?: AtomRegistry.AtomRegistry | undefined;
}

/**
 * One app's atom client: the runtime, the registry, the client, and the atom factories bound to
 * them. Every factory shares its atoms by `(artifact, variables)`, so two components asking for the
 * same document get the same atom and the same request.
 */
export interface FlammeAtoms {
  /** The atom runtime every atom of this app runs in (its layer is this app's Flamme layer). */
  readonly runtime: Atom.AtomRuntime<Flamme>;
  /** The registry the app provides to `@effect/atom-vue` and disposes at unmount. */
  readonly registry: AtomRegistry.AtomRegistry;
  /** The client the layer built; hand it to `createFlammeRouter` so loaders and atoms agree. */
  readonly client: Client;
  /** One query atom, shared by `(artifact, variables)` and seeded from the cache. */
  query<TData, TInput>(
    artifact: Artifact<'query', TData, TInput>,
    variables?: TInput,
    options?: QueryAtomOptions,
  ): QueryAtom<TData>;
  /** One fragment atom over the generated `$key` a parent hands down. */
  fragment<A extends Artifact<'fragment'>>(
    artifact: A,
    key: FragmentAtomKey<A>,
  ): FragmentAtom<ArtifactData<A>>;
  /** One mutation atom: write it to run the mutation through Effect and watch `AsyncResult`. */
  mutate<TData, TInput>(artifact: Artifact<'mutation', TData, TInput>): MutationAtom<TData, TInput>;
  /** One subscription atom: the current payload of the `Stream` the subscription opens. */
  subscribe<TData, TInput>(
    artifact: Artifact<'subscription', TData, TInput>,
    variables?: TInput,
  ): SubscriptionAtom<TData>;
  /** The Flamme signals of a query or fragment atom's current cache read. */
  meta<TData>(atom: QueryAtom<TData> | FragmentAtom<TData>): Atom.Atom<FlammeAtomMeta>;
  /** Re-runs one query atom's request, keeping the current value on screen while it runs. */
  refetch<TData>(atom: QueryAtom<TData>): void;
  /** Disposes the registry: every atom finalizer runs and the client is disposed. Idempotent. */
  dispose(): void;
}

/** Builds the atom client for one Flamme layer. */
export function createFlammeAtoms(
  layer: Layer.Layer<Flamme>,
  settings: FlammeAtomsOptions = {},
): FlammeAtoms {
  const registry = settings.registry ?? AtomRegistry.make();
  // `keepAlive` is what makes the layer's lifetime the registry's: without it an idle runtime atom
  // would be disposed, closing the layer's scope and disposing the client mid-session
  const runtime = Atom.keepAlive(Atom.runtime(layer));
  const client = buildClientOf(registry, runtime);
  const queries = new Map<string, QueryAtom<unknown>>();
  const mutations = new Map<string, MutationAtom<unknown, unknown>>();
  const subscriptions = new Map<string, SubscriptionAtom<unknown>>();
  const fragments = new Map<string, FragmentAtom<unknown>>();
  /** The per-atom extras the families cannot carry: meta, and the refetch flag. */
  const extras = new WeakMap<
    object,
    { readonly meta: Atom.Atom<FlammeAtomMeta>; readonly network?: Atom.Writable<boolean> }
  >();

  return {
    runtime,
    registry,
    client,
    query<TData, TInput>(
      artifact: Artifact<'query', TData, TInput>,
      variables?: TInput,
      options: QueryAtomOptions = {},
    ): QueryAtom<TData> {
      const vars = asVariables(variables);
      const key = `${queryKey(artifact, vars)}|${options.policy ?? ''}|${options.enabled === false ? 'off' : 'on'}`;
      const existing = queries.get(key);
      if (existing !== undefined) {
        return asQueryAtom<TData>(existing);
      }
      const built = makeQueryAtoms<TData, TInput>(runtime, client, artifact, vars, options);
      // the families are type-erased: a document's data type is only known to the caller that asked
      // for it, and `ArtifactData<A>` is a conditional type a `Map` cannot carry. The one cast per
      // call restores the caller's own type.
      queries.set(key, asUnknownAtom<TData>(built.atom));
      extras.set(built.atom, { meta: built.meta, network: built.network });
      return built.atom;
    },
    fragment<A extends Artifact<'fragment'>>(
      artifact: A,
      key: FragmentAtomKey<A>,
    ): FragmentAtom<ArtifactData<A>> {
      // A fragment atom is shared like the others, which is what makes
      // `useAtomValue(() => atoms.fragment(F, keyOf(id)))` safe: the factory is re-run on every
      // render, and without sharing it would hand the component a brand-new atom each time and never
      // settle. The key's identity is the atom that carries it (`keyOf(id)`, a family) or, for a
      // plain value, the reference the value holds.
      const familyKey = `fragment|${artifact.hash}|${keyIdentity(key)}`;
      const existing = fragments.get(familyKey);
      if (existing !== undefined) {
        return asFragmentAtom<ArtifactData<A>>(existing);
      }
      const built = makeFragmentAtoms(client, artifact, key);
      fragments.set(familyKey, asUnknownFragment(built.atom));
      extras.set(built.atom, { meta: built.meta });
      return built.atom;
    },
    mutate<TData, TInput>(
      artifact: Artifact<'mutation', TData, TInput>,
    ): MutationAtom<TData, TInput> {
      const existing = mutations.get(artifact.hash);
      if (existing !== undefined) {
        return asMutationAtom<TData, TInput>(existing);
      }
      const created = mutationAtom<TData, TInput>(runtime, artifact);
      mutations.set(artifact.hash, asUnknownMutation(created));
      return created;
    },
    subscribe<TData, TInput>(
      artifact: Artifact<'subscription', TData, TInput>,
      variables?: TInput,
    ): SubscriptionAtom<TData> {
      const key = queryKey(artifact, asVariables(variables));
      const existing = subscriptions.get(key);
      if (existing !== undefined) {
        return asSubscriptionAtom<TData>(existing);
      }
      const created = subscriptionAtom<TData, TInput>(runtime, artifact, asVariables(variables));
      subscriptions.set(key, asUnknownSubscription(created));
      return created;
    },
    meta<TData>(atom: QueryAtom<TData> | FragmentAtom<TData>): Atom.Atom<FlammeAtomMeta> {
      const found = extras.get(atom);
      if (found === undefined) {
        throw new Error(
          'FlammeAtoms.meta() was given an atom this client did not build. Read the document with ' +
            '`atoms.query()` or `atoms.fragment()` and pass that atom.',
        );
      }
      return found.meta;
    },
    refetch<TData>(atom: QueryAtom<TData>): void {
      const found = extras.get(atom);
      if (found?.network === undefined) {
        throw new Error(
          'FlammeAtoms.refetch() was given an atom this client did not build. Pass the atom ' +
            '`atoms.query()` returned.',
        );
      }
      registry.set(found.network, true);
      registry.refresh(atom);
    },
    dispose(): void {
      registry.dispose();
    },
  };
}

/**
 * Builds the layer now and returns the client it provides.
 *
 * Reading the runtime atom is what builds the layer; `flammeLayer` is synchronous unless its `local`
 * is a factory that has to await, so the client exists before `createFlammeAtoms` returns and a
 * router can be bound to it in the same `main.ts`.
 */
function buildClientOf(
  registry: AtomRegistry.AtomRegistry,
  runtime: Atom.AtomRuntime<Flamme>,
): Client {
  const boot = registry.get(runtime);
  if (!AsyncResult.isSuccess(boot)) {
    throw new Error('The Flamme layer could not be built, so no client exists for this app.', {
      cause: AsyncResult.isFailure(boot) ? Cause.squash(boot.cause) : boot,
    });
  }
  return Context.get(boot.value, Flamme).client;
}

/** Identity numbers for key atoms, so a fragment family can share by the atom that carries the key. */
const keyIdentities = new WeakMap<object, number>();
let nextKeyIdentity = 1;

/** The identity of a fragment key: the atom that carries it, or the reference a plain value holds. */
function keyIdentity(key: unknown): string {
  if (Atom.isAtom(key)) {
    const known = keyIdentities.get(key);
    if (known !== undefined) {
      return `atom:${String(known)}`;
    }
    const identity = nextKeyIdentity;
    nextKeyIdentity += 1;
    keyIdentities.set(key, identity);
    return `atom:${String(identity)}`;
  }
  if (key === null || key === undefined) {
    return 'none';
  }
  const value: unknown = AsyncResult.isAsyncResult(key)
    ? Option.getOrNull(AsyncResult.value(key))
    : key;
  if (typeof value !== 'object' || value === null) {
    return 'none';
  }
  return `value:${stableStringify(Reflect.get(value, fragmentKey) ?? null)}`;
}

/* The erasure boundaries of the three families; each is the caller's own key restored. */
function asQueryAtom<TData>(atom: QueryAtom<unknown>): QueryAtom<TData> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the family is type-erased on purpose; the caller's own key restores the document's type
  return atom as QueryAtom<TData>;
}
function asUnknownAtom<TData>(atom: QueryAtom<TData>): QueryAtom<unknown> {
  return atom;
}
function asMutationAtom<TData, TInput>(
  atom: MutationAtom<unknown, unknown>,
): MutationAtom<TData, TInput> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see asQueryAtom
  return atom as MutationAtom<TData, TInput>;
}
function asUnknownMutation<TData, TInput>(
  atom: MutationAtom<TData, TInput>,
): MutationAtom<unknown, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the write type is contravariant, so the family needs the erasure
  return atom as unknown as MutationAtom<unknown, unknown>;
}
function asFragmentAtom<TData>(atom: FragmentAtom<unknown>): FragmentAtom<TData> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see asQueryAtom
  return atom as FragmentAtom<TData>;
}
function asUnknownFragment<TData>(atom: FragmentAtom<TData>): FragmentAtom<unknown> {
  return atom;
}
function asSubscriptionAtom<TData>(atom: SubscriptionAtom<unknown>): SubscriptionAtom<TData> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see asQueryAtom
  return atom as SubscriptionAtom<TData>;
}
function asUnknownSubscription<TData>(atom: SubscriptionAtom<TData>): SubscriptionAtom<unknown> {
  return atom;
}

/** The injection key {@link useFlammeAtoms} reads; the plugin provides it. */
export const flammeAtomsKey: InjectionKey<FlammeAtoms> = Symbol('flamme-atoms');

/**
 * Installs the atom client on a Vue app: `app.use(flammeAtomsPlugin(atoms))`.
 *
 * The registry is provided under `@effect/atom-vue`'s own key, which is what makes `useAtom` in a
 * `<script setup>` block read this app's atoms instead of the package's module-scope default
 * registry, and the app's unmount disposes it: every atom's finalizers run, the layer's scope closes
 * and the client is disposed.
 */
export function flammeAtomsPlugin(atoms: FlammeAtoms): { install(app: App): void } {
  return {
    install(app: App): void {
      app.provide(registryKey, atoms.registry);
      app.provide(flammeAtomsKey, atoms);
      app.onUnmount(() => {
        atoms.dispose();
      });
    },
  };
}

/** The atom client an ancestor installed. Throws when nothing was provided. */
export function useFlammeAtoms(): FlammeAtoms {
  const atoms = inject(flammeAtomsKey, null);
  if (atoms === null) {
    throw new Error(
      'No Flamme atom client was provided (FLM4013). Call `app.use(flammeAtomsPlugin(atoms))` ' +
        'before the app mounts, where `atoms` is what `createFlammeAtoms()` returned.',
    );
  }
  return atoms;
}
