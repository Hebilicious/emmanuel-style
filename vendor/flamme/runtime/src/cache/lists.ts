/**
 * The list manager (§6.7).
 *
 * A `@list(name:)` field's membership is an ordered id array stored as a link array under the
 * synthetic record `List:<name>`, keyed by one synthetic field. That choice is what makes every
 * list operation layer-scoped for free: an optimistic toggle writes the new array into the
 * mutation's layer, so rolling the layer back restores the previous array without an undo log, and
 * serialization reads the same table the reads do.
 */
import type {
  FieldSpec,
  ListOperation,
  ListSpec,
  ListWhen,
  RecordId,
  SubscriptionSelection,
  Variables,
} from '../artifact.js';
import type { CacheLayer, ListHandle, ListSnapshot } from '../cache.js';
import { devWarn } from '../dev.js';
import { evaluateValue } from '../directives.js';
import { UnknownListError } from '../errors.js';
import type { FieldRef } from './internal.js';
import { asRecord } from './keys.js';
import type { InMemoryStorage } from './storage.js';

/** The synthetic record prefix: `List:FavoriteSpecies` (§6.7). */
const LIST_PREFIX = 'List:';

/** The synthetic field the membership array lives under on `List:<name>`. */
export const LIST_IDS_FIELD = 'ids';

/** The record id of a named list. */
export function listRecordId(name: string): RecordId {
  return `${LIST_PREFIX}${name}`;
}

/** The list name a `List:<name>` record id holds, or `null` when the id is not a list record. */
export function listNameOf(recordId: RecordId): string | null {
  return recordId.startsWith(LIST_PREFIX) ? recordId.slice(LIST_PREFIX.length) : null;
}

/**
 * The opaque id `@includeListID` exposes as `__id` and `@listID(value:)` accepts: the record that
 * holds the list field plus the list name (`lists.ts:14-16`, e.g. `User:1::All_Items`).
 */
export function opaqueListID(parentId: RecordId, name: string): string {
  return `${parentId}::${name}`;
}

/** The `(parent, name)` an opaque list id encodes, or `null` when it is not one. */
function parseOpaqueListID(
  value: string,
): { readonly parentId: string; readonly name: string } | null {
  const separator = value.indexOf('::');
  if (separator <= 0 || separator === value.length - 2) {
    return null;
  }
  return { parentId: value.slice(0, separator), name: value.slice(separator + 2) };
}

/**
 * The `ListSpec` a selection declares for a list name, or `null` when nothing declares it.
 *
 * The compiler emits `@list(name:)` on the field that declares the list, so a mutation whose
 * payload carries an operation for that list also carries the registration. Both `writeSelection`
 * (a query seeding membership) and `applyOperations` (a mutation operation arriving before the
 * list's own query) register through this lookup, so an early click can never be dropped for a
 * registration that only the *other* document happens to hold (`review-slice34-adversarial.md` M2).
 */
