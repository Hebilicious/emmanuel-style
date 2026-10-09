/**
 * The layered record store (§6.1, §6.2).
 *
 * Layer 0 is the base; every optimistic layer above it holds *overrides*. A lookup walks the stack
 * from the top down and stops at the first layer that has the field — or at the first layer that
 * deleted the record, which is what makes a delete in a layer shadow every layer below it without
 * copying anything.
 */
import type { ListOperation, RecordId } from '../artifact.js';
import type { CacheLayer, StorageSnapshot } from '../cache.js';
import type { SerializedRecordFields, SerializedRecordLinks } from '../serialize.js';

/** The joint resolution of one field: found or not, from the link table or the field table. */
export interface ResolvedField {
  readonly found: boolean;
  readonly link: boolean;
  readonly value: unknown;
}

/**
 * The base layer's changes since the previous drain, in the snapshot's own shape (§6.10).
 *
 * `serialize()` builds the same entries from a full flatten; a consumer that already holds the
 * previous snapshot replaces exactly these, which is what keeps a durable write proportional to what
 * changed rather than to the size of the cache.
 */
export type StorageChanges =
  | { readonly full: true }
  | {
      readonly full: false;
      /** Record id → its field entry, or `null` when the base layer no longer holds one. */
      readonly records: ReadonlyMap<RecordId, SerializedRecordFields | null>;
      /** Record id → its link entry, or `null` when the base layer no longer holds one. */
      readonly links: ReadonlyMap<RecordId, SerializedRecordLinks | null>;
      /**
       * The records whose *existence* in the base layer flipped: a record that just gained its
       * first field/link, or lost its last. A page may only reference base-layer records (§6.10
       * rule 6), so a consumer that persists pages has to re-check the pages holding one of these.
       */
      readonly existence: ReadonlySet<RecordId>;
    };

const NOT_FOUND: ResolvedField = { found: false, link: false, value: undefined };

/** Layer 0 is the base; every optimistic layer sits above it (§6.1). */
export class InMemoryStorage {
  /** The layer stack, bottom-first. Layer 0 is never removed. */
  readonly layers: CacheLayer[] = [];

  constructor() {
    const base = emptyLayer(0, false);
    this.layers.push(base);
    this.#base = base;
    this.#operations.set(base.id, base.operations);
  }

  /** Layer 0, kept as a field because every write compares its target against it. */
  #base: CacheLayer;

  /** Every record id this storage has ever written, used as the GC's candidate universe. */
  readonly #known = new Set<RecordId>();

  /** `layer.id` → that layer's append-only operation log (the same array the layer exposes). */
  readonly #operations = new Map<number, ListOperation[]>();

  // the base layer's log is registered in the constructor, before any other layer exists

  /**
   * Record ids whose base-layer entry changed since the previous {@link drainBaseChanges}.
   *
   * Only base-layer writes are recorded: `serialize()` is base-only (§6.10 rule 6), so an optimistic
   * layer's writes change nothing a snapshot carries.
   */
  readonly #dirty = new Set<RecordId>();

  /** The subset of {@link #dirty} whose base-layer existence flipped, for the page check. */
  readonly #existence = new Set<RecordId>();

  /** `true` while the base layer cannot be described as a delta: it was hydrated or reset. */
  #full = true;

  #nextLayerID = 1;

  /** The layer reads and writes resolve against when no layer is given. */
  topLayer(): CacheLayer {
    const layer = this.layers.at(-1);
    if (layer === undefined) {
      throw new Error('the storage has no layers');
    }
    return layer;
  }

  /** The base layer: the only layer serialization reads (§6.10 rule 6). */
  baseLayer(): CacheLayer {
    const layer = this.layers[0];
    if (layer === undefined) {
      throw new Error('the storage has no layers');
    }
    return layer;
  }

  /** Pushes a layer and returns it; `optimistic` records whether a mutation owns it. */
  createLayer(optimistic: boolean): CacheLayer {
    const operations: ListOperation[] = [];
    const layer: CacheLayer = {
      id: this.#nextLayerID,
      optimistic,
      fields: new Map(),
      links: new Map(),
      deleted: new Set(),
      operations,
    };
    this.#nextLayerID += 1;
    this.#operations.set(layer.id, operations);
    this.layers.push(layer);
    return layer;
  }

