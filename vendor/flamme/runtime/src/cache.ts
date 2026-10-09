/**
 * The normalized cache (§6, D4): the §6 declarations of the public cache surface.
 *
 * The interfaces (`CacheLayer`, `CacheConfig`, `ReadOptions`, `WriteOptions`, `ListHandle`,
 * `ConnectionSnapshot`, …) are declared here and are the contract every other package compiles
 * against; the classes and functions are implemented under `./cache/**` and re-exported from this
 * module, so `@flamme/runtime` exposes exactly the §6 names. `RecordId`, `FragmentKey` and
 * `Variables` are the §3.2 declarations, imported rather than re-declared (F9).
 */
import type {
  FragmentKey,
  ListOperation,
  RecordId,
  SubscriptionSelection,
  Variables,
} from './artifact.js';

export interface CacheLayer {
  readonly id: number;
  readonly optimistic: boolean;
  /** recordId → field → value */
  readonly fields: Map<string, Map<string, unknown>>;
  /** recordId → field → record id(s) */
  readonly links: Map<string, Map<string, string | string[] | null>>;
  readonly deleted: Set<RecordId>;
  /**
   * Every `@list` operation this layer recorded, in application order. Mutable on purpose: the
   * runtime appends through `storage.recordOperation`, so a holder (a plugin, `serialize`) sees the
   * layer's real log rather than a copy frozen at the moment it was read
   * (`review-slice34-adversarial.md` M10).
   */
  readonly operations: ListOperation[];
}

export interface StorageSnapshot {
  readonly records: Readonly<Record<RecordId, Readonly<Record<string, unknown>>>>;
  readonly links: Readonly<
    Record<RecordId, Readonly<Record<string, string | readonly string[] | null>>>
  >;
}

export { InMemoryStorage } from './cache/storage.js';

/** The facade over the storage: the only cache object the rest of the runtime touches. */
export { Cache } from './cache/index.js';

/** Builds a field key from the field name and its arguments, with argument names sorted. */
export { computeKey } from './cache/keys.js';
/** Resolves `$var` occurrences in a `keyRaw` while tracking string state. */
export { evaluateKey } from './cache/keys.js';
/** Joins the key field values with `__`, or falls back for a key-less connection field (§6.3). */
export { computeID } from './cache/keys.js';
/** `config.keys[type]` → `config.defaultKeys` → `['id']`, filtered to fields the type has. */
export { keyFieldsForType } from './cache/keys.js';

export interface CacheConfig {
  /** Type name → key fields. Produced by the compiler (schema `@key` wins over `config.types`) and passed in. */
  readonly keys?: Readonly<Record<string, readonly string[]>>;
  readonly defaultKeys?: readonly string[];
  readonly scalars?: Readonly<Record<string, { readonly unmarshal?: (value: unknown) => unknown }>>;
  /** Milliseconds after which a read is stale. Default `'infinite'`: staleness is invalidation-driven. */
  readonly staleTime?: number | 'infinite';
  readonly gc?: { readonly maxRecords?: number };
}

export interface ReadOptions {
  readonly selection: SubscriptionSelection;
  /** Default `_ROOT_`. */
  readonly parent?: RecordId;
  readonly variables?: Variables;
  /** `true` (the default) returns only `visible` fields plus the ` $fragments` marker. */
  readonly mask?: boolean;
  /** Produce a loading frame instead of stored values (D3). */
  readonly loading?: boolean;
  /**
   * Previous snapshot for structural sharing (§6.5 rule 1). Supplied by the **subscription
   * registry**, which owns one last-snapshot slot per `FragmentKey`; a caller that reads without
   * going through a subscription passes nothing and gets a fresh object graph.
   */
  readonly previous?: unknown;
  readonly layer?: CacheLayer;
}

export interface ReadResult<TData> {
  readonly data: TData | null;
  readonly partial: boolean;
  readonly stale: boolean;
  readonly hasData: boolean;
  /** Field keys actually resolved; the registry uses this for field-level granularity. */
  readonly readFields: readonly string[];
}

export interface WriteOptions {
  readonly selection: SubscriptionSelection;
  readonly data: unknown;
  readonly parent?: RecordId;
  readonly variables?: Variables;
  readonly layer?: CacheLayer;
  readonly applyUpdates?: readonly ('append' | 'prepend')[];
}

export interface WriteResult {
  readonly records: readonly RecordId[];
  readonly fields: readonly string[];
  /** Fragment keys whose data changed because of this write (§6.12). */
  readonly dirty: readonly FragmentKey[];
}

export interface SubscriptionSpec {
  readonly key: FragmentKey;
  readonly rootType: string;
  readonly selection: SubscriptionSelection;
  readonly parentID: RecordId;
  readonly variables: () => Variables;
  readonly onMessage: (message: CacheMessage) => void;
}

export type CacheMessage =
  | { readonly kind: 'update'; readonly data: unknown }
  | { readonly kind: 'refetch'; readonly session?: unknown };

export { CacheSubscriptions } from './cache/subscriptions.js';

export { ListManager, opaqueListID } from './cache/lists.js';

export interface ListHandle {
  readonly name: string;
  readonly type: string;
  readonly connection: boolean;
  insert(recordId: RecordId, position: 'first' | 'last', options?: { layer?: CacheLayer }): void;
  remove(recordId: RecordId, options?: { layer?: CacheLayer }): void;
  toggle(recordId: RecordId, options?: { layer?: CacheLayer }): void;
  upsert(recordId: RecordId, position: 'first' | 'last', options?: { layer?: CacheLayer }): void;
  delete(recordId: RecordId, options?: { layer?: CacheLayer }): void;
  /** In-place field edit on a list entry, applied as a layer write. */
  modify(
    recordId: RecordId,
    fields: Readonly<Record<string, unknown>>,
    options?: { layer?: CacheLayer },
  ): void;
  ids(): readonly RecordId[];
}

export interface ListSnapshot {
  readonly name: string;
  readonly type: string;
  readonly connection: boolean;
  readonly ids: readonly RecordId[];
}

export interface PageInfo {
  readonly startCursor: string | null;
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
}

export interface ConnectionSnapshot {
  readonly path: readonly string[];
  readonly ids: readonly RecordId[];
  readonly edges: readonly { readonly cursor: string | null; readonly id: RecordId }[];
  readonly pageInfo: PageInfo;
  readonly complete: boolean;
}

export { extractPageInfo } from './cache/pages.js';

/**
 * The imperative page helpers the Vue layer builds its handle on. Deliberately **not reactive**:
 * `runtime` has no Vue dependency (§2.2 rule 3).
 */
export { countPage, cursorHandlers, offsetHandlers } from './cache/pages.js';
export type { OffsetHandlers } from './cache/pages.js';

export { StaleManager } from './cache/stale.js';

export { GarbageCollector } from './cache/gc.js';
