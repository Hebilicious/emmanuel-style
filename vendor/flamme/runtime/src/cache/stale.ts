/**
 * The stale manager (§6.9).
 *
 * Staleness is invalidation-driven by default (`staleTime: 'infinite'`): a record is stale when it
 * was marked stale by a mutation, a layer rollback, `refresh` or `markTypeStale`, and a write makes
 * the written field fresh again. Time-based staleness is opt-in and takes its clock from the
 * injected `clock`, so no cache logic reads `Date.now()` and every test can be deterministic.
 */
import type { RecordId } from '../artifact.js';

/** Layer 0 is the base layer (§6.1); only it reaches a snapshot, so only it is tracked here. */
const BASE_LAYER_ID = 0;

/** The clock and the two lookups the manager needs from the cache that owns it. */
export interface StaleManagerOptions {
  /** Monotonic millisecond source; defaults to `Date.now`. Tests inject a fake. */
  readonly clock?: () => number;
  /** `type → record ids`, for `markTypeStale` (§6.9). */
  readonly typeIndex?: () => ReadonlyMap<string, ReadonlySet<RecordId>>;
  /** Called by `refresh` so the cache can mark every touching key dirty (§6.12 rule 7). */
  readonly onRefresh?: (recordIds: readonly RecordId[]) => void;
}

/** The per-field staleness bookkeeping for one cache instance. */
export class StaleManager {
  readonly #clock: () => number;
  readonly #typeIndex: (() => ReadonlyMap<string, ReadonlySet<RecordId>>) | undefined;
  readonly #onRefresh: ((recordIds: readonly RecordId[]) => void) | undefined;

  /** `recordId → field → the write times recorded for it, oldest layer first`. */
  readonly #fieldTimes = new Map<RecordId, Map<string, { readonly layer: number; readonly time: number }[]>>();
  /** Records marked stale as a whole. */
  readonly #staleRecords = new Set<RecordId>();
  /** `${recordId}\u0000${field}` pairs marked stale individually. */
  readonly #staleFields = new Set<string>();
  /** The write time of a hydrated snapshot, materialized lazily (§6.10 rule 5). */
  #snapshotTime: number | null = null;
  /**
   * The latest write time recorded **in the base layer**, so `fetchedAt(0)` is a read rather than a
   * walk of every field time. The base layer is layer 0 and is never dropped, which is what keeps
   * the maximum monotonic; `clear()` is the only reset.
   */
  #latestBase: number | null = null;

  constructor(options: StaleManagerOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#typeIndex = options.typeIndex;
    this.#onRefresh = options.onRefresh;
  }

  /** Marks every field of a record stale, whatever its write time. */
  markRecordStale(recordId: RecordId): void {
    this.#staleRecords.add(recordId);
  }

  /** Marks one field stale (a rolled-back layer's writes, §6.2). */
  markFieldStale(recordId: RecordId, field: string): void {
    this.#staleFields.add(fieldKey(recordId, field));
  }

  /** Marks every record of `type` (walking the storage's type index) stale. */
  markTypeStale(type: string): void {
    const records = this.#typeIndex?.().get(type);
    if (records === undefined) {
      return;
    }
    for (const recordId of records) {
      this.#staleRecords.add(recordId);
    }
  }

  /** The write time of a field, the hydrated snapshot time, or `null` when unknown. */
  getFieldTime(recordId: RecordId, field: string): number | null {
    const times = this.#fieldTimes.get(recordId)?.get(field);
    const latest = times?.at(-1);
    if (latest !== undefined) {
      return latest.time;
    }
    return this.#snapshotTime;
  }

  /** Records an explicit write time and clears the field's staleness. */
  setFieldTime(recordId: RecordId, field: string, time: number): void {
    this.#record(recordId, field, time, 0);
  }

  /** Stamps `now` onto a written field and makes it fresh (called by the writer). */
  markFresh(recordId: RecordId, field: string, layer: number): void {
    this.#record(recordId, field, this.#clock(), layer);
  }

  #record(recordId: RecordId, field: string, time: number, layer: number): void {
    let fields = this.#fieldTimes.get(recordId);
    if (fields === undefined) {
      fields = new Map();
      this.#fieldTimes.set(recordId, fields);
    }
    const times = fields.get(field) ?? [];
    times.push({ layer, time });
    fields.set(field, times);
    if (layer === BASE_LAYER_ID && (this.#latestBase === null || time > this.#latestBase)) {
      this.#latestBase = time;
    }
    this.#staleFields.delete(fieldKey(recordId, field));
    this.#staleRecords.delete(recordId);
  }

  /** Forgets every time a rolled-back layer recorded, so the lower layer's time is visible again. */
  dropLayer(layer: number): void {
    for (const fields of this.#fieldTimes.values()) {
      for (const [field, times] of fields) {
        const kept = times.filter((entry) => entry.layer !== layer);
        if (kept.length === 0) {
          fields.delete(field);
        } else {
          fields.set(field, kept);
        }
      }
    }
  }

  /** Marks the records stale and notifies every spec that touches them (§6.12 rule 7). */
  refresh(recordId: RecordId | readonly RecordId[]): void {
    const records = typeof recordId === 'string' ? [recordId] : recordId;
    for (const id of records) {
      this.#staleRecords.add(id);
    }
    this.#onRefresh?.(records);
  }

  /** `true` when the record/field was invalidated or its write time is older than `staleTime`. */
  isStale(recordId: RecordId, field: string, staleTime: number | 'infinite'): boolean {
    if (this.#staleRecords.has(recordId) || this.#staleFields.has(fieldKey(recordId, field))) {
      return true;
    }
    if (staleTime === 'infinite') {
      return false;
    }
    const time = this.getFieldTime(recordId, field);
    return time !== null && this.#clock() - time > staleTime;
  }

  /** Drops every mark and timestamp. */
  clear(): void {
    this.#fieldTimes.clear();
    this.#staleRecords.clear();
    this.#staleFields.clear();
    this.#snapshotTime = null;
    this.#latestBase = null;
  }

  /** Removes every trace of an evicted record. */
  forget(recordId: RecordId): void {
    this.#fieldTimes.delete(recordId);
    this.#staleRecords.delete(recordId);
    const prefix = `${recordId}\u0000`;
    for (const key of this.#staleFields) {
      if (key.startsWith(prefix)) {
        this.#staleFields.delete(key);
      }
    }
  }

  /** The write time hydration stamps on every record (§6.10 rule 5). */
  setSnapshotTime(time: number): void {
    this.#snapshotTime = time;
  }

  /**
   * The snapshot's `fetchedAt`: the hydrated time, the last **base layer** write time, or the clock.
   * Optimistic layers are dropped at serialize time (§6.10 rule 6), so their write times are too.
   */
  fetchedAt(baseLayer?: number): number {
    if (baseLayer === BASE_LAYER_ID) {
      // the common call: `Cache.serialize` passes the base layer, and the tracked maximum is exact
      return this.#snapshotTime ?? this.#latestBase ?? this.#clock();
    }
    let latest: number | null = null;
    for (const fields of this.#fieldTimes.values()) {
      for (const times of fields.values()) {
        for (const entry of times) {
          if (baseLayer !== undefined && entry.layer !== baseLayer) {
            continue;
          }
          if (latest === null || entry.time > latest) {
            latest = entry.time;
          }
        }
      }
    }
    return this.#snapshotTime ?? latest ?? this.#clock();
  }
}

function fieldKey(recordId: RecordId, field: string): string {
  return `${recordId}\u0000${field}`;
}

/** The one place this package reads a wall clock; every test injects its own instead. */
function systemClock(): number {
  return Date.now();
}