  /** Merges an optimistic layer into the layer below and splices it out (LIFO, §6.2). */
  resolveLayer(layer: CacheLayer): void {
    if (this.isDetached(layer)) {
      // the layer was dropped by a `reset()`/`dispose()` while a mutation was in flight: there is
      // nothing left to merge, and a late resolve is not caller error (C6)
      return;
    }
    const index = this.#topmostIndex(layer, 'resolve');
    const below = this.layers[index - 1];
    if (below === undefined) {
      throw new Error(`layer ${layer.id} cannot be resolved: there is no layer below it`);
    }
    // a resolve into the base layer is a confirmed write: every record it touches changes the
    // snapshot, and a record it creates or removes can flip a page's base-only status
    const base = below === this.#base;
    const before = base
      ? new Map<RecordId, boolean>(
          [...layer.fields.keys(), ...layer.links.keys(), ...layer.deleted].map((recordId) => [
            recordId,
            this.#exists(this.#base, recordId),
          ]),
        )
      : null;

    // deletions first: a layer's `deleted` set hides the layers below it, never its own writes
    for (const recordId of layer.deleted) {
      below.fields.delete(recordId);
      below.links.delete(recordId);
      below.deleted.add(recordId);
    }
    for (const [recordId, fields] of layer.fields) {
      const target = ensureRecord(below.fields, recordId);
      for (const [field, value] of fields) {
        target.set(field, value);
      }
    }
    for (const [recordId, links] of layer.links) {
      const target = ensureRecord(below.links, recordId);
      for (const [field, value] of links) {
        target.set(field, value);
      }
      this.#known.add(recordId);
    }
    for (const recordId of layer.fields.keys()) {
      this.#known.add(recordId);
    }
    const merged = this.#operations.get(layer.id);
    const target = this.#operations.get(below.id);
    if (merged !== undefined && target !== undefined) {
      target.push(...merged);
    }

    this.layers.splice(index, 1);
    if (before !== null) {
      for (const [recordId, existed] of before) {
        this.#mark(recordId, existed);
      }
    }
  }

  /** Drops a layer without merging it (a rollback), refusing anything but the topmost layer. */
  removeLayer(layer: CacheLayer): void {
    if (this.isDetached(layer)) {
      // a rollback of a layer a `reset()` already dropped is a no-op, not a raw Error (C6)
      return;
    }
    const index = this.#topmostIndex(layer, 'roll back');
    this.#operations.delete(layer.id);
    this.layers.splice(index, 1);
    this.#prune(layer);
  }

  /**
   * `true` when `layer` is no longer part of the stack (a `reset()`/`dispose()` dropped it while a
   * mutation still held the handle). Writes through a detached layer land in the base layer instead
   * of vanishing, so a late mutation response is not silently lost (C6).
   */
  isDetached(layer: CacheLayer): boolean {
    return !this.layers.includes(layer);
  }

  /** Resolves one field across the stack, checking both tables layer by layer. */
  resolve(recordId: RecordId, field: string, top?: CacheLayer): ResolvedField {
    let index = top === undefined ? this.layers.length - 1 : this.layers.indexOf(top);
    if (index < 0) {
      return NOT_FOUND;
    }
    for (; index >= 0; index -= 1) {
      const layer = this.layers[index];
      if (layer === undefined) {
        continue;
      }
      const link = layer.links.get(recordId);
      if (link?.has(field) === true) {
        return { found: true, link: true, value: link.get(field) };
      }
      const values = layer.fields.get(recordId);
      if (values?.has(field) === true) {
        return { found: true, link: false, value: values.get(field) };
      }
      if (layer.deleted.has(recordId)) {
        return NOT_FOUND;
      }
    }
    return NOT_FOUND;
  }

  /** The field table's value for a record/field, or `undefined` (links are read with `getLink`). */
  get(recordId: RecordId, field: string, top?: CacheLayer): unknown {
    const resolved = this.resolve(recordId, field, top);
    return resolved.found && !resolved.link ? resolved.value : undefined;
  }

  /** The link table's value for a record/field, or `null` when the field is not a link. */
  getLink(recordId: RecordId, field: string, top?: CacheLayer): string | readonly string[] | null {
    const resolved = this.resolve(recordId, field, top);
    if (!resolved.found || !resolved.link) {
      return null;
    }
    return isLinkTarget(resolved.value) ? resolved.value : null;
  }

