/**
 * The `Cache` facade (§6): the only cache object the rest of the runtime touches.
 *
 * It owns the storage, the subscription registry, the list manager, the stale manager, the garbage
 * collector and the page table, and wires them together so every mutation funnels through one place:
 * mutate the storage, then mark the exact keys that changed dirty, then (on the next microtask, or
 * on `flush()`) rebuild their snapshots and notify.
 */
import type {
  Artifact,
  FieldSpec,
  FragmentKey,
  ListSpec,
  RecordId,
  SubscriptionSelection,
  Variables,
} from '../artifact.js';
import type {
  CacheConfig,
  CacheLayer,
  ConnectionSnapshot,
  ListHandle,
  ReadOptions,
  ReadResult,
  SubscriptionSpec,
  WriteOptions,
  WriteResult,
} from '../cache.js';
import { SnapshotVersionMismatchError } from '../errors.js';
import type {
  PageKey,
  SerializedCache,
  SerializedChanges,
  SerializedList,
  SerializedPage,
} from '../serialize.js';
import { GarbageCollector } from './gc.js';
import type { ReadContext, WriteContext } from './internal.js';
import {
  asRecord,
  evaluateKey,
  fieldNameOf,
  isRecord,
  keyFieldsForType,
  recordIdFor,
  responseKeyFor,
} from './keys.js';
import {
  LIST_IDS_FIELD,
  ListManager,
  listNameOf,
  listRecordId,
  type ConnectionInsert,
  type ConnectionRemove,
  type ConnectionSite,
} from './lists.js';
import {
  buildConnection,
  fromSerializedPage,
  locateConnection,
  pageKeyFor,
  readConnection,
  rewriteCursorArgs,
  toSerializedPage,
} from './pages.js';
import { readForSubscription, readSelection } from './read.js';
import { StaleManager } from './stale.js';
import { InMemoryStorage } from './storage.js';
import { CacheSubscriptions } from './subscriptions.js';
import { writeSelection } from './write.js';

/** The version stamped into every snapshot; a different major is refused by `hydrate` (§6.10). */
const COMPILER_VERSION = '0.0.0';

/** The `v` a snapshot must carry. */
const SNAPSHOT_VERSION = 1;

/** The default clock: only time-based staleness and `fetchedAt` read it. */
function systemClock(): number {
  return Date.now();
}

/** The mutable inner map for one record, created on demand (the rename of §7.14 needs it). */
function recordMap<V>(table: Map<string, Map<string, V>>, recordId: string): Map<string, V> {
  const existing = table.get(recordId);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Map<string, V>();
  table.set(recordId, created);
  return created;
}

/** The normalized cache: storage, subscriptions, lists, staleness, GC and pages behind one facade. */
export class Cache {
  readonly config: CacheConfig;
  /** The layered record store; exposed so a caller can build a layer and read it back (§6.2). */
  readonly storage = new InMemoryStorage();
  /** The named-list manager behind `list(name)` (§6.7). */
  readonly lists: ListManager;
  /** The refcounted subscription registry behind `subscribe` (§6.6). */
  readonly subscriptions: CacheSubscriptions;
  /** The stale manager behind `markRecordStale`/`refresh`/`getFieldTime` (§6.9). */
  readonly stale: StaleManager;
  /** The garbage collector behind the record budget (§6.11). */
  readonly gc: GarbageCollector;

  /**
   * Optional sink for a listener that threw during a flush (§6.6): the flush always finishes and
   * every other listener still runs. Without a sink the failures are reported once through
   * `console.error`; install one to route them to an error reporter (C2).
   *
   * The registry owns the value; this is a forwarding accessor so `cache.onListenerError = …`
   * reaches it without the facade having to install a hook that would suppress the fallback.
   */
  get onListenerError(): ((error: unknown, key: FragmentKey) => void) | undefined {
    return this.subscriptions.onListenerError;
  }

  set onListenerError(hook: ((error: unknown, key: FragmentKey) => void) | undefined) {
    this.subscriptions.onListenerError = hook;
  }

  /** Fragment name → selection, so a spread's fields can be written (§6.4). */
  readonly #fragments = new Map<string, SubscriptionSelection>();
  /** One entry per page key: the current page plus every page seen for it (§6.8, property 6). */
  readonly #pages = new Map<PageKey, PageEntry>();
  /**
   * List names whose **registration** changed since the previous {@link Cache.serializeChanges}.
   *
   * Membership changes arrive through the storage (the `List:<name>` record), but a registration
   * alone changes the snapshot's `lists` section, so it is tracked here (§6.10).
   */
  readonly #dirtyLists = new Set<string>();
  /** Page keys whose serialized entry changed since the previous `serializeChanges()`. */
  readonly #dirtyPages = new Set<PageKey>();
  /** The records one page's snapshot points at, so a record's existence change can find it. */
  readonly #recordsByPage = new Map<PageKey, Set<RecordId>>();
  /** The reverse of {@link #recordsByPage}: a record → the pages whose snapshot points at it. */
  readonly #pagesByRecord = new Map<RecordId, Set<PageKey>>();

