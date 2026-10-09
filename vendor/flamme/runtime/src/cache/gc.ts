/**
 * The garbage collector (§6.11).
 *
 * Eviction is least-recently-touched first, where "touched" is a plain integer counter incremented
 * by the writer — never a timestamp, so a collection order is reproducible. Three kinds of pin are
 * honoured: the explicit `pin()` calls the client makes for mounted queries, the set the cache
 * derives from its subscription registry, list memberships and page snapshots, and anything the
 * caller chooses to protect.
 */
import type { RecordId } from '../artifact.js';

/** The budget, the candidate universe and the eviction hook the cache supplies. */
export interface GarbageCollectorOptions {
  /** Records above which a collection evicts; default 10 000. */
  readonly maxRecords?: number;
  /** Every record id the collector may evict; defaults to the ids it has been told about. */
  readonly records?: () => Iterable<RecordId>;
  /** The records that must survive this collection (live subscriptions, pages, lists, roots). */
  readonly pins?: () => Iterable<RecordId>;
  /** Called with the evicted ids, oldest first, so the cache can drop them and notify. */
  readonly onEvict?: (recordIds: readonly RecordId[]) => void;
}

const DEFAULT_MAX_RECORDS = 10_000;

/** Least-recently-touched eviction with pins. */
export class GarbageCollector {
  readonly #maxRecords: number;
  readonly #records: (() => Iterable<RecordId>) | undefined;
  readonly #pins: (() => Iterable<RecordId>) | undefined;
  readonly #onEvict: ((recordIds: readonly RecordId[]) => void) | undefined;

  /** `recordId → touch counter`; higher is more recent. */
  readonly #touched = new Map<RecordId, number>();
  readonly #explicitPins = new Set<RecordId>();
  #counter = 0;

  constructor(options: GarbageCollectorOptions = {}) {
    this.#maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.#records = options.records;
    this.#pins = options.pins;
    this.#onEvict = options.onEvict;
  }

  /** Records one write to a record (called by the writer for every record it touches). */
  touch(recordId: RecordId): void {
    this.#counter += 1;
    this.#touched.set(recordId, this.#counter);
  }

  /** The number of records under management: the caller's count, or the touched count. */
  get recordCount(): number {
    if (this.#records === undefined) {
      return this.#touched.size;
    }
    let count = 0;
    for (const recordId of this.#records()) {
      count += 1;
      void recordId;
    }
    return count;
  }

  /** The budget above which `collect` evicts. */
  get maxRecords(): number {
    return this.#maxRecords;
  }

  /** Evicts the least-recently-touched unpinned records down to the budget. */
  collect(): void {
    const candidates: RecordId[] =
      this.#records === undefined ? [...this.#touched.keys()] : [...this.#records()];
    if (candidates.length <= this.#maxRecords) {
      return;
    }

    const pinned = new Set(this.#explicitPins);
    if (this.#pins !== undefined) {
      for (const recordId of this.#pins()) {
        pinned.add(recordId);
      }
    }

    const evictable = candidates
      .filter((recordId) => !pinned.has(recordId))
      .toSorted((left, right) => {
        // never touched counts as touched first; ties break by id so the order is total
        const leftCount = this.#touched.get(left) ?? 0;
        const rightCount = this.#touched.get(right) ?? 0;
        if (leftCount !== rightCount) {
          return leftCount - rightCount;
        }
        return left < right ? -1 : left > right ? 1 : 0;
      });

    const evicted = evictable.slice(0, candidates.length - this.#maxRecords);
    if (evicted.length === 0) {
      return;
    }
    for (const recordId of evicted) {
      this.#touched.delete(recordId);
    }
    this.#onEvict?.(evicted);
  }

  /** Pins a record so no collection evicts it (a mounted query's root, a live page). */
  pin(recordId: RecordId): void {
    this.#explicitPins.add(recordId);
  }

  /** Releases a pin. */
  unpin(recordId: RecordId): void {
    this.#explicitPins.delete(recordId);
  }

  /** Forgets the eviction bookkeeping for a record. */
  forget(recordId: RecordId): void {
    this.#touched.delete(recordId);
    this.#explicitPins.delete(recordId);
  }

  /** Drops every counter and pin. */
  clear(): void {
    this.#touched.clear();
    this.#explicitPins.clear();
    this.#counter = 0;
  }
}