  /** `true` when the field is present in either table and not hidden by a delete. */
  has(recordId: RecordId, field: string, top?: CacheLayer): boolean {
    return this.resolve(recordId, field, top).found;
  }

  /** `true` when the record has at least one field or link and is not hidden by a delete. */
  hasRecord(recordId: RecordId, top?: CacheLayer): boolean {
    let index = top === undefined ? this.layers.length - 1 : this.layers.indexOf(top);
    if (index < 0) {
      return false;
    }
    for (; index >= 0; index -= 1) {
      const layer = this.layers[index];
      if (layer === undefined) {
        continue;
      }
      if (layer.fields.has(recordId) || layer.links.has(recordId)) {
        return true;
      }
      if (layer.deleted.has(recordId)) {
        return false;
      }
    }
    return false;
  }

  /** Writes a scalar or an inlined embedded value into `layer`. */
  set(recordId: RecordId, field: string, value: unknown, layer: CacheLayer): void {
    const target = this.#writeTarget(layer);
    const base = target === this.#base;
    if (base && this.#holdsValue(target.fields, recordId, field, value)) {
      // writing the value the base layer already holds changes no snapshot: skipping it is what
      // keeps a re-read of an unchanged payload from scheduling a persist at all
      return;
    }
    const existed = base && this.#exists(target, recordId);
    // a field has exactly one value per layer: writing it inline drops any link the same layer held
    target.links.get(recordId)?.delete(field);
    ensureRecord(target.fields, recordId).set(field, value);
    this.#known.add(recordId);
    if (base) {
      this.#mark(recordId, existed);
    }
  }

  /** Writes a link (record id, record id array, or `null`) into `layer`. */
  setLink(
    recordId: RecordId,
    field: string,
    target: string | readonly string[] | null,
    layer: CacheLayer,
  ): void {
    const destination = this.#writeTarget(layer);
    const base = destination === this.#base;
    if (base && this.#holdsValue(destination.links, recordId, field, target)) {
      return;
    }
    // the array is copied so the caller's array is never aliased into the cache (which would make a
    // later in-place edit invisible to the copy-on-write rules of §6.5)
    const stored: string | string[] | null =
      typeof target === 'string' || target === null ? target : [...target];
    const existed = base && this.#exists(destination, recordId);
    // a field has exactly one value per layer: writing it as a link drops any inline value
    destination.fields.get(recordId)?.delete(field);
    ensureRecord(destination.links, recordId).set(field, stored);
    this.#known.add(recordId);
    if (base) {
      this.#mark(recordId, existed);
    }
  }

  /** Deletes a record in `layer`: its own writes go away and every lower layer is shadowed. */
  deleteRecord(recordId: RecordId, layer: CacheLayer): void {
    const target = this.#writeTarget(layer);
    const base = target === this.#base;
    if (base && !this.#exists(target, recordId) && target.deleted.has(recordId)) {
      // already gone from the base layer: nothing to write and nothing to re-serialize
      return;
    }
    const existed = base && this.#exists(target, recordId);
    target.fields.delete(recordId);
    target.links.delete(recordId);
    target.deleted.add(recordId);
    this.#known.add(recordId);
    if (base) {
      this.#mark(recordId, existed);
    }
  }

  /** Marks records dirty without writing them (a caller that edited a base-layer map directly). */
  markDirty(recordIds: Iterable<RecordId>): void {
    for (const recordId of recordIds) {
      this.#mark(recordId, this.#exists(this.#base, recordId));
    }
  }