  constructor(config: CacheConfig, clock: () => number = systemClock) {
    this.config = config;
    this.stale = new StaleManager({
      clock,
      typeIndex: () => this.storage.typeIndex,
      onRefresh: (records) => {
        this.#markRecordsDirty(records);
      },
    });
    this.lists = new ListManager(this.storage, {
      onChange: (refs) => {
        this.#markDirty(this.subscriptions.keysForChanges(refs));
      },
      onRecordsChanged: (records) => {
        this.#markRecordsDirty(records);
      },
      onRegister: (name) => {
        this.#dirtyLists.add(name);
      },
      onConnectionInsert: (info) => {
        this.#synthesizeEdge(info);
      },
      onConnectionRemove: (info) => {
        this.#dropEdge(info);
      },
    });
    this.subscriptions = new CacheSubscriptions({
      read: (spec, previous) =>
        readForSubscription(this.#readContext(), {
          selection: spec.selection,
          parent: spec.parentID,
          variables: spec.variables(),
          previous,
        }),
      lookup: (recordId, field) => this.storage.getLink(recordId, field),
    });
    this.gc = new GarbageCollector({
      maxRecords: config.gc?.maxRecords ?? 10_000,
      records: () => this.storage.knownRecords(),
      pins: () => this.#pins(),
      onEvict: (records) => {
        this.#evict(records);
      },
    });
  }

  /** Monotonic; bumped once per notification flush (§6.6). */
  get epoch(): number {
    return this.subscriptions.flushes;
  }

  /** Reads a selection, masked by default, with structural sharing when `previous` is supplied. */
  read<TData>(options: ReadOptions): ReadResult<TData> {
    // the one typed boundary of an untyped store: `TData` is the generated `$result` type and the
    // reader is shape-preserving at runtime (masking and frames only skip or replace values)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generated $result types are asserted, never checked, at the read boundary
    return readSelection(this.#readContext(), options) as ReadResult<TData>;
  }

  /** Writes a payload into a layer, then marks the exact keys whose fields changed dirty. */
  write(options: WriteOptions): WriteResult {
    const outcome = writeSelection(this.#writeContext(), options);
    const dirty = this.#markDirty(this.subscriptions.keysForChanges(outcome.changes));
    if (this.gc.recordCount > this.gc.maxRecords) {
      this.gc.collect();
    }
    return { records: outcome.records, fields: outcome.fields, dirty };
  }

  /** Registers a listener at fragment granularity; the returned function unreferences it. */
  subscribe(spec: SubscriptionSpec): () => void {
    return this.subscriptions.subscribe(spec);
  }

  /** The imperative handle for a registered list; an unknown name is FLM4003. */
  list(name: string): ListHandle {
    return this.lists.list(name);
  }

  /** Marks the records and every key that reads them dirty, bypassing the field test (rule 7). */
  refresh(recordId: RecordId | readonly RecordId[]): void {
    this.stale.refresh(recordId);
  }

  /** Marks every field of a record stale (§6.9). */
  markRecordStale(recordId: RecordId): void {
    this.stale.markRecordStale(recordId);
  }

  /** Marks every record of `type` stale and dirties the keys that read them (rule 8). */
  markTypeStale(type: string): void {
    this.stale.markTypeStale(type);
    this.#markRecordsDirty(this.storage.typeIndex.get(type) ?? []);
  }

  /** The write time of a field, or `null` when the field was never written or hydrated. */
  getFieldTime(recordId: RecordId, field: string): number | null {
    return this.stale.getFieldTime(recordId, field);
  }

  /**
   * Deletes a record: every key touching it becomes dirty, because fields disappeared (rule 3).
   *
   * With no explicit layer this is a confirmed deletion and lands in the base layer, matching the
   * writer's rule: only a mutation's optimistic operations belong to `topLayer()`.
   */
  delete(recordId: RecordId, options: { layer?: CacheLayer } = {}): void {
    const layer = options.layer ?? this.storage.baseLayer();
    this.storage.deleteRecord(recordId, layer);
    this.lists.remove(recordId, layer);
    this.stale.markRecordStale(recordId);
    this.#markRecordsDirty([recordId]);
  }

  /** Pushes an optimistic layer; reads resolve from the top of the stack down (§6.2). */
  createLayer(optimistic: boolean): CacheLayer {
    return this.storage.createLayer(optimistic);
  }

  /**
   * Merges a layer down (`resolve: true`) or drops it (`resolve: false`, the default). A rollback
   * marks the layer's records stale so a later `CacheOrNetwork` read refetches, and refuses an
   * out-of-order rollback so mutation B cannot resurrect mutation A's optimistic values.
   */
  clearLayer(layer: CacheLayer, options: { resolve?: boolean } = {}): void {
    if (this.storage.isDetached(layer)) {
      // `reset()`/`dispose()` already dropped the layer while a mutation was in flight: resolving
      // or rolling it back afterwards is a no-op, never a raw Error (C6)
      return;
    }
    if (options.resolve === true) {
      this.storage.resolveLayer(layer);
      this.#markRecordsDirty(recordsOf(layer));
      return;
    }
    for (const [recordId, fields] of layer.fields) {
      for (const field of fields.keys()) {
        this.stale.markFieldStale(recordId, field);
      }
    }
    for (const recordId of layer.deleted) {
      this.stale.markRecordStale(recordId);
    }
    const affected = recordsOf(layer);
    this.storage.removeLayer(layer);
    this.stale.dropLayer(layer.id);
    this.#markRecordsDirty(affected);
  }

  /**
   * Renames one record to another inside an open layer, rewriting every reference (§7.14).
   *
   * `@optimisticKey` writes an optimistic record under a generated id because the server has not
   * assigned one yet. When the confirmation arrives with the real id, this is the move: the
   * temporary record's fields (and its own links) go to the real id, every link array or link value
   * in the layer that pointed at the temporary id is rewritten, and the temporary record is removed.
   * Confirmed values already written under the real id are never overwritten.
   *
   * Returns `false` when the layer holds no temporary record to move. The references are rewritten
   * anyway, which is the point of reporting it: the caller gets a warning and the cache keeps no
   * dangling generated id behind.
   */
  remapOptimistic(from: RecordId, to: RecordId, layer: CacheLayer): boolean {
    if (from === to || this.storage.isDetached(layer)) {
      return false;
    }
    const fields = layer.fields.get(from);
    const links = layer.links.get(from);
    const found = !layer.deleted.has(from) && (fields !== undefined || links !== undefined);

    if (fields !== undefined) {
      const target = recordMap(layer.fields, to);
      for (const [field, value] of fields) {
        if (!target.has(field)) {
          target.set(field, value);
        }
      }
      layer.fields.delete(from);
    }
    if (links !== undefined) {
      const target = recordMap(layer.links, to);
      for (const [field, value] of links) {
        if (!target.has(field)) {
          target.set(field, value);
        }
      }
      layer.links.delete(from);
    }

    for (const linkMap of layer.links.values()) {
      for (const [field, value] of linkMap) {
        if (value === from) {
          linkMap.set(field, to);
          continue;
        }
        if (Array.isArray(value) && value.includes(from)) {
          linkMap.set(
            field,
            value.map((id) => (id === from ? to : id)),
          );
        }
      }
    }
    for (const fieldMap of layer.fields.values()) {
      for (const [field, value] of fieldMap) {
        if (value === from) {
          fieldMap.set(field, to);
        }
      }
    }
    layer.deleted.delete(from);
    if (layer === this.storage.baseLayer()) {
      // this method edits the layer's maps directly, so the storage cannot see the rewrite: a base
      // rename changes `from`, `to` and every record whose links pointed at `from`
      this.storage.markDirty([...layer.fields.keys(), ...layer.links.keys(), from, to]);
    }
    this.#markRecordsDirty([from, to]);
    return found;
  }

  /**
   * The one wire format: the base layer's two tables plus lists, pages and `fetchedAt` (§6.10).
   *
   * Every part is **base-layer only** (rule 6): the record/link tables come from `storage.serialize`,
   * list membership resolves at the base layer, and a page whose records exist only in an open
   * optimistic layer is left out, so an unresolved layer can never put a dangling id on the wire.
   */
  serialize(): SerializedCache {
    const base = this.storage.baseLayer();
    const snapshot = this.storage.serialize(base);
    return {
      v: SNAPSHOT_VERSION,
      compiler: COMPILER_VERSION,
      records: snapshot.records,
      links: snapshot.links,
      lists: this.#serializeLists(base),
      pages: this.#serializePages(base),
      fetchedAt: this.stale.fetchedAt(base.id),
    };
  }

  /**
   * The changes since the previous drain, in {@link Cache.serialize}'s shape (§6.10).
   *
   * A consumer that keeps the previous snapshot can replace only these entries instead of walking
   * the whole cache, which is what keeps a durable write proportional to what changed. The change
   * sets are **drained**: one change is reported once, and a `full` result carries the whole
   * snapshot so a consumer can never miss one. {@link Cache.hasSerializedChanges} answers the same
   * question without draining.
   */
  serializeChanges(): SerializedChanges {
    const drained = this.storage.drainBaseChanges();
    if (drained.full) {
      const snapshot = this.serialize();
      this.#dirtyLists.clear();
      this.#dirtyPages.clear();
      return { full: true, snapshot };
    }
    const base = this.storage.baseLayer();

    // a list's membership lives in the storage as the `List:<name>` record, so a change to that
    // record is a change to the `lists` section too
    const lists = new Map<string, SerializedList | null>();
    for (const recordId of drained.records.keys()) {
      const name = listNameOf(recordId);
      if (name !== null) {
        lists.set(name, this.#serializeList(name, base));
      }
    }
    for (const name of this.#dirtyLists) {
      lists.set(name, this.#serializeList(name, base));
    }
    this.#dirtyLists.clear();

    // a page may only reference base-layer records (rule 6), so a record that appeared or vanished
    // can change whether the pages pointing at it belong in the snapshot
    const dirtyPages = new Set(this.#dirtyPages);
    this.#dirtyPages.clear();
    for (const recordId of drained.existence) {
      for (const key of this.#pagesByRecord.get(recordId) ?? []) {
        dirtyPages.add(key);
      }
    }
    const pages = new Map<PageKey, SerializedPage | null>();
    for (const key of dirtyPages) {
      pages.set(key, this.#serializePage(key, base));
    }

    return {
      full: false,
      v: SNAPSHOT_VERSION,
      compiler: COMPILER_VERSION,
      records: drained.records,
      links: drained.links,
      lists,
      pages,
      fetchedAt: this.stale.fetchedAt(base.id),
    };
  }

  /** `true` when {@link Cache.serializeChanges} would report anything. */
  hasSerializedChanges(): boolean {
    return this.storage.hasChanges || this.#dirtyLists.size > 0 || this.#dirtyPages.size > 0;
  }

  /** The `lists` section: one entry per registered list, in registration order. */
  #serializeLists(base: CacheLayer): Record<string, SerializedList> {
    const lists: Record<string, SerializedList> = {};
    for (const name of this.lists.names) {
      const entry = this.#serializeList(name, base);
      if (entry !== null) {
        lists[name] = entry;
      }
    }
    return lists;
  }

  /** One list's serialized entry, or `null` when nothing registers the name. */
  #serializeList(name: string, base: CacheLayer): SerializedList | null {
    const spec = this.lists.spec(name);
    if (spec === null) {
      return null;
    }
    return { type: spec.type, connection: spec.connection, ids: [...this.lists.ids(name, base)] };
  }

  /** The `pages` section, keys sorted. */
  #serializePages(base: CacheLayer): Record<PageKey, SerializedPage> {
    const pages: Record<PageKey, SerializedPage> = {};
    for (const key of [...this.#pages.keys()].toSorted()) {
      const entry = this.#serializePage(key, base);
      if (entry !== null) {
        pages[key] = entry;
      }
    }
    return pages;
  }

  /**
   * One page's serialized entry, or `null` when it is not in the snapshot: no current page, or a
   * current page that points at a record outside the base layer (rule 6, C1).
   */
  #serializePage(key: PageKey, base: CacheLayer): SerializedPage | null {
    const entry = this.#pages.get(key);
    if (entry === undefined || entry.current === null) {
      return null;
    }
    if (!this.#pageIsBaseOnly(entry.current, base)) {
      return null;
    }
    return toSerializedPage(entry.current, entry.mode);
  }

  /**
   * Restores a snapshot: records, then links, then lists, then pages, then the timestamp (§6.10
   * rule 4). The payload is validated completely before anything is written, so a malformed or
   * foreign snapshot raises `SnapshotVersionMismatchError` (FLM4005) and leaves the cache untouched.
   */
  hydrate(snapshot: SerializedCache): void {
    const validated = validateSnapshot(snapshot);
    this.storage.hydrate(validated.storage);

    for (const [name, list] of Object.entries(validated.lists)) {
      const spec: ListSpec = { name, type: list.type, connection: list.connection };
      this.lists.register(name, spec);
      this.lists.seed(name, list.ids, this.storage.baseLayer());
    }

    this.#pages.clear();
    this.#clearPageTracking();
    for (const [key, page] of Object.entries(validated.pages)) {
      const hydrated = fromSerializedPage(page);
      const entry = createPageEntry(hydrated, page.mode);
      // a hydrated page is a known page: back/forward navigation finds it without a request
      entry.known.set(pageSignature(null, null), {
        snapshot: hydrated,
        after: null,
        before: null,
      });
      this.#pages.set(key, entry);
      // the indexes are rebuilt for the hydrated pages too: a later write that creates or removes
      // one of their records has to re-open them (the storage reported this hydrate as a full change)
      this.#trackPage(key);
    }

    this.stale.setSnapshotTime(validated.fetchedAt);
  }

  /**
   * Fills the cache from a snapshot **without replacing** what it already holds (§6.10 rule 4).
   *
   * The mirror image of {@link Cache.hydrate}, and the precedence a durable local snapshot needs: a
   * record, link, list or page the cache already carries wins, and the snapshot supplies only what
   * is missing. A device's snapshot is a page load behind the fresh SSR payload that was hydrated
   * into the same cache, so it must fill the gaps around it, never overwrite it. The payload also
   * keeps its snapshot time when the cache was not empty, so a restore cannot make fresh data look
   * as old as the device's copy.
   *
   * Validation is exactly `hydrate`'s: a malformed or foreign snapshot raises
   * `SnapshotVersionMismatchError` (FLM4005) and leaves the cache untouched, which is what keeps an
   * older build's payload from being merged into a new build's cache.
   */
  hydrateMissing(snapshot: SerializedCache): void {
    const validated = validateSnapshot(snapshot);
    const base = this.storage.baseLayer();
    const hadRecords = this.storage.knownRecords().size > 0;

    // a record the base layer already holds is the payload's: record-level precedence, so a field
    // the payload did not select stays unknown rather than coming back from the older snapshot
    const records: Record<RecordId, Record<string, unknown>> = {};
    const links: Record<RecordId, Record<string, string | readonly string[] | null>> = {};
    for (const [recordId, fields] of Object.entries(validated.storage.records)) {
      if (!this.storage.hasRecord(recordId, base)) {
        records[recordId] = fields;
      }
    }
    for (const [recordId, fields] of Object.entries(validated.storage.links)) {
      if (!this.storage.hasRecord(recordId, base)) {
        links[recordId] = fields;
      }
    }
    this.storage.fillMissing({ records, links });

    for (const [name, list] of Object.entries(validated.lists)) {
      const spec: ListSpec = { name, type: list.type, connection: list.connection };
      this.lists.register(name, spec);
      // Membership lives in the storage as the `List:<name>` record, so a list whose array the
      // fill skipped is one the payload answered: seeding the snapshot's ids over it would undo it.
      if (!this.storage.has(listRecordId(name), LIST_IDS_FIELD, base)) {
        this.lists.seed(name, list.ids, base);
      }
    }

    for (const [key, page] of Object.entries(validated.pages)) {
      if (this.#pages.has(key)) {
        continue;
      }
      const hydrated = fromSerializedPage(page);
      const entry = createPageEntry(hydrated, page.mode);
      entry.known.set(pageSignature(null, null), {
        snapshot: hydrated,
        after: null,
        before: null,
      });
      this.#pages.set(key, entry);
      this.#trackPage(key);
    }

    if (!hadRecords) {
      // nothing was hydrated before this restore: the snapshot is the whole cache, so its write
      // time is the cache's, exactly as `hydrate` stamps it
      this.stale.setSnapshotTime(validated.fetchedAt);
    }
  }

  /** Delivers pending notifications now instead of on the next microtask (§6.6). */
  flush(): void {
    this.subscriptions.flush();
  }

  /** Registers a fragment selection so a spread's fields are written by `write` (§6.4). */
  registerFragment(name: string, selection: SubscriptionSelection): void {
    this.#fragments.set(name, selection);
  }

  /** `<artifact name>.<path>|<root key raw>` for an artifact's paginated field, or `null` (§6.10). */
  pageKey(artifact: Artifact, variables: Variables): PageKey | null {
    return pageKeyFor(artifact, variables);
  }

  /** The current page snapshot for a page key, or `null`. */
  page(key: PageKey): ConnectionSnapshot | null {
    return this.#pages.get(key)?.current ?? null;
  }

  /** The pagination mode recorded for a page key, or `null`. */
  pageMode(key: PageKey): 'SinglePage' | 'Infinite' | null {
    return this.#pages.get(key)?.mode ?? null;
  }

  /** Every page seen for a page key, in visit order (the SinglePage navigation cache). */
  knownPages(key: PageKey): readonly ConnectionSnapshot[] {
    const entry = this.#pages.get(key);
    return entry === undefined ? [] : [...entry.known.values()].map((page) => page.snapshot);
  }

  /** Records a page snapshot explicitly (the client's write path calls `capturePage` instead). */
  setPage(
    key: PageKey,
    page: ConnectionSnapshot,
    mode: 'SinglePage' | 'Infinite',
    pageVariables?: Variables,
  ): void {
    const entry = this.#pageEntry(key, mode);
    const cursors = cursorsOf(pageVariables ?? {});
    entry.current = page;
    entry.after = cursors.after;
    entry.before = cursors.before;
    entry.known.set(pageSignature(cursors.after, cursors.before), {
      snapshot: page,
      after: cursors.after,
      before: cursors.before,
    });
    this.#trackPage(key);
  }

  /** The current connection snapshot of an artifact's paginated field, read unmasked (§6.8). */
  connection(artifact: Artifact, variables: Variables): ConnectionSnapshot | null {
    return buildConnection(this, artifact, variables);
  }

  /** Rebuilds and stores the current page snapshot for an artifact's paginated field (§6.10). */
  capturePage(
    artifact: Artifact,
    variables: Variables,
    pageVariables: Variables = variables,
  ): ConnectionSnapshot | null {
    const connection = buildConnection(this, artifact, variables);
    const key = pageKeyFor(artifact, variables);
    if (connection === null || key === null) {
      return null;
    }
    this.setPage(key, connection, artifact.refetch?.mode ?? 'SinglePage', pageVariables);
    return connection;
  }

  /**
   * Makes the page addressed by `pageVariables` the current page when it is already cached, and
   * rebuilds the page snapshot. Returns `false` when nothing is cached there, so the caller fetches.
   *
   * In `SinglePage` mode each page is its own record, so adopting one *repoints* the parent's
   * connection link at it: that is what makes a page replace rather than append (§6.8).
   */
  adoptPage(
    artifact: Artifact,
    variables: Variables,
    options: { readonly direction: 'forward' | 'backward'; readonly pageVariables?: Variables },
  ): boolean {
    const refetch = artifact.refetch;
    const located = locateConnection(this, artifact, variables);
    const key = pageKeyFor(artifact, variables);
    if (refetch === undefined || located === null || key === null) {
      return false;
    }

    const entry = this.#pageEntry(key, refetch.mode);
    const live = buildConnection(this, artifact, variables);
    if (live !== null && entry.current === null) {
      // remember the page the document's own write produced, so leaving it is a cache hit
      entry.current = live;
      entry.known.set(pageSignature(entry.after, entry.before), {
        snapshot: live,
        after: entry.after,
        before: entry.before,
      });
      this.#trackPage(key);
    }
    if (refetch.mode === 'Infinite') {
      // every page merged into one record, so there is nothing to adopt: only the snapshot moves
      const connection = buildConnection(this, artifact, variables);
      if (connection === null) {
        return false;
      }
      this.setPage(key, connection, refetch.mode, options.pageVariables ?? variables);
      this.#markRecordsDirty([located.parentId]);
      return true;
    }

    const target =
      this.#pageByVariables(located, entry, options.pageVariables) ??
      (live === null ? null : neighbourPage(entry, options.direction, live));
    if (target === null) {
      return false;
    }
    if (
      entry.current !== null &&
      pageSignature(target.after, target.before) === pageSignature(entry.after, entry.before)
    ) {
      // The target is the page that is already current, so adopting it is a no-op. On a
      // server whose cursor repeats (or is `null` while `hasNextPage` stays true) the old
      // code returned `true` here, `loadNextPage` fetched nothing, and pagination stalled
      // silently (`research/review-slice25-adversarial.md` C5). `false` makes the caller fetch.
      return false;
    }

    // SinglePage: repoint the document's connection link at the adopted page's record
    const pageId = target.snapshot.ids[0];
    if (pageId === undefined || !this.storage.hasRecord(pageId)) {
      return false;
    }
    // SinglePage repoints the document's connection link at the adopted page's record. An adopted
    // page is confirmed data, so the repoint belongs to the base layer even while an unrelated
    // mutation's optimistic layer is open (the writer's rule).
    this.storage.setLink(located.parentId, located.fieldKey, pageId, this.storage.baseLayer());

    const connection = buildConnection(this, artifact, variables);
    if (connection === null) {
      return false;
    }
    const installed = this.#pageEntry(key, refetch.mode);
    installed.current = connection;
    installed.after = target.after;
    installed.before = target.before;
    installed.known.set(pageSignature(target.after, target.before), target);
    this.#trackPage(key);
    this.#markRecordsDirty([located.parentId, pageId]);
    return true;
  }

  /** The cached page whose record the given page variables address, or `null`. */
  #pageByVariables(
    located: { readonly parentId: RecordId; readonly field: FieldSpec; readonly fieldKey: string },
    entry: PageEntry,
    pageVariables: Variables | undefined,
  ): KnownPage | null {
    if (pageVariables === undefined) {
      return null;
    }
    const after = typeof pageVariables['after'] === 'string' ? pageVariables['after'] : null;
    const before = typeof pageVariables['before'] === 'string' ? pageVariables['before'] : null;
    const remembered = entry.known.get(pageSignature(after, before));
    if (remembered !== undefined) {
      return remembered;
    }

    const pageFieldKey = rewriteCursorArgs(located.fieldKey, pageVariables);
    const target = this.storage.resolve(located.parentId, pageFieldKey);
    if (!target.found || !target.link || typeof target.value !== 'string') {
      return null;
    }
    const name = located.field.keyRaw;
    void name;
    const snapshot = readConnection(
      this,
      located.parentId,
      pageKeyName(located.field),
      { ...located.field, keyRaw: pageFieldKey },
      pageFieldKey,
      pageVariables,
    );
    return snapshot === null || !snapshot.complete ? null : { snapshot, after, before };
  }
  #pageEntry(key: PageKey, mode: 'SinglePage' | 'Infinite'): PageEntry {
    let entry = this.#pages.get(key);
    if (entry === undefined) {
      entry = createPageEntry(null, mode);
      this.#pages.set(key, entry);
    }
    return entry;
  }

  /** `true` when every record a page points at exists in the base layer (rule 6, C1). */
  #pageIsBaseOnly(page: ConnectionSnapshot, base: CacheLayer): boolean {
    for (const id of page.ids) {
      if (!this.storage.hasRecord(id, base)) {
        return false;
      }
    }
    for (const edge of page.edges) {
      if (!this.storage.hasRecord(edge.id, base)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Notes that a page's serialized entry may have changed, and re-indexes the records it points at.
   *
   * The reverse index is what makes the page check incremental: a page belongs in the snapshot only
   * while every record it points at exists in the base layer (§6.10 rule 6), and a record that
   * appears or vanishes has to re-open exactly the pages that reference it.
   */
  #trackPage(key: PageKey): void {
    this.#dirtyPages.add(key);
    const previous = this.#recordsByPage.get(key);
    if (previous !== undefined) {
      this.#recordsByPage.delete(key);
      for (const recordId of previous) {
        const keys = this.#pagesByRecord.get(recordId);
        keys?.delete(key);
        if (keys !== undefined && keys.size === 0) {
          this.#pagesByRecord.delete(recordId);
        }
      }
    }
    const current = this.#pages.get(key)?.current ?? null;
    if (current === null) {
      return;
    }
    const records = new Set<RecordId>();
    for (const id of current.ids) {
      records.add(id);
    }
    for (const edge of current.edges) {
      records.add(edge.id);
    }
    if (records.size === 0) {
      return;
    }
    this.#recordsByPage.set(key, records);
    for (const recordId of records) {
      let keys = this.#pagesByRecord.get(recordId);
      if (keys === undefined) {
        keys = new Set();
        this.#pagesByRecord.set(recordId, keys);
      }
      keys.add(key);
    }
  }

  /** Forgets every page mark and the indexes behind them. */
  #clearPageTracking(): void {
    this.#dirtyPages.clear();
    this.#recordsByPage.clear();
    this.#pagesByRecord.clear();
  }

  /** Drops every record, listener, list, page and fragment registration. */
  reset(): void {
    this.storage.reset();
    this.lists.clear();
    this.subscriptions.clear();
    this.stale.clear();
    this.gc.clear();
    this.#pages.clear();
    this.#fragments.clear();
    this.#dirtyLists.clear();
    this.#clearPageTracking();
  }

  /** The SSR teardown: `reset()`, leaving the instance empty and reusable (§6.10, D6). */
  dispose(): void {
    this.reset();
  }

  /**
   * Writes the edge a connection insert implies (§6.7).
   *
   * The node's own record was written by the mutation payload; the edge is the fresh, anonymous
   * object Houdini's `addToList` writes, `{ __typename: "<T>Edge", node }` with **no cursor**
   * (`cache/lists.ts:310-362`). The read path suppresses the missing-cursor partial flag, so the
   * edge is readable as data before any refetch.
   *
   * A connection whose edge type has key fields stores `edges` as a link array, so the synthesized
   * edge has to be addressable: it takes the node it points at as its own key (`id`), which is the
   * only identity a locally invented edge has. Without it the write would append an inline object to
   * a link array and the whole array would stop hydrating (`review-f1`).
   */
  #synthesizeEdge(info: ConnectionInsert): void {
    const located = connectionEdges(info.site);
    if (located === null) {
      return;
    }
    const node = this.read<Readonly<Record<string, unknown>>>({
      selection: located.nodeSpec.selection ?? {},
      parent: info.nodeId,
      variables: info.site.variables,
      mask: false,
    });
    if (!isRecord(node.data)) {
      return;
    }
    const nodeType =
      typeof node.data['__typename'] === 'string' ? node.data['__typename'] : located.nodeSpec.type;
    // the edges field's own spec carries the edge type; Houdini's literal `${nodeType}Edge` is only
    // the fallback for a spec the compiler never typed
    const edgeType = located.edgesSpec.type === '' ? `${nodeType}Edge` : located.edgesSpec.type;
    const edge: Record<string, unknown> = {
      __typename: edgeType,
      [located.nodeName]: node.data,
    };
    const keyFields = keyFieldsForType(this.config, edgeType);
    if (this.#edgesAreLinks(info.site, located) || this.config.keys?.[edgeType] !== undefined) {
      // the key the link array needs: the node is unique inside one connection, and it is the only
      // identity a locally synthesized edge can claim
      if (keyFields.includes('id')) {
        edge['id'] = info.nodeId;
      }
    }
    this.write({
      selection: {
        // the edges field merges in the direction the operation's position asks for, whichever
        // `updates` the compiler wrote for the document
        fields: {
          [located.edgesName]: { ...located.edgesSpec, updates: ['append', 'prepend'] },
        },
      },
      parent: info.site.connectionId,
      data: { [located.edgesName]: [edge] },
      variables: info.site.variables,
      layer: info.layer,
      applyUpdates: [info.position === 'first' ? 'prepend' : 'append'],
    });
  }

  /** `true` when the connection's stored `edges` is already a link array (§4.5.1, `review-f1`). */
  #edgesAreLinks(
    site: ConnectionSite,
    located: { readonly edgesName: string; readonly edgesSpec: FieldSpec },
  ): boolean {
    const resolved = this.storage.resolve(
      site.connectionId,
      evaluateKey(located.edgesSpec.keyRaw, site.variables),
    );
    return resolved.found && resolved.link && Array.isArray(resolved.value);
  }

  /** Drops the edge that points at a node a connection list lost (§6.7). */
  #dropEdge(info: ConnectionRemove): void {
    const located = connectionEdges(info.site);
    if (located === null) {
      return;
    }
    const current = this.read<Readonly<Record<string, unknown>>>({
      selection: { fields: { [located.edgesName]: located.edgesSpec } },
      parent: info.site.connectionId,
      variables: info.site.variables,
      mask: false,
    });
    const data = isRecord(current.data) ? current.data : {};
    const stored = data[located.edgesName];
    const edges: readonly unknown[] = Array.isArray(stored) ? stored : [];
    const next = edges.filter((entry) => {
      const node = asRecord(asRecord(entry)?.[located.nodeName]);
      if (node === null) {
        return true;
      }
      const type =
        typeof node['__typename'] === 'string' ? node['__typename'] : located.nodeSpec.type;
      return recordIdFor(this.config, type, node) !== info.nodeId;
    });
    if (next.length === edges.length) {
      return;
    }
    this.write({
      selection: { fields: { [located.edgesName]: located.edgesSpec } },
      parent: info.site.connectionId,
      data: { [located.edgesName]: next },
      variables: info.site.variables,
      layer: info.layer,
    });
  }

  #readContext(): ReadContext {
    return {
      config: this.config,
      storage: this.storage,
      lists: this.lists,
      stale: this.stale,
      fragments: this.#fragments,
      staleTime: this.config.staleTime ?? 'infinite',
    };
  }

  #writeContext(): WriteContext {
    return { ...this.#readContext(), gc: this.gc };
  }

  #markDirty(keys: Iterable<string>): string[] {
    const list = [...keys];
    this.subscriptions.markDirty(list);
    return list;
  }

  #markRecordsDirty(records: Iterable<RecordId>): void {
    this.#markDirty(this.subscriptions.keysForRecords(records));
  }

  /** Everything a collection must never evict: roots, live subscriptions, lists and pages. */
  #pins(): ReadonlySet<RecordId> {
    const pins = new Set<RecordId>(['_ROOT_']);
    for (const recordId of this.subscriptions.pinnedRecords()) {
      pins.add(recordId);
    }
    for (const name of this.lists.names) {
      pins.add(`List:${name}`);
      for (const id of this.lists.ids(name)) {
        pins.add(id);
      }
    }
    for (const entry of this.#pages.values()) {
      for (const page of entry.known.values()) {
        for (const id of page.snapshot.ids) {
          pins.add(id);
        }
        for (const edge of page.snapshot.edges) {
          pins.add(edge.id);
        }
      }
    }
    return pins;
  }

  /** Drops evicted records from every layer and dirties every key that read them (§6.11). */
  #evict(records: readonly RecordId[]): void {
    for (const recordId of records) {
      for (const layer of this.storage.layers) {
        this.storage.deleteRecord(recordId, layer);
      }
      this.storage.forget(recordId);
      this.lists.remove(recordId, this.storage.baseLayer());
      this.stale.forget(recordId);
    }
    this.#markRecordsDirty(records);
  }
}

