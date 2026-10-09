/**
 * The incremental snapshot encoder.
 *
 * The persisted payload is one JSON string, but the cache inside it is a table of records, and a
 * navigation changes one or two of them. Re-`stringify`-ing the whole envelope on every write made
 * the cost proportional to the cache: on the Pokédex's 1 000-species cache that was ~4 ms per
 * navigation at 1x CPU and ~12 ms at 4x, on the main thread, for a payload whose bytes barely
 * changed (measured in `test/persist-performance.test.ts`).
 *
 * So the encoder keeps the envelope **as fragments**: one JSON string per record, link entry, list
 * and page, plus the small header and the queue. A persist replaces the fragments the cache reports
 * as changed and concatenates them; the work is proportional to the change, and the concatenation
 * is a memcpy of the payload rather than a walk of the object graph.
 *
 * Correctness rests on the cache's own change log (§6.10, `Client.serializeChanges`): the encoder
 * never guesses what changed, and a `full` change (a hydrate or a reset) rebuilds every fragment
 * from `Client.serialize()`. `snapshot.ts`'s one-shot `encodeSnapshot` stays the reference
 * implementation, and `test/encode.test.ts` asserts the two produce the same bytes.
 */
import type { PageKey, RecordId, SerializedCache, SerializedChanges } from '@flamme/runtime';
import { SNAPSHOT_VERSION } from './snapshot.js';
import type { StoredMutation } from './types.js';

/** The `queue` half of the envelope, in the same shape `encodeSnapshot` writes. */
function encodeQueue(queue: readonly StoredMutation[]): string {
  return JSON.stringify(queue);
}

/** One `"key":value` member of a JSON object, ready to be concatenated. */
function member(key: string, value: string): string {
  return `${JSON.stringify(key)}:${value}`;
}

/** `true` when the queue and the drain time still match what the encoder holds. */
function queueMatches(
  queue: readonly StoredMutation[],
  lastSyncedAt: number | null,
  encodedQueue: string,
  encodedLastSyncedAt: number | null,
): boolean {
  return lastSyncedAt === encodedLastSyncedAt && encodeQueue(queue) === encodedQueue;
}

/** The persisted envelope, held as fragments so a small change costs a small encode. */
export class SnapshotEncoder {
  /** `RecordId → the JSON of its sorted field entry`. */
  readonly #records = new Map<RecordId, string>();
  /** `RecordId → the JSON of its sorted link entry`. */
  readonly #links = new Map<RecordId, string>();
  /** List name → the JSON of its `{ type, connection, ids }` entry. */
  readonly #lists = new Map<string, string>();
  /** Page key → the JSON of its snapshot. */
  readonly #pages = new Map<PageKey, string>();
  #compiler = '';
  #fetchedAt = 0;
  #queue = '[]';
  #lastSyncedAt: number | null = null;
  #encoded: string | null = null;

  /**
   * Rebuilds every fragment from a whole snapshot.
   *
   * `full` changes (the cache was hydrated or reset) and the first encode both go through here: it
   * is the one path that can never miss a change, which is what makes the delta path safe to take.
   */
  reset(
    snapshot: SerializedCache,
    queue: readonly StoredMutation[],
    lastSyncedAt: number | null,
  ): void {
    this.#compiler = snapshot.compiler;
    this.#fetchedAt = snapshot.fetchedAt;
    this.#records.clear();
    this.#links.clear();
    this.#lists.clear();
    this.#pages.clear();
    for (const [recordId, fields] of Object.entries(snapshot.records)) {
      this.#records.set(recordId, JSON.stringify(fields));
    }
    for (const [recordId, links] of Object.entries(snapshot.links)) {
      this.#links.set(recordId, JSON.stringify(links));
    }
    for (const [name, list] of Object.entries(snapshot.lists)) {
      this.#lists.set(name, JSON.stringify(list));
    }
    for (const [key, page] of Object.entries(snapshot.pages)) {
      this.#pages.set(key, JSON.stringify(page));
    }
    this.#setTail(queue, lastSyncedAt);
    this.#encoded = null;
  }

