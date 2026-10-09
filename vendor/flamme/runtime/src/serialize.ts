/**
 * Serialize and hydrate (§6.10).
 *
 * There is exactly **one** wire format and it is the storage format: records plus links, exactly
 * the shape `InMemoryStorage.serialize()` produces. `Cache.serialize()` returns the same two tables
 * plus the list, page and timestamp metadata; it never interleaves links into the record table.
 */
import type { RecordId } from './artifact.js';
import type { PageInfo } from './cache.js';

/** `<document name>.<field path joined by '.'>|<root key raw>`. */
export type PageKey = string;

export interface SerializedPage {
  readonly path: readonly string[];
  readonly ids: readonly RecordId[];
  readonly edges: readonly { readonly cursor: string | null; readonly id: RecordId }[];
  readonly pageInfo: PageInfo;
  readonly complete: boolean;
  readonly mode: 'SinglePage' | 'Infinite';
}

/** One named list's membership in a snapshot, with the registration a reload needs (§6.7). */
export interface SerializedList {
  readonly type: string;
  readonly connection: boolean;
  readonly ids: readonly RecordId[];
}

/** One record's field entry: scalars and inlined embedded objects, keys sorted. */
export type SerializedRecordFields = Readonly<Record<string, unknown>>;

/** One record's link entry: `field → RecordId | RecordId[] | null`, keys sorted. */
export type SerializedRecordLinks = Readonly<Record<string, string | readonly string[] | null>>;

export interface SerializedCache {
  readonly v: 1;
  readonly compiler: string;
  /** `Record<RecordId, Record<field, value>>` — scalars and **inlined embedded objects** only. */
  readonly records: Readonly<Record<RecordId, SerializedRecordFields>>;
  /** `Record<RecordId, Record<field, RecordId | RecordId[] | null>>` — one entry per composite link. */
  readonly links: Readonly<Record<RecordId, SerializedRecordLinks>>;
  readonly lists: Readonly<Record<string, SerializedList>>;
  readonly pages: Readonly<Record<PageKey, SerializedPage>>;
  readonly fetchedAt: number;
}

/**
 * What changed in a snapshot since the previous changes were drained (§6.10).
 *
 * A consumer that writes the snapshot somewhere (a durable store, a worker, an SSR payload) keeps
 * the previous encoding and re-encodes only these entries instead of walking the cache again.
 * `full` means "this change cannot be described as a delta" (the cache was hydrated or reset) and
 * carries the whole snapshot instead, so a consumer can never silently miss a change.
 *
 * A `null` entry means the record, list or page **left** the snapshot: a record whose last field was
 * deleted, a list that stopped being registered, or a page that is no longer base-only (rule 6).
 */
export type SerializedChanges =
  | {
      readonly full: true;
      /** The whole snapshot, in `Cache.serialize()`'s shape. */
      readonly snapshot: SerializedCache;
    }
  | {
      readonly full: false;
      readonly v: 1;
      readonly compiler: string;
      readonly fetchedAt: number;
      /** Records whose field entry changed; `null` when the record left the snapshot. */
      readonly records: ReadonlyMap<RecordId, SerializedRecordFields | null>;
      /** Records whose link entry changed; `null` when the record left the snapshot. */
      readonly links: ReadonlyMap<RecordId, SerializedRecordLinks | null>;
      /** Registered lists whose registration or membership changed; `null` when unregistered. */
      readonly lists: ReadonlyMap<string, SerializedList | null>;
      /** Pages whose snapshot changed; `null` when the page left the snapshot. */
      readonly pages: ReadonlyMap<PageKey, SerializedPage | null>;
    };
