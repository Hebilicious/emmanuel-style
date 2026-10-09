/**
 * Types shared by the cache's internal modules. Nothing here is exported from `index.ts`: the public
 * surface is the §6 declarations in `../cache.ts`, and these are the seams between the reader, the
 * writer, the storage, the subscription registry and the page helpers.
 */
import type { RecordId, SubscriptionSelection, Variables } from '../artifact.js';
import type { CacheConfig } from '../cache.js';
import type { GarbageCollector } from './gc.js';
import type { ListManager } from './lists.js';
import type { InMemoryStorage } from './storage.js';
import type { StaleManager } from './stale.js';

/** One `(record, field)` pair: the unit of both the dirty set and the subscription index (§6.12). */
export type FieldRef = readonly [recordId: RecordId, field: string];

/** Everything the reader needs from the cache. */
export interface ReadContext {
  readonly config: CacheConfig;
  readonly storage: InMemoryStorage;
  readonly lists: ListManager;
  readonly stale: StaleManager;
  /** The registered fragment selections, keyed by fragment name (see `Cache.registerFragment`). */
  readonly fragments: ReadonlyMap<string, SubscriptionSelection>;
  /** `config.staleTime`, resolved once. */
  readonly staleTime: number | 'infinite';
}

/** Everything the writer needs from the cache. */
export interface WriteContext extends ReadContext {
  readonly gc: GarbageCollector;
}

/** What one reader call produced: the data plus the fields it resolved, for the registry’s index. */
export interface ReadOutcome {
  readonly data: unknown;
  readonly refs: readonly FieldRef[];
}

/** What one writer call produced, before the registry turns `changes` into dirty keys. */
export interface WriteOutcome {
  readonly records: readonly RecordId[];
  readonly fields: readonly string[];
  readonly changes: readonly FieldRef[];
}

/** Reads a selection, reporting the `(record, field)` pairs it resolved. */
export type SelectionReader = (
  context: ReadContext,
  options: {
    readonly selection: SubscriptionSelection;
    readonly parent: RecordId;
    readonly variables: Variables;
    readonly previous?: unknown;
  },
) => ReadOutcome;
