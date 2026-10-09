/**
 * The per-client document-store registry (§8.3, §8.10).
 *
 * Two components asking for the same document and variables must get **one** store, because that is
 * what makes dedupe, the cache subscription and teardown correct: the first subscriber starts it, the
 * last release runs `cleanup()` and drops the entry. The registry is keyed by the *client instance*
 * in a `WeakMap`, so it is per app/request and never a module-level cache of records (D6, SSR
 * pitfall 1); a client that goes away takes its registry with it.
 */
import type { Artifact, ArtifactKind, Client, DocumentStore, Variables } from '@flamme/runtime';

import { storeKey } from './keys.js';

/** One shared store: its identity, its subscribers and whether the initial request ran. */
export interface StoreEntry<TData> {
  /** The one `DocumentStore` every composable with these variables talks to. */
  readonly store: DocumentStore<TData>;
  /** The registry key (`artifact.hash` plus the stable variables). */
  readonly key: string;
  /** Live composables holding this entry. */
  refs: number;
  /** `true` once the initial `send` has been issued, so two mounts make one request. */
  started: boolean;
}

/**
 * The registry is type-erased: a store's data type is only known to the composable that acquired it,
 * and `ArtifactData<A>` is a deferred conditional type that cannot be carried through a `Map`.
 */
type StoredEntry = StoreEntry<unknown>;

/** Restores the caller's own data type at the one erasure boundary of this module. */
function asTyped<TData>(entry: StoredEntry): StoreEntry<TData> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the registry is type-erased on purpose; the caller's own handle restores the data type
  return entry as StoreEntry<TData>;
}

/** Client instance → its registry. Never holds records, only stores the client owns anyway. */
const registries = new WeakMap<Client, Map<string, StoredEntry>>();

/** The registry of one client, created on first use. */
function registryOf(client: Client): Map<string, StoredEntry> {
  let registry = registries.get(client);
  if (registry === undefined) {
    registry = new Map();
    registries.set(client, registry);
  }
  return registry;
}

/**
 * Returns the shared entry for `(artifact, variables)`, creating and observing the store with a
 * synchronous cache seed on first use. `seed` is the value the store starts with, which is what makes
 * the first render on the server (and the first render after hydration) read the cache directly.
 */
export function acquireStore<TData>(
  client: Client,
  artifact: Artifact<ArtifactKind, TData>,
  variables: Variables,
  seed: TData | null,
): StoreEntry<TData> {
  const key = storeKey(artifact, variables);
  const registry = registryOf(client);
  const existing = registry.get(key);
  if (existing !== undefined) {
    existing.refs += 1;
    return asTyped<TData>(existing);
  }
  const store = client.observe<TData>({ artifact, variables, initialValue: seed });
  const entry: StoreEntry<TData> = { store, key, refs: 1, started: false };
  registry.set(key, entry);
  return entry;
}

/** Drops one reference; the last one cleans the store up and forgets the entry (§8.10). */
export function releaseStore(client: Client, entry: StoreEntry<unknown>): void {
  entry.refs -= 1;
  if (entry.refs > 0) {
    return;
  }
  const registry = registries.get(client);
  if (registry?.get(entry.key) === entry) {
    registry.delete(entry.key);
  }
  entry.store.cleanup();
}