  /**
   * Drains the base layer's changes since the previous call, in the snapshot's own shape (§6.10).
   *
   * `{ full: true }` means the whole base layer was replaced (a hydrate or a reset) and the caller
   * has to re-serialize; any other change is a delta keyed by record id. Both the dirty set and the
   * full flag are cleared by this call, so one change is reported exactly once.
   */
  drainBaseChanges(): StorageChanges {
    if (this.#full) {
      this.#full = false;
      this.#dirty.clear();
      this.#existence.clear();
      return { full: true };
    }
    const records = new Map<RecordId, SerializedRecordFields | null>();
    const links = new Map<RecordId, SerializedRecordLinks | null>();
    for (const recordId of this.#dirty) {
      records.set(recordId, this.#recordEntry(recordId));
      links.set(recordId, this.#linkEntry(recordId));
    }
    const existence = new Set(this.#existence);
    this.#dirty.clear();
    this.#existence.clear();
    return { full: false, records, links, existence };
  }

  /** `true` when the base layer holds an unencoded change. */
  get hasChanges(): boolean {
    return this.#full || this.#dirty.size > 0;
  }

  /** The flattened, layer-resolved field view used by reads and serialization (§6.1). */
  records(top?: CacheLayer): ReadonlyMap<RecordId, Readonly<Record<string, unknown>>> {
    return this.#flattenBoth(top).fields;
  }

  /** The flattened, layer-resolved link view. */
  links(
    top?: CacheLayer,
  ): ReadonlyMap<RecordId, Readonly<Record<string, string | string[] | null>>> {
    return this.#flattenBoth(top).links;
  }

  /** Every record id the storage has written, including ones shadowed by a layer delete. */
  knownRecords(): ReadonlySet<RecordId> {
    return this.#known;
  }

  /** Stops tracking a record: the GC's candidate universe drops it after an eviction. */
  forget(recordId: RecordId): void {
    this.#known.delete(recordId);
  }

  /**
   * Flattens both tables into plain, sorted, JSON-safe objects (§6.10).
   *
   * The two flattened views are built **once** and then walked: rebuilding them per record made this
   * O(n²) and the SSR surface unusable at a few thousand records (C4).
   */
  serialize(top?: CacheLayer): StorageSnapshot {
    const flattened = this.#flattenBoth(top);

    const records: Record<RecordId, SerializedRecordFields> = {};
    for (const recordId of sortedKeys(flattened.fields)) {
      const fields = flattened.fields.get(recordId) ?? {};
      const sorted: Record<string, unknown> = {};
      for (const field of Object.keys(fields).toSorted()) {
        sorted[field] = fields[field];
      }
      records[recordId] = sorted;
    }

    const links: Record<RecordId, SerializedRecordLinks> = {};
    for (const recordId of sortedKeys(flattened.links)) {
      const fields = flattened.links.get(recordId) ?? {};
      const sorted: Record<string, string | readonly string[] | null> = {};
      for (const field of Object.keys(fields).toSorted()) {
        sorted[field] = fields[field] ?? null;
      }
      links[recordId] = sorted;
    }

    return { records, links };
  }

  /** Writes a snapshot verbatim into the base layer, replacing whatever the base layer held. */
  hydrate(snapshot: StorageSnapshot): void {
    const base = this.baseLayer();
    base.fields.clear();
    base.links.clear();
    base.deleted.clear();
    for (const [recordId, fields] of Object.entries(snapshot.records)) {
      const target = ensureRecord(base.fields, recordId);
      for (const [field, value] of Object.entries(fields)) {
        target.set(field, value);
      }
      this.#known.add(recordId);
    }
    for (const [recordId, links] of Object.entries(snapshot.links)) {
      const target = ensureRecord(base.links, recordId);
      for (const [field, value] of Object.entries(links)) {
        const stored: string | string[] | null =
          typeof value === 'string' || value === null ? value : [...value];
        target.set(field, stored);
      }
      this.#known.add(recordId);
    }
    // the whole base layer was replaced: every previous record is gone and every hydrated one is new
    this.#full = true;
    this.#dirty.clear();
    this.#existence.clear();
  }

  /**
   * Writes a snapshot into the base layer **without clearing it**: what the base layer already
   * holds wins, and the snapshot supplies only what it does not (§6.10 rule 4).
   *
   * This is what lets a fresh SSR payload outrank a device's older durable snapshot: the payload was
   * hydrated first, so its records are already here and the restore fills the gaps around them.
   *
   * The change is reported as a **full** one: records that entered the base layer from outside the
   * cache's own write path cannot be described as a delta of it, so a consumer that encodes a
   * snapshot incrementally has to re-serialize rather than guess which of them moved.
   */
  fillMissing(snapshot: StorageSnapshot): void {
    const base = this.#base;
    let wrote = false;
    for (const [recordId, fields] of Object.entries(snapshot.records)) {
      const target = ensureRecord(base.fields, recordId);
      for (const [field, value] of Object.entries(fields)) {
        target.set(field, value);
      }
      this.#known.add(recordId);
      wrote = true;
    }
    for (const [recordId, links] of Object.entries(snapshot.links)) {
      const target = ensureRecord(base.links, recordId);
      for (const [field, value] of Object.entries(links)) {
        const stored: string | string[] | null =
          typeof value === 'string' || value === null ? value : [...value];
        target.set(field, stored);
      }
      this.#known.add(recordId);
      wrote = true;
    }
    if (wrote) {
      this.#full = true;
      this.#dirty.clear();
      this.#existence.clear();
    }
  }

  /** `type name → record ids`, derived from the flattened view's `__typename` values (§6.1). */
  get typeIndex(): ReadonlyMap<string, ReadonlySet<RecordId>> {
    const index = new Map<string, Set<RecordId>>();
    for (const [recordId, fields] of this.records()) {
      const type = fields['__typename'];
      if (typeof type !== 'string') {
        continue;
      }
      let bucket = index.get(type);
      if (bucket === undefined) {
        bucket = new Set();
        index.set(type, bucket);
      }
      bucket.add(recordId);
    }
    return index;
  }

  /** Drops every layer back to a fresh base layer. */
  reset(): void {
    this.layers.length = 0;
    const base = emptyLayer(0, false);
    this.layers.push(base);
    this.#base = base;
    this.#operations.clear();
    this.#nextLayerID = 1;
    this.#known.clear();
    // every record the previous base held is gone: there is no delta to describe that
    this.#full = true;
    this.#dirty.clear();
    this.#existence.clear();
  }

  /** Appends a list operation to a layer's audit log (`CacheLayer.operations`). */
  recordOperation(layer: CacheLayer, operation: ListOperation): void {
    this.#operations.get(layer.id)?.push(operation);
  }

  /**
   * The flattened view of both tables, built bottom-up so upper layers override lower ones. A field
   * appears in exactly one of them: writing it inline in a higher layer removes the link a lower
   * layer held (and vice versa), which is what keeps `serialize` from emitting a field twice.
   */
  #flattenBoth(top: CacheLayer | undefined): {
    readonly fields: Map<RecordId, Record<string, unknown>>;
    readonly links: Map<RecordId, Record<string, string | string[] | null>>;
  } {
    const stack =
      top === undefined ? this.layers.slice() : this.layers.slice(0, this.layers.indexOf(top) + 1);
    const fields = new Map<RecordId, Record<string, unknown>>();
    const links = new Map<RecordId, Record<string, string | string[] | null>>();

    for (const layer of stack) {
      for (const recordId of layer.deleted) {
        fields.delete(recordId);
        links.delete(recordId);
        // a layer's own writes for a deleted record are applied below, so a delete followed by a
        // write in the same layer exposes exactly the written fields
      }
      for (const [recordId, values] of layer.fields) {
        let target = fields.get(recordId);
        if (target === undefined) {
          target = {};
          fields.set(recordId, target);
        }
        const other = links.get(recordId);
        for (const [field, value] of values) {
          target[field] = value;
          if (other !== undefined) {
            delete other[field];
          }
        }
      }
      for (const [recordId, values] of layer.links) {
        let target = links.get(recordId);
        if (target === undefined) {
          target = {};
          links.set(recordId, target);
        }
        const other = fields.get(recordId);
        for (const [field, value] of values) {
          target[field] = value;
          if (other !== undefined) {
            delete other[field];
          }
        }
      }
    }
    return { fields, links };
  }

  /** The index of `layer`, refusing an out-of-order resolve or rollback (§6.2 LIFO). */
  #topmostIndex(layer: CacheLayer, action: string): number {
    const index = this.layers.indexOf(layer);
    if (index <= 0 || index !== this.layers.length - 1) {
      throw new Error(
        `Cannot ${action} layer ${layer.id}: optimistic layers are resolved in LIFO order and only the topmost layer may be ${action === 'resolve' ? 'resolved' : 'rolled back'}.`,
      );
    }
    return index;
  }

  /** Where a write lands: the layer itself, or the base layer when it was detached by a reset. */
  #writeTarget(layer: CacheLayer): CacheLayer {
    return this.isDetached(layer) ? this.baseLayer() : layer;
  }

