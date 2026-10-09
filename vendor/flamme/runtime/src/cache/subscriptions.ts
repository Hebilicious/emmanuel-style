/**
 * The subscription registry (§6.6, E.1).
 *
 * One entry per `FragmentKey` holds the listeners, the `(record, field)` pairs the key reads, and
 * the last snapshot handed to a listener. The pairs are the reverse index that makes a write's dirty
 * set O(changed fields) instead of O(subscriptions), the snapshot is what gives reads structural
 * sharing (§6.5 rule 1), and both are dropped in the same step as the refcount reaches zero, so the
 * registry is never a leak surface or a GC barrier.
 */
import type { FragmentKey, RecordId, SubscriptionSelection, Variables } from '../artifact.js';
import type { CacheMessage, SubscriptionSpec } from '../cache.js';
import type { FieldRef } from './internal.js';
import { evaluateKey } from './keys.js';
import { LIST_IDS_FIELD, listRecordId } from './lists.js';

/** What one registry read produced: the data and the fields it resolved. */
export interface SnapshotRead {
  readonly data: unknown;
  readonly refs: readonly FieldRef[];
}

/** The read and the link lookup the registry needs from the cache that owns it. */
export interface CacheSubscriptionsOptions {
  /** Reads a key's selection; called with the key's last snapshot as `previous`. */
  readonly read?: (spec: SubscriptionSpec, previous: unknown) => SnapshotRead;
  /** Resolves a link so the initial index can follow it (`null` when the field is not a link). */
  readonly lookup?: (recordId: RecordId, field: string) => string | readonly string[] | null;
  /**
   * Called once per listener that threw, after the flush finished delivering every message. The
   * flush never aborts and never rethrows (C2); without a sink the failures are reported once
   * through `console.error`.
   */
  readonly onListenerError?: (error: unknown, key: FragmentKey) => void;
}

/** One live key: its spec, its listeners, its field index and its last snapshot slot. */
interface Entry {
  readonly spec: SubscriptionSpec;
  readonly listeners: Set<(message: CacheMessage) => void>;
  refs: readonly FieldRef[];
  snapshot: unknown;
  hasSnapshot: boolean;
}

/** The refcounted, microtask-coalesced registry behind `Cache.subscribe`. */
export class CacheSubscriptions {
  readonly #entries = new Map<FragmentKey, Entry>();
  /** `recordId → field → keys`: the reverse index the dirty set is computed from. */
  readonly #fieldSubs = new Map<RecordId, Map<string, Set<FragmentKey>>>();
  /** `recordId → keys`: every key that reads the record, for record-level invalidation (rule 3). */
  readonly #recordSubs = new Map<RecordId, Set<FragmentKey>>();
  readonly #dirty = new Set<FragmentKey>();
  readonly #read: ((spec: SubscriptionSpec, previous: unknown) => SnapshotRead) | undefined;
  readonly #lookup: ((recordId: RecordId, field: string) => string | readonly string[] | null) | undefined;

  /**
   * Optional sink for a listener that threw. Assignable after construction (the `Cache` facade
   * forwards its own property here), so a caller can install one whenever it wants.
   */
  onListenerError: ((error: unknown, key: FragmentKey) => void) | undefined;

  #scheduled = false;
  #flushes = 0;

  constructor(options: CacheSubscriptionsOptions = {}) {
    this.#read = options.read;
    this.#lookup = options.lookup;
    this.onListenerError = options.onListenerError;
  }