/** One page of a page set: the snapshot plus the cursor arguments that produced it. */
interface KnownPage {
  readonly snapshot: ConnectionSnapshot;
  readonly after: string | null;
  readonly before: string | null;
}

/** A page set: the current page plus every page seen for it (the SinglePage navigation cache). */
interface PageEntry {
  current: ConnectionSnapshot | null;
  /** The cursor arguments that produced the current page; the SinglePage neighbour relation. */
  after: string | null;
  before: string | null;
  readonly mode: 'SinglePage' | 'Infinite';
  readonly known: Map<string, KnownPage>;
}

function createPageEntry(
  current: ConnectionSnapshot | null,
  mode: 'SinglePage' | 'Infinite',
): PageEntry {
  return { current, after: null, before: null, mode, known: new Map() };
}

/** Pages are identified by the cursor arguments that produced them. */
function pageSignature(after: string | null, before: string | null): string {
  return `${after ?? ''}|${before ?? ''}`;
}

/** The cursor arguments a page was loaded with. */
function cursorsOf(pageVariables: Variables): { after: string | null; before: string | null } {
  return {
    after: typeof pageVariables['after'] === 'string' ? pageVariables['after'] : null,
    before: typeof pageVariables['before'] === 'string' ? pageVariables['before'] : null,
  };
}