  /** `true` when the base layer holds at least one field or link for `recordId` (§6.10 rule 6). */
  #exists(base: CacheLayer, recordId: RecordId): boolean {
    return base.fields.has(recordId) || base.links.has(recordId);
  }

  /**
   * `true` when `table` already holds exactly this value for the field.
   *
   * A field lives in one table of one layer, so an equal value in the same table means the write
   * cannot change a read or a snapshot. Values are JSON-safe by contract (§6.10), so the comparison
   * is structural for the arrays and inlined objects the writer produces.
   */
  #holdsValue(
    table: ReadonlyMap<RecordId, ReadonlyMap<string, unknown>>,
    recordId: RecordId,
    field: string,
    value: unknown,
  ): boolean {
    const fields = table.get(recordId);
    if (fields?.has(field) !== true) {
      return false;
    }
    return sameValue(fields.get(field), value);
  }

  /** Records one base-layer change, noting it when the record's existence flipped. */
  #mark(recordId: RecordId, existed: boolean): void {
    this.#dirty.add(recordId);
    if (this.#exists(this.#base, recordId) !== existed) {
      this.#existence.add(recordId);
    }
  }

  /** One record's field entry in the snapshot shape, or `null` when the base layer holds none. */
  #recordEntry(recordId: RecordId): SerializedRecordFields | null {
    const fields = this.#base.fields.get(recordId);
    return fields === undefined ? null : sortedFields(fields);
  }

  /** One record's link entry in the snapshot shape, or `null` when the base layer holds none. */
  #linkEntry(recordId: RecordId): SerializedRecordLinks | null {
    const links = this.#base.links.get(recordId);
    return links === undefined ? null : sortedLinks(links);
  }

  /**
   * Forgets the records a dropped layer introduced: `#known` is the GC's candidate universe, so a
   * record that no remaining layer holds must not inflate `recordCount` or the eviction order (C5).
   */
  #prune(layer: CacheLayer): void {
    const touched = new Set<RecordId>([
      ...layer.fields.keys(),
      ...layer.links.keys(),
      ...layer.deleted,
    ]);
    for (const recordId of touched) {
      if (!this.hasRecord(recordId)) {
        this.#known.delete(recordId);
      }
    }
  }
}