export function listSpecFor(selection: SubscriptionSelection, name: string): ListSpec | null {
  for (const field of Object.values(selection.fields ?? {})) {
    if (field.list?.name === name) {
      return field.list;
    }
    if (field.selection === undefined) {
      continue;
    }
    const nested = listSpecFor(field.selection, name);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

/** Callbacks the cache supplies so a list write participates in invalidation and GC. */
export interface ListManagerOptions {
  /** `(recordId, field)` pairs whose data changed, for the dirty set (§6.12 rule 5). */
  readonly onChange?: (refs: readonly FieldRef[]) => void;
  /** Records removed from the cache entirely, which dirties every key touching them (rule 3). */
  readonly onRecordsChanged?: (recordIds: readonly RecordId[]) => void;
  /**
   * A list's registration changed: the name is new, or its `type`/`connection` was replaced.
   *
   * Registration is part of the serialized `lists` section even when membership never moves, so a
   * consumer that encodes a snapshot incrementally has to hear about it (§6.10).
   */
  readonly onRegister?: (name: string) => void;
  /**
   * A connection gained a member: synthesize the edge Houdini writes so `edges` reflects a
   * local insert before any refetch (§6.7, `cache/lists.ts:310-362`).
   */
  readonly onConnectionInsert?: (info: ConnectionInsert) => void;
  /** A connection lost a member: drop the edge that pointed at it. */
  readonly onConnectionRemove?: (info: ConnectionRemove) => void;
}

/**
 * Where a named connection lives: the record holding the field, the connection record itself, and
 * the field spec whose `edges` selection an insert has to satisfy.
 *
 * Houdini keeps one list instance per `(name, parent record)`; Flamme keeps one membership array per
 * name, so an operation targets the site of the last write of that name unless `@allLists` asks for
 * every remembered site or `@listID` names one parent outright (the same single-array simplification
 * `List:<name>` already makes).
 */
export interface ConnectionSite {
  readonly name: string;
  /** The record holding the connection field (`_ROOT_` for a root field). */
  readonly parentId: RecordId;
  /** The connection field's evaluated cache key. */
  readonly fieldKey: string;
  /** The connection's own record. */
  readonly connectionId: RecordId;
  /** The connection field's spec, which carries the `edges`/`node` selection. */
  readonly field: FieldSpec;
  /** The variables the connection was written with, for evaluating nested keys. */
  readonly variables: Variables;
}

/** One connection insert. */
export interface ConnectionInsert {
  readonly site: ConnectionSite;
  readonly nodeId: RecordId;
  readonly position: 'first' | 'last';
  readonly layer: CacheLayer;
}

/** One connection removal. */
export interface ConnectionRemove {
  readonly site: ConnectionSite;
  readonly nodeId: RecordId;
  readonly layer: CacheLayer;
}

/** Where one connection operation's synthesized edge goes (`@allLists`, `@listID`). */
interface EdgeTarget {
  /** `@allLists`: fan the edge out to every remembered site of the name. */
  readonly all?: boolean;
  /** `@listID`: the parent the opaque id named; only that parent's connection takes the edge. */
  readonly parentId?: RecordId;
}

/** Named ordered id lists with six layer-scoped operations. */
export class ListManager {
  readonly #storage: InMemoryStorage;
  readonly #onChange: ((refs: readonly FieldRef[]) => void) | undefined;
  readonly #onRecordsChanged: ((recordIds: readonly RecordId[]) => void) | undefined;
  readonly #onRegister: ((name: string) => void) | undefined;
  readonly #onConnectionInsert: ((info: ConnectionInsert) => void) | undefined;
  readonly #onConnectionRemove: ((info: ConnectionRemove) => void) | undefined;
  readonly #lists = new Map<string, ListSpec>();
  /**
   * Where each named connection was written, **most recent first**, deduped by
   * `(parentId, fieldKey)`. A connection insert or remove targets the first site unless the
   * operation says otherwise (§6.7, `@allLists`).
   */
  readonly #sites = new Map<string, ConnectionSite[]>();
  /**
   * The declaring field's arguments, resolved at write time, per list name (§6.7). `@when` and
   * `@when_not` compare a mutation's own conditions against these; a name with no entry has no
   * stored filters, and every filter lookup on it is `undefined`.
   */
  readonly #filters = new Map<string, Readonly<Record<string, unknown>>>();

  constructor(storage: InMemoryStorage, options: ListManagerOptions = {}) {
    this.#storage = storage;
    this.#onChange = options.onChange;
    this.#onRecordsChanged = options.onRecordsChanged;
    this.#onRegister = options.onRegister;
    this.#onConnectionInsert = options.onConnectionInsert;
    this.#onConnectionRemove = options.onConnectionRemove;
  }

  /** Remembers where a named connection's field and record live (`writeField`, §6.7). */
  rememberConnection(site: ConnectionSite): void {
    const sites = this.#sites.get(site.name) ?? [];
    const next = sites.filter(
      (entry) => entry.parentId !== site.parentId || entry.fieldKey !== site.fieldKey,
    );
    next.unshift(site);
    this.#sites.set(site.name, next);
  }

  /**
   * Registers a list by name; the first registration's element type wins (FLM1012 is a build error).
   *
   * `filters` are the declaring field's arguments already resolved against the writing document's
   * variables. A registration that carries them replaces what was stored, so a later write under
   * different arguments retargets `@when`/`@when_not`; a registration without them (the mutation
   * payload's own `listSpecFor` lookup) leaves the stored ones alone.
   */
  register(name: string, spec: ListSpec, filters?: Readonly<Record<string, unknown>>): void {
    const existing = this.#lists.get(name);
    if (existing !== undefined && existing.type !== spec.type) {
      return;
    }
    const changed =
      existing === undefined ||
      existing.connection !== spec.connection ||
      existing.type !== spec.type;
    this.#lists.set(name, spec);
    if (filters !== undefined) {
      this.#filters.set(name, filters);
    }
    if (changed) {
      this.#onRegister?.(name);
    }
  }

  /** `true` when a list with this name is registered. */
  has(name: string): boolean {
    return this.#lists.has(name);
  }

  /** The registration for a list, or `null`. */
  spec(name: string): ListSpec | null {
    return this.#lists.get(name) ?? null;
  }

  /** The imperative handle for a registered list; an unknown name is FLM4003. */
  list(name: string): ListHandle {
    const spec = this.#lists.get(name);
    if (spec === undefined) {
      throw new UnknownListError(
        `Unknown list "${name}": no @list(name: "${name}") field has been written or registered.`,
        name,
        { hint: `check the @list(name:) spelling, or write the field that declares it first` },
      );
    }

    return {
      name,
      type: spec.type,
      connection: spec.connection,
      insert: (recordId, position, options) => {
        this.#insert(spec, recordId, position, layerOf(this.#storage, options), undefined);
      },
      remove: (recordId, options) => {
        this.#remove(spec, recordId, layerOf(this.#storage, options), undefined);
      },
      toggle: (recordId, options) => {
        const ids = this.ids(name);
        const layer = layerOf(this.#storage, options);
        const present = ids.includes(recordId);
        this.#write(
          name,
          present ? ids.filter((id) => id !== recordId) : [...ids, recordId],
          layer,
        );
        if (present) {
          this.#onRemove(spec, recordId, layer, undefined);
        } else {
          this.#onInsert(spec, recordId, 'last', layer, undefined);
        }
      },
      upsert: (recordId, position, options) => {
        const ids = this.ids(name);
        const layer = layerOf(this.#storage, options);
        if (ids.includes(recordId)) {
          // already a member: Houdini writes the node's fields and touches no edge
          return;
        }
        this.#write(name, insertAt(ids, recordId, position), layer);
        this.#onInsert(spec, recordId, position, layer, undefined);
      },
      delete: (recordId, options) => {
        const layer = layerOf(this.#storage, options);
        this.#write(
          name,
          this.ids(name).filter((id) => id !== recordId),
          layer,
        );
        // the edge goes first: dropping it needs the node's record to resolve the edge that points
        // at it, and `deleteRecord` removes it (a ghost row otherwise, §6.7)
        this.#onRemove(spec, recordId, layer, undefined);
        this.#storage.deleteRecord(recordId, layer);
        this.#onRecordsChanged?.([recordId, listRecordId(name)]);
      },
      modify: (recordId, fields, options) => {
        const layer = layerOf(this.#storage, options);
        const refs: FieldRef[] = [];
        for (const [field, value] of Object.entries(fields)) {
          this.#storage.set(recordId, field, value, layer);
          refs.push([recordId, field]);
        }
        this.#onChange?.(refs);
      },
      ids: () => this.ids(name),
    };
  }

  /**
   * The current membership, resolved through the layer stack. Pass `layer` to resolve at that layer
   * only, which is what `serialize()` does: an unresolved optimistic insert must not reach the wire
   * (§6.10 rule 6, C1).
   *
   * A list the cache has never heard of answers `[]`, exactly like a confirmed empty one: only
   * {@link knownIds} can tell the two apart, and a *read* must (§6.7).
   */
  ids(name: string, layer?: CacheLayer): readonly RecordId[] {
    const stored = this.#storage.getLink(listRecordId(name), LIST_IDS_FIELD, layer);
    return Array.isArray(stored) ? stored : [];
  }

  /**
   * The membership of a list the cache knows about, or `null` when it knows nothing about it.
   *
   * The cache knows a list once it is registered (the `@list` field was written, hydrated, or a
   * mutation operation named it) **or** once a membership array exists for it in the storage. That
   * is what separates the states a reader must distinguish:
   *
   * - never registered and no membership array: `null`, a **missing** field, so a cold `@list`
   *   document reads as partial and `CacheOrNetwork` fetches instead of rendering a false empty
   *   list forever;
   * - registered (or a membership array exists) and empty, whether because the server answered `[]`
   *   or because every member was removed locally: `[]`, a **present** empty field, so the read
   *   stays a cache hit and an empty list never refetches on every read.
   */
  knownIds(name: string, layer?: CacheLayer): readonly RecordId[] | null {
    if (this.#lists.has(name) || this.#storage.has(listRecordId(name), LIST_IDS_FIELD, layer)) {
      return this.ids(name, layer);
    }
    return null;
  }

  /** Seeds membership from a written payload (the writer calls this for a `@list` field). */
  seed(name: string, ids: readonly RecordId[], layer: CacheLayer): void {
    this.#write(name, ids, layer);
  }

  /** A frozen summary of a list, or `null` when it is not registered. */
  snapshot(name: string, mask?: boolean): ListSnapshot | null {
    // `mask` is reserved: a snapshot carries membership ids and no field values, so there is
    // nothing in it for the masking rule to hide (§6.7).
    void mask;
    const spec = this.#lists.get(name);
    if (spec === undefined) {
      return null;
    }
    return {
      name,
      type: spec.type,
      connection: spec.connection,
      ids: [...this.ids(name)],
    };
  }

  /**
   * Applies one operation recorded in a mutation payload's `artifact.operations` (§6.4, §6.7).
   *
   * `variables` are the **mutation's** variables: the operation's `@when`/`@when_not` conditions are
   * resolved against them and compared with the filters the list stored when its declaring field was
   * written. An operation whose conditions do not hold is skipped entirely: no membership write, no
   * synthesized edge. `@listID` names the `(parent, list name)` an opaque id encodes, so a connection
   * edge can land in exactly that parent's connection.
   *
   * `modify` carries its fields in the payload rather than in the operation, so it is only reachable
   * through `ListHandle.modify`; an unknown action is ignored.
   */
  apply(
    operation: ListOperation,
    target: RecordId,
    layer: CacheLayer,
    variables: Variables = {},
  ): void {
    const located = this.#locate(operation, variables);
    if (!this.#whenMatches(operation.when, located.name, variables)) {
      return;
    }
    this.#storage.recordOperation(layer, operation);
    const spec = this.#lists.get(located.name);
    if (spec === undefined) {
      // FLM4003: the caller (the mutation plugin) registers a declared list before applying; a
      // direct `cache.lists.apply` for an unknown name throws rather than dropping the operation
      throw new UnknownListError(
        `Unknown list "${located.name}": no @list(name: "${located.name}") field has been written or registered.`,
        located.name,
        { hint: `check the @list(name:) spelling, or write the field that declares it first` },
      );
    }
    const edge: EdgeTarget = {
      ...(operation.target === 'all' ? { all: true } : {}),
      ...(located.parentId === null ? {} : { parentId: located.parentId }),
    };
    const position = operation.position ?? 'last';
    switch (operation.action) {
      case 'insert':
        this.#insert(spec, target, position, layer, edge);
        return;
      case 'upsert':
        this.#upsert(spec, target, position, layer, edge);
        return;
      case 'remove':
        this.#remove(spec, target, layer, edge);
        return;
      case 'toggle':
        this.#toggle(spec, target, layer, edge);
        return;
      case 'delete':
        this.#delete(spec, target, layer, edge);
        return;
      default:
        return;
    }
  }

  /**
   * The list instance an operation names: `@listID`'s opaque id when it resolves to a registered
   * list, otherwise the operation's own `list` name. An unparseable or unknown opaque id falls back
   * to the name lookup with a DEV warning, because silently ignoring the operation would be worse
   * than applying it to the instance the name resolves to.
   */
  #locate(
    operation: ListOperation,
    variables: Variables,
  ): { readonly name: string; readonly parentId: RecordId | null } {
    if (operation.listID === undefined) {
      return { name: operation.list, parentId: null };
    }
    const value = evaluateValue(operation.listID, variables);
    const parsed = typeof value === 'string' ? parseOpaqueListID(value) : null;
    if (parsed !== null && this.#lists.has(parsed.name)) {
      return parsed;
    }
    devWarn(
      `The @listID value "${typeof value === 'string' ? value : String(value)}" does not name a list the cache holds, so the operation "${operation.action}" was applied to "${operation.list}" instead (FLM4003).`,
      'pass the __id a field marked @includeListID read, or drop @listID and use @list(name:)',
    );
    return { name: operation.list, parentId: null };
  }

  /**
   * `true` when `when`'s conditions hold for the list's stored filters (§6.7).
   *
   * Every entry is resolved against the mutation's variables and compared by deep equality with the
   * filter value the declaring field's arguments resolved to. A filter the list never stored is
   * `undefined`, so an entry that resolves to `undefined` matches it. Any `must` mismatch, or any
   * `mustNot` match, drops the whole operation.
   */
  #whenMatches(when: ListWhen | undefined, name: string, variables: Variables): boolean {
    if (when === undefined) {
      return true;
    }
    const stored = this.#filters.get(name);
    for (const [key, value] of Object.entries(when.must ?? {})) {
      if (!deepEquals(stored?.[key], evaluateValue(value, variables))) {
        return false;
      }
    }
    for (const [key, value] of Object.entries(when.mustNot ?? {})) {
      if (deepEquals(stored?.[key], evaluateValue(value, variables))) {
        return false;
      }
    }
    return true;
  }

  /** Removes a record from every registered list (called when a record is evicted or deleted). */
  remove(recordId: RecordId, layer: CacheLayer): void {
    const refs: FieldRef[] = [];
    for (const name of this.#lists.keys()) {
      const ids = this.ids(name);
      if (!ids.includes(recordId)) {
        continue;
      }
      this.#write(
        name,
        ids.filter((id) => id !== recordId),
        layer,
      );
      refs.push([listRecordId(name), LIST_IDS_FIELD]);
    }
    this.#onChange?.(refs);
  }

  /** Every registered list name, in canonical order. */
  get names(): readonly string[] {
    return [...this.#lists.keys()].toSorted();
  }

  /**
   * Drops every registration. The membership arrays stay: they are storage-resident records, so
   * only `storage.reset()` (through `Cache.reset()`) removes them, which is why a list whose
   * registration was dropped still reads as present through {@link knownIds}.
   */
  clear(): void {
    this.#lists.clear();
    this.#sites.clear();
    this.#filters.clear();
  }

  /** One insert: the membership array, then the synthesized edges of every targeted site. */
  #insert(
    spec: ListSpec,
    nodeId: RecordId,
    position: 'first' | 'last',
    layer: CacheLayer,
    edge: EdgeTarget | undefined,
  ): void {
    this.#write(spec.name, insertAt(this.ids(spec.name), nodeId, position), layer);
    this.#onInsert(spec, nodeId, position, layer, edge);
  }

  /** One upsert: an existing member keeps its place and touches no edge (Houdini's rule). */
  #upsert(
    spec: ListSpec,
    nodeId: RecordId,
    position: 'first' | 'last',
    layer: CacheLayer,
    edge: EdgeTarget | undefined,
  ): void {
    const ids = this.ids(spec.name);
    if (ids.includes(nodeId)) {
      return;
    }
    this.#write(spec.name, insertAt(ids, nodeId, position), layer);
    this.#onInsert(spec, nodeId, position, layer, edge);
  }

  /** One remove: the member leaves the array and every targeted site drops its edge. */
  #remove(spec: ListSpec, nodeId: RecordId, layer: CacheLayer, edge: EdgeTarget | undefined): void {
    this.#write(
      spec.name,
      this.ids(spec.name).filter((id) => id !== nodeId),
      layer,
    );
    this.#onRemove(spec, nodeId, layer, edge);
  }

  /** One toggle: the membership flips and the matching edge is synthesized or dropped. */
  #toggle(spec: ListSpec, nodeId: RecordId, layer: CacheLayer, edge: EdgeTarget | undefined): void {
    const ids = this.ids(spec.name);
    const present = ids.includes(nodeId);
    this.#write(spec.name, present ? ids.filter((id) => id !== nodeId) : [...ids, nodeId], layer);
    if (present) {
      this.#onRemove(spec, nodeId, layer, edge);
    } else {
      this.#onInsert(spec, nodeId, 'last', layer, edge);
    }
  }

  /** One delete: the member leaves every array, the edges follow, then the record goes. */
  #delete(spec: ListSpec, nodeId: RecordId, layer: CacheLayer, edge: EdgeTarget | undefined): void {
    this.#write(
      spec.name,
      this.ids(spec.name).filter((id) => id !== nodeId),
      layer,
    );
    // the edge is dropped *before* the record: `#dropEdge` resolves the node's key fields off the
    // edge it is looking at, and a deleted record leaves it looking at a dangling link, so the
    // edge would survive the delete as a ghost row (`review-f2`, §6.7)
    this.#onRemove(spec, nodeId, layer, edge);
    this.#storage.deleteRecord(nodeId, layer);
    this.#onRecordsChanged?.([nodeId, listRecordId(spec.name)]);
  }

  /** The connection insert hook: only a connection has an `edges` array to synthesize into. */
  #onInsert(
    spec: ListSpec,
    nodeId: RecordId,
    position: 'first' | 'last',
    layer: CacheLayer,
    edge: EdgeTarget | undefined,
  ): void {
    if (!spec.connection) {
      return;
    }
    for (const site of this.#sitesFor(spec.name, edge)) {
      this.#onConnectionInsert?.({ site, nodeId, position, layer });
    }
  }

  /** The connection remove hook: the mirror of {@link #onInsert}. */
  #onRemove(
    spec: ListSpec,
    nodeId: RecordId,
    layer: CacheLayer,
    edge: EdgeTarget | undefined,
  ): void {
    if (!spec.connection) {
      return;
    }
    for (const site of this.#sitesFor(spec.name, edge)) {
      this.#onConnectionRemove?.({ site, nodeId, layer });
    }
  }

  /**
   * The sites one connection operation writes its edge into, most recent first.
   *
   * The default target is the single most recently written site, which is today's behaviour. An
   * `@allLists` operation fans out to every remembered site, and a `@listID` operation prefers the
   * site whose parent the opaque id named; an opaque id whose parent is not remembered falls back to
   * the name lookup (Houdini's `getByOpaqueID` miss, `cache/index.ts:1012-1034`). A name with no
   * remembered site answers nothing: the connection field was never written, so there is no `edges`
   * array to attach to (Houdini's `!exists` skip).
   */
  #sitesFor(name: string, edge: EdgeTarget | undefined): readonly ConnectionSite[] {
    const sites = this.#sites.get(name);
    if (sites === undefined || sites.length === 0) {
      return [];
    }
    if (edge?.parentId !== undefined) {
      const match = sites.find((site) => site.parentId === edge.parentId);
      if (match !== undefined) {
        return [match];
      }
      devWarn(
        `The @listID parent "${edge.parentId}" has no connection recorded for the list "${name}", so the edge was written into the most recently written connection instead (FLM4003).`,
        'pass the __id of a list field the cache holds, or use @allLists to target every instance',
      );
    }
    return edge?.all === true ? sites : sites.slice(0, 1);
  }

  /** Writes a membership array and reports the synthetic `(record, field)` pair that changed. */
  #write(name: string, ids: readonly RecordId[], layer: CacheLayer): void {
    this.#storage.setLink(listRecordId(name), LIST_IDS_FIELD, [...ids], layer);
    this.#onChange?.([[listRecordId(name), LIST_IDS_FIELD]]);
  }
}