/**
 * The page next to the current one in the requested direction (§6.8): a page fetched with
 * `after: X` follows the page whose `endCursor` is `X`, and precedes the page whose own `after`
 * is its `endCursor`. That relation is what makes back and forward navigation cache hits with no
 * request and no navigation stack inside the cache.
 */
function neighbourPage(
  entry: PageEntry,
  direction: 'forward' | 'backward',
  current: ConnectionSnapshot,
): KnownPage | null {
  const wanted = direction === 'forward' ? current.pageInfo.endCursor : entry.after;
  if (wanted === null) {
    return null;
  }
  for (const page of entry.known.values()) {
    if (page.snapshot === current) {
      continue;
    }
    const matches =
      direction === 'forward' ? page.after === wanted : page.snapshot.pageInfo.endCursor === wanted;
    if (matches) {
      return page;
    }
  }
  return null;
}

/** The field name of a paginated field: the response key is never carried on the spec (§3.2). */
function pageKeyName(field: FieldSpec): string {
  return fieldNameOf(field.keyRaw);
}

/** Every record a layer wrote or deleted, for record-level invalidation. */
function recordsOf(layer: CacheLayer): RecordId[] {
  const records = new Set<RecordId>(layer.deleted);
  for (const recordId of layer.fields.keys()) {
    records.add(recordId);
  }
  for (const recordId of layer.links.keys()) {
    records.add(recordId);
  }
  return [...records];
}