  /** Replaces exactly the fragments the cache reported as changed. */
  apply(
    changes: Extract<SerializedChanges, { readonly full: false }>,
    queue: readonly StoredMutation[],
    lastSyncedAt: number | null,
  ): void {
    let touched = false;
    for (const [recordId, entry] of changes.records) {
      touched = this.#replace(this.#records, recordId, entry) || touched;
    }
    for (const [recordId, entry] of changes.links) {
      touched = this.#replace(this.#links, recordId, entry) || touched;
    }
    for (const [name, entry] of changes.lists) {
      touched = this.#replace(this.#lists, name, entry) || touched;
    }
    for (const [key, entry] of changes.pages) {
      touched = this.#replace(this.#pages, key, entry) || touched;
    }
    if (changes.compiler !== this.#compiler || changes.fetchedAt !== this.#fetchedAt) {
      this.#compiler = changes.compiler;
      this.#fetchedAt = changes.fetchedAt;
      touched = true;
    }
    if (this.#setTail(queue, lastSyncedAt)) {
      touched = true;
    }
    if (touched) {
      this.#encoded = null;
    }
  }

  /** `true` when the queue or the drain time differ from what the encoder holds. */
  queueDiffers(queue: readonly StoredMutation[], lastSyncedAt: number | null): boolean {
    return !queueMatches(queue, lastSyncedAt, this.#queue, this.#lastSyncedAt);
  }

  /** The envelope as one string; assembled once per change and cached in between. */
  encode(): string {
    if (this.#encoded !== null) {
      return this.#encoded;
    }
    const parts: string[] = [
      '{"v":',
      String(SNAPSHOT_VERSION),
      ',"cache":{"v":1,"compiler":',
      JSON.stringify(this.#compiler),
      ',"records":{',
    ];
    append(parts, this.#records);
    parts.push('},"links":{');
    append(parts, this.#links);
    parts.push('},"lists":{');
    append(parts, this.#lists);
    parts.push('},"pages":{');
    append(parts, this.#pages);
    parts.push(
      '},"fetchedAt":',
      String(this.#fetchedAt),
      '},"queue":',
      this.#queue,
      ',"lastSyncedAt":',
      this.#lastSyncedAt === null ? 'null' : String(this.#lastSyncedAt),
      '}',
    );
    this.#encoded = parts.join('');
    return this.#encoded;
  }

  /**
   * Stores `entry` as `key`'s fragment, reporting whether it differs from what was held.
   *
   * A `null` entry is a removal: the record, list or page left the snapshot, and its member has to
   * leave the payload with it.
   */
  #replace<TKey>(fragments: Map<TKey, string>, key: TKey, entry: unknown): boolean {
    if (entry === null) {
      return fragments.delete(key);
    }
    const encoded = JSON.stringify(entry);
    const previous = fragments.get(key);
    if (previous === encoded) {
      return false;
    }
    fragments.set(key, encoded);
    return true;
  }

  /** Stores the queue and the drain time, reporting whether either changed. */
  #setTail(queue: readonly StoredMutation[], lastSyncedAt: number | null): boolean {
    const encoded = encodeQueue(queue);
    const changed = encoded !== this.#queue || lastSyncedAt !== this.#lastSyncedAt;
    this.#queue = encoded;
    this.#lastSyncedAt = lastSyncedAt;
    return changed;
  }
}

/** Appends a fragment map as the members of a JSON object, in insertion order. */
function append(parts: string[], fragments: ReadonlyMap<string, string>): void {
  let first = true;
  for (const [key, encoded] of fragments) {
    if (!first) {
      parts.push(',');
    }
    first = false;
    parts.push(member(key, encoded));
  }
}