/** A fresh layer with its own tables; `operations` is the mutable array the audit log appends to. */
function emptyLayer(id: number, optimistic: boolean): CacheLayer {
  const operations: ListOperation[] = [];
  return {
    id,
    optimistic,
    fields: new Map(),
    links: new Map(),
    deleted: new Set(),
    operations,
  };
}

function ensureRecord<T>(table: Map<string, Map<string, T>>, recordId: RecordId): Map<string, T> {
  let bucket = table.get(recordId);
  if (bucket === undefined) {
    bucket = new Map();
    table.set(recordId, bucket);
  }
  return bucket;
}

/** A map's keys in canonical order, so serialization is deterministic. */
function sortedKeys<T>(map: ReadonlyMap<string, T>): string[] {
  return [...map.keys()].toSorted();
}

/** The snapshot shape of one record's fields: keys sorted, values verbatim. */
function sortedFields(fields: ReadonlyMap<string, unknown>): SerializedRecordFields {
  const sorted: Record<string, unknown> = {};
  for (const field of sortedKeys(fields)) {
    sorted[field] = fields.get(field);
  }
  return sorted;
}

/** The snapshot shape of one record's links: keys sorted, a missing value spelled `null`. */
function sortedLinks(links: ReadonlyMap<string, string | string[] | null>): SerializedRecordLinks {
  const sorted: Record<string, string | readonly string[] | null> = {};
  for (const field of sortedKeys(links)) {
    sorted[field] = links.get(field) ?? null;
  }
  return sorted;
}

/**
 * Structural equality for the JSON-safe values the cache holds: scalars, link arrays and the
 * inlined embedded objects a selection produces.
 *
 * The comparison is what makes an identical write a no-op, so it must not report `false` for equal
 * values; reporting `true` for unequal ones would drop a real write, so object key order is compared
 * by key set and value, never by order. A cycle cannot occur: every value in the cache came from a
 * JSON response or a hydration payload.
 */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => sameValue(entry, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

/** `true` when the value is a plain object, the only shape an inlined embedded selection has. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `true` when a resolved value is a link target rather than a scalar or an inlined object. */
function isLinkTarget(value: unknown): value is string | readonly string[] | null {
  return (
    typeof value === 'string' ||
    value === null ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  );
}