/** The validated pieces of a snapshot, ready to be applied. */
interface ValidatedSnapshot {
  readonly storage: {
    readonly records: Record<RecordId, Record<string, unknown>>;
    readonly links: Record<RecordId, Record<string, string | readonly string[] | null>>;
  };
  readonly lists: Record<
    string,
    { readonly type: string; readonly connection: boolean; readonly ids: readonly RecordId[] }
  >;
  readonly pages: Record<PageKey, SerializedPage>;
  readonly fetchedAt: number;
}

/** Validates a snapshot completely, so hydration is atomic (§6.10). */
function validateSnapshot(snapshot: unknown): ValidatedSnapshot {
  const root = asObject(snapshot);
  if (root === null) {
    fail(Number.NaN, 'the payload is not an object');
  }
  const version = root['v'];
  if (version !== SNAPSHOT_VERSION) {
    fail(
      typeof version === 'number' ? version : Number.NaN,
      `expected snapshot version ${SNAPSHOT_VERSION}`,
    );
  }
  const compiler = root['compiler'];
  if (typeof compiler !== 'string') {
    fail(SNAPSHOT_VERSION, 'the payload has no compiler version');
  }
  if (major(compiler) !== major(COMPILER_VERSION)) {
    fail(SNAPSHOT_VERSION, `the payload was built by compiler ${compiler}`);
  }

  const records = validateRecords(root['records']);
  const links = validateLinks(root['links']);
  const lists = validateLists(root['lists']);
  const pages = validatePages(root['pages']);
  const fetchedAt = root['fetchedAt'];
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) {
    fail(SNAPSHOT_VERSION, 'the payload has no fetchedAt timestamp');
  }

  return { storage: { records, links }, lists, pages, fetchedAt };
}