  /** Refcounts a listener under its key; the returned function is idempotent. */
  subscribe(spec: SubscriptionSpec): () => void {
    let entry = this.#entries.get(spec.key);
    if (entry === undefined) {
      entry = { spec, listeners: new Set(), refs: [], snapshot: undefined, hasSnapshot: false };
      this.#entries.set(spec.key, entry);
      // the initial index follows the links the cache already holds; every later read re-indexes
      entry.refs = this.#walk(spec);
      this.#index(spec.key, entry.refs);
    }

    const listener = (message: CacheMessage): void => {
      spec.onMessage(message);
    };
    entry.listeners.add(listener);

    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      const current = this.#entries.get(spec.key);
      if (current === undefined) {
        return;
      }
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        // the refcount reached zero: the index entries and the snapshot slot go with it
        this.#unindex(spec.key, current);
        this.#entries.delete(spec.key);
        this.#dirty.delete(spec.key);
      }
    };
  }

  /** Queues the given keys and schedules exactly one microtask flush. */
  markDirty(keys: Iterable<FragmentKey>): void {
    let added = false;
    for (const key of keys) {
      if (this.#entries.has(key)) {
        this.#dirty.add(key);
        added = true;
      }
    }
    if (!added || this.#scheduled) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      this.flush();
    });
  }

  /** Rebuilds and delivers every pending key now instead of on the next microtask. */
  flush(): void {
    this.#scheduled = false;
    const keys = [...this.#dirty];
    this.#dirty.clear();
    // the epoch advances once per flush, whether or not a listener ends up being called (§6.12 rule 9)
    this.#flushes += 1;
    const failures: { readonly error: unknown; readonly key: FragmentKey }[] = [];

    for (const key of keys) {
      const entry = this.#entries.get(key);
      if (entry === undefined) {
        continue;
      }
      const previous = entry.hasSnapshot ? entry.snapshot : undefined;
      const outcome = this.#read?.(entry.spec, previous) ?? { data: undefined, refs: entry.refs };
      // Every cycle re-indexes from the read **and** from a fresh walk of the selection: a read of a
      // record that is missing (or an empty read) must never leave the key without an index, or a
      // later write could not reach it again (C1).
      this.#reindex(key, entry, mergeRefs(outcome.refs, this.#walk(entry.spec)));

      if (entry.hasSnapshot && Object.is(outcome.data, entry.snapshot)) {
        // an identical snapshot costs a selector re-evaluation, never a listener call (rule 9)
        continue;
      }
      entry.snapshot = outcome.data;
      entry.hasSnapshot = true;
      // copied before iterating: a listener may unsubscribe during notification (E.1)
      for (const listener of Array.from(entry.listeners)) {
        try {
          listener({ kind: 'update', data: outcome.data });
        } catch (error) {
          // one component's exception must not starve every later listener in the same flush, and
          // the flush runs in a microtask, so rethrowing would surface as an uncaught error (C2)
          failures.push({ error, key });
        }
      }
    }

    this.#reportFailures(failures);
  }

  /** Surfaces the flush's listener failures without ever throwing out of the flush (C2). */
  #reportFailures(failures: readonly { readonly error: unknown; readonly key: FragmentKey }[]): void {
    if (failures.length === 0) {
      return;
    }
    const hook = this.onListenerError;
    if (hook !== undefined) {
      for (const failure of failures) {
        try {
          hook(failure.error, failure.key);
        } catch {
          // a broken sink must not lose the remaining failures or abort the caller's flush
        }
      }
      return;
    }
    console.error(
      `[flamme] ${failures.length} cache listener${failures.length === 1 ? '' : 's'} threw during a flush; every other listener was still notified.`,
      failures,
    );
  }

  /** Drops every listener, index entry and snapshot slot. */
  clear(): void {
    this.#entries.clear();
    this.#fieldSubs.clear();
    this.#recordSubs.clear();
    this.#dirty.clear();
  }

  /** The number of live listeners across every key: the refcount (§6.6). */
  get size(): number {
    let total = 0;
    for (const entry of this.#entries.values()) {
      total += entry.listeners.size;
    }
    return total;
  }

  /** How many flushes have run; the cache exposes this as its monotonic `epoch`. */
  get flushes(): number {
    return this.#flushes;
  }

  /** The keys whose registered fields include one of these `(record, field)` pairs (§6.12 rule 2). */
  keysForChanges(changes: Iterable<FieldRef>): FragmentKey[] {
    const keys = new Set<FragmentKey>();
    for (const [recordId, field] of changes) {
      const bucket = this.#fieldSubs.get(recordId)?.get(field);
      if (bucket === undefined) {
        continue;
      }
      for (const key of bucket) {
        keys.add(key);
      }
    }
    return [...keys];
  }

  /** Every key that reads one of these records, whatever field it selected (§6.12 rule 3). */
  keysForRecords(records: Iterable<RecordId>): FragmentKey[] {
    const keys = new Set<FragmentKey>();
    for (const recordId of records) {
      const bucket = this.#recordSubs.get(recordId);
      if (bucket === undefined) {
        continue;
      }
      for (const key of bucket) {
        keys.add(key);
      }
    }
    return [...keys];
  }

  /** The records the live keys read, which the cache pins before garbage collection (§6.11). */
  pinnedRecords(): ReadonlySet<RecordId> {
    const records = new Set<RecordId>();
    for (const entry of this.#entries.values()) {
      for (const [recordId] of entry.refs) {
        records.add(recordId);
      }
    }
    return records;
  }

  /** The field index a fresh key starts from: a walk of its selection, following known links. */
  #walk(spec: SubscriptionSpec): readonly FieldRef[] {
    const refs: FieldRef[] = [];
    const variables: Variables = spec.variables();
    const walk = (selection: SubscriptionSelection, recordId: RecordId): void => {
      for (const field of Object.values(selection.fields ?? {})) {
        if (field.visible !== true) {
          continue;
        }
        const fieldKey = evaluateKey(field.keyRaw, variables);
        if (field.list !== undefined) {
          refs.push([listRecordId(field.list.name), LIST_IDS_FIELD]);
        } else {
          refs.push([recordId, fieldKey]);
        }
        if (field.selection === undefined || field.list?.connection === true) {
          continue;
        }
        const link = this.#lookup?.(recordId, fieldKey);
        if (typeof link === 'string') {
          walk(field.selection, link);
        } else if (Array.isArray(link)) {
          for (const target of link) {
            walk(field.selection, target);
          }
        }
      }
    };
    walk(spec.selection, spec.parentID);
    return refs;
  }

  /** Replaces a key's index entries with the pairs its latest read resolved. */
  #reindex(key: FragmentKey, entry: Entry, refs: readonly FieldRef[]): void {
    this.#unindex(key, entry);
    entry.refs = refs;
    this.#index(key, refs);
  }

  #index(key: FragmentKey, refs: readonly FieldRef[]): void {
    for (const [recordId, field] of refs) {
      let fields = this.#fieldSubs.get(recordId);
      if (fields === undefined) {
        fields = new Map();
        this.#fieldSubs.set(recordId, fields);
      }
      let keys = fields.get(field);
      if (keys === undefined) {
        keys = new Set();
        fields.set(field, keys);
      }
      keys.add(key);

      let records = this.#recordSubs.get(recordId);
      if (records === undefined) {
        records = new Set();
        this.#recordSubs.set(recordId, records);
      }
      records.add(key);
    }
  }

  #unindex(key: FragmentKey, entry: Entry): void {
    for (const [recordId, field] of entry.refs) {
      const fields = this.#fieldSubs.get(recordId);
      const keys = fields?.get(field);
      keys?.delete(key);
      if (keys !== undefined && keys.size === 0) {
        fields?.delete(field);
      }
      if (fields !== undefined && fields.size === 0) {
        this.#fieldSubs.delete(recordId);
      }

      const records = this.#recordSubs.get(recordId);
      records?.delete(key);
      if (records !== undefined && records.size === 0) {
        this.#recordSubs.delete(recordId);
      }
    }
    entry.refs = [];
  }
}

/** The deduplicated union of two ref lists, so a flush's index is never smaller than either input. */
function mergeRefs(left: readonly FieldRef[], right: readonly FieldRef[]): readonly FieldRef[] {
  if (right.length === 0) {
    return left;
  }
  if (left.length === 0) {
    return right;
  }
  const seen = new Set<string>();
  const merged: FieldRef[] = [];
  for (const ref of [...left, ...right]) {
    const id = `${ref[0]}\u0000${ref[1]}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    merged.push(ref);
  }
  return merged;
}