/** `options.layer` or the top of the stack (§6.7: every operation takes an optional layer). */
function layerOf(storage: InMemoryStorage, options?: { layer?: CacheLayer }): CacheLayer {
  return options?.layer ?? storage.topLayer();
}

/**
 * Structural equality over the plain JSON values a filter and a resolved condition can be:
 * `Object.is` for scalars, element-wise for arrays, key-wise for objects.
 *
 * Houdini uses its `deepEquals` here (`cache/lists.ts:524-553`); this is the same rule, local so the
 * list manager carries no dependency of its own.
 */
function deepEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => deepEquals(entry, right[index]))
    );
  }
  const leftRecord = asRecord(left);
  const rightRecord = asRecord(right);
  if (leftRecord === null || rightRecord === null) {
    return false;
  }
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) {
    return false;
  }
  return keys.every(
    (key) => Object.hasOwn(rightRecord, key) && deepEquals(leftRecord[key], rightRecord[key]),
  );
}

/** Copy-on-write insert: a new array identity, and an already-present id moves to the position. */
function insertAt(
  ids: readonly RecordId[],
  recordId: RecordId,
  position: 'first' | 'last',
): RecordId[] {
  const without = ids.filter((id) => id !== recordId);
  return position === 'first' ? [recordId, ...without] : [...without, recordId];
}