function validateRecords(value: unknown): Record<RecordId, Record<string, unknown>> {
  const table = asObject(value);
  if (table === null) {
    fail(SNAPSHOT_VERSION, 'the records table is not an object');
  }
  const out: Record<RecordId, Record<string, unknown>> = {};
  for (const [recordId, fields] of Object.entries(table)) {
    const record = asObject(fields);
    if (record === null) {
      fail(SNAPSHOT_VERSION, `record "${recordId}" is not an object`);
    }
    out[recordId] = { ...record };
  }
  return out;
}

function validateLinks(
  value: unknown,
): Record<RecordId, Record<string, string | readonly string[] | null>> {
  const table = asObject(value);
  if (table === null) {
    fail(SNAPSHOT_VERSION, 'the links table is not an object');
  }
  const out: Record<RecordId, Record<string, string | readonly string[] | null>> = {};
  for (const [recordId, fields] of Object.entries(table)) {
    const record = asObject(fields);
    if (record === null) {
      fail(SNAPSHOT_VERSION, `link record "${recordId}" is not an object`);
    }
    const links: Record<string, string | readonly string[] | null> = {};
    for (const [field, target] of Object.entries(record)) {
      if (typeof target === 'string' || target === null) {
        links[field] = target;
      } else if (Array.isArray(target) && target.every((entry) => typeof entry === 'string')) {
        links[field] = [...target];
      } else {
        fail(
          SNAPSHOT_VERSION,
          `link "${recordId}.${field}" is not a record id, an id array or null`,
        );
      }
    }
    out[recordId] = links;
  }
  return out;
}

function validateLists(
  value: unknown,
): Record<
  string,
  { readonly type: string; readonly connection: boolean; readonly ids: readonly RecordId[] }
> {
  const table = asObject(value);
  if (table === null) {
    fail(SNAPSHOT_VERSION, 'the lists table is not an object');
  }
  const out: Record<string, { type: string; connection: boolean; ids: readonly RecordId[] }> = {};
  for (const [name, list] of Object.entries(table)) {
    const entry = asObject(list);
    if (
      entry === null ||
      typeof entry['type'] !== 'string' ||
      typeof entry['connection'] !== 'boolean'
    ) {
      fail(SNAPSHOT_VERSION, `list "${name}" has no type/connection`);
    }
    const ids = entry['ids'];
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      fail(SNAPSHOT_VERSION, `list "${name}" has no id array`);
    }
    out[name] = { type: entry['type'], connection: entry['connection'], ids: [...ids] };
  }
  return out;
}

function validatePages(value: unknown): Record<PageKey, SerializedPage> {
  const table = asObject(value);
  if (table === null) {
    fail(SNAPSHOT_VERSION, 'the pages table is not an object');
  }
  const out: Record<PageKey, SerializedPage> = {};
  for (const [key, page] of Object.entries(table)) {
    const entry = asObject(page);
    if (entry === null) {
      fail(SNAPSHOT_VERSION, `page "${key}" is not an object`);
    }
    const path = entry['path'];
    if (!Array.isArray(path) || !path.every((step) => typeof step === 'string')) {
      fail(SNAPSHOT_VERSION, `page "${key}" has no path`);
    }
    const edges = entry['edges'];
    if (!Array.isArray(edges)) {
      fail(SNAPSHOT_VERSION, `page "${key}" has no edges`);
    }
    const parsedEdges: { cursor: string | null; id: RecordId }[] = [];
    for (const edge of edges) {
      const parsed = asObject(edge);
      if (parsed === null || typeof parsed['id'] !== 'string') {
        fail(SNAPSHOT_VERSION, `page "${key}" has an edge without an id`);
      }
      parsedEdges.push({
        cursor: typeof parsed['cursor'] === 'string' ? parsed['cursor'] : null,
        id: parsed['id'],
      });
    }
    const info = asObject(entry['pageInfo']);
    if (info === null) {
      fail(SNAPSHOT_VERSION, `page "${key}" has no pageInfo`);
    }
    const ids = entry['ids'];
    const parsedIds =
      Array.isArray(ids) && ids.every((id) => typeof id === 'string')
        ? [...ids]
        : parsedEdges.map((edge) => edge.id);
    const mode = entry['mode'];
    out[key] = {
      path: [...path],
      ids: parsedIds,
      edges: parsedEdges,
      pageInfo: {
        startCursor: typeof info['startCursor'] === 'string' ? info['startCursor'] : null,
        endCursor: typeof info['endCursor'] === 'string' ? info['endCursor'] : null,
        hasNextPage: info['hasNextPage'] === true,
        hasPreviousPage: info['hasPreviousPage'] === true,
      },
      complete: entry['complete'] === true,
      mode: mode === 'Infinite' ? 'Infinite' : 'SinglePage',
    };
  }
  return out;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** The leading `major` of a semver-ish version string, or the whole string when it has none. */
function major(version: string): string {
  return version.split('.')[0] ?? version;
}

/** Raises the one typed error `hydrate` has for a snapshot it cannot trust (§6.10 rule 7). */
function fail(found: number, problem: string): never {
  throw new SnapshotVersionMismatchError(
    `Cannot hydrate the cache: ${problem}. The cache was left untouched.`,
    found,
    { hint: 'discard the payload and start from an empty cache, or regenerate it' },
  );
}

/** The `edges`/`node` selection of a connection site, or `null` when it has no edges (§6.7). */
function connectionEdges(site: ConnectionSite): {
  readonly edgesName: string;
  readonly edgesSpec: FieldSpec;
  readonly nodeName: string;
  readonly nodeSpec: FieldSpec;
} | null {
  const edgesName = responseKeyFor(site.field.selection, 'edges');
  if (edgesName === undefined) {
    return null;
  }
  const edgesSpec = site.field.selection?.fields?.[edgesName];
  if (edgesSpec === undefined) {
    return null;
  }
  const nodeName = responseKeyFor(edgesSpec.selection, 'node');
  const nodeSpec = nodeName === undefined ? undefined : edgesSpec.selection?.fields?.[nodeName];
  if (nodeName === undefined || nodeSpec === undefined) {
    return null;
  }
  return { edgesName, edgesSpec, nodeName, nodeSpec };
}
