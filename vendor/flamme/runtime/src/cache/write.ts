/**
 * `write`: the payload walker (§6.4, §6.12).
 *
 * The writer mirrors the reader: it walks the selection and the payload together, decides per field
 * whether the value is a scalar, an inlined embedded object (no record, §4.5.1), a link to a record,
 * or a link array, and reports the `(record, field)` pairs it wrote. Those pairs are the input to
 * the dirty set, which is why a write is field-precise and a component that selected `name` is never
 * woken by a write to `favorite`.
 */
import type { FieldSpec, RecordId, SubscriptionSelection, Variables } from '../artifact.js';
import type { CacheLayer, WriteOptions } from '../cache.js';
import { evaluateValue, isIncluded, whenSatisfied } from '../directives.js';
import type { FieldRef, WriteContext, WriteOutcome } from './internal.js';
import { asRecord, computeID, evaluateKey, recordIdFor, responseKeyFor } from './keys.js';
import type { ResolvedField } from './storage.js';

/** Per-write mutable state: the layer to write into, the merge directions and the touched sets. */
interface WriteState {
  readonly context: WriteContext;
  readonly variables: Variables;
  readonly layer: CacheLayer;
  readonly applyUpdates: readonly ('append' | 'prepend')[];
  readonly records: Set<RecordId>;
  readonly fields: Set<string>;
  readonly changes: Map<string, FieldRef>;
}

/** Walks a payload and a selection together, writing every field they agree on. */
export function writeSelection(context: WriteContext, options: WriteOptions): WriteOutcome {
  const state: WriteState = {
    context,
    variables: options.variables ?? {},
    // A payload with no explicit layer is a **confirmed** payload (a query, a page or a
    // subscription response), and confirmed data belongs to the base layer. Defaulting to
    // `topLayer()` made a request answered while a mutation's optimistic layer was open write
    // *into* that layer: `serialize()` is base-only, so the confirmed data was missing from the
    // wire snapshot, and the mutation's rollback destroyed it in memory (§6.2, §6.10 rule 6).
    layer: options.layer ?? context.storage.baseLayer(),
    applyUpdates: options.applyUpdates ?? [],
    records: new Set(),
    fields: new Set(),
    changes: new Map(),
  };

  writeRecord(state, options.selection, options.parent ?? '_ROOT_', options.data);

  return {
    records: [...state.records],
    fields: [...state.fields],
    changes: [...state.changes.values()],
  };
}

/** Writes one record's worth of payload: its own selection, then every registered spread. */
function writeRecord(
  state: WriteState,
  selection: SubscriptionSelection,
  recordId: RecordId,
  data: unknown,
): void {
  const record = asRecord(data);
  if (record === null) {
    return;
  }
  touch(state, recordId);

  for (const [name, spec] of Object.entries(selection.fields ?? {})) {
    if (!Object.hasOwn(record, name)) {
      continue;
    }
    // A field a conditional spread contributed is only part of the selection when its
    // `@when`/`@when_not` variable says so: the payload may still carry it (the directive is
    // compiler-only and never reaches the wire document), and storing it would make the field
    // readable as data the selection does not hold.
    if (!isIncluded(spec, state.variables)) {
      continue;
    }
    writeField(state, spec, recordId, evaluateKey(spec.keyRaw, state.variables), record[name]);
  }

  // fragment fields are written from the same payload through the registered fragment selections;
  // masking is a *read* rule (§6.4), so a spread whose fragment is unknown simply contributes nothing
  for (const [name, spread] of Object.entries(selection.fragments ?? {})) {
    if (spread.when !== undefined && !whenSatisfied(spread.when, state.variables)) {
      continue;
    }
    const fragment = state.context.fragments.get(name);
    if (fragment !== undefined) {
      writeRecord(state, fragment, recordId, record);
    }
  }
}

/** Writes one field: scalar, inlined embedded value, link, link array, or connection record. */
function writeField(
  state: WriteState,
  spec: FieldSpec,
  recordId: RecordId,
  fieldKey: string,
  raw: unknown,
): void {
  const before = state.context.storage.resolve(recordId, fieldKey);

  if (spec.selection === undefined) {
    const scalar = mergeScalar(state, spec, before, raw);
    state.context.storage.set(recordId, fieldKey, unmarshal(state, spec, scalar), state.layer);
    mark(state, recordId, fieldKey, before);
    return;
  }
  const value = raw;

  if (value === null) {
    state.context.storage.setLink(recordId, fieldKey, null, state.layer);
    mark(state, recordId, fieldKey, before);
    return;
  }

  if (Array.isArray(value)) {
    writeArrayField(state, spec, recordId, fieldKey, value, before);
    return;
  }

  const single = asRecord(value);
  if (single === null) {
    state.context.storage.set(recordId, fieldKey, value, state.layer);
    mark(state, recordId, fieldKey, before);
    return;
  }

  const type = concreteType(spec, single);
  const id = recordIdFor(state.context.config, type, single);
  if (id === null && !needsRecord(spec)) {
    // an embedded composite is inlined in its parent and never becomes a record (§4.5.1)
    state.context.storage.set(recordId, fieldKey, value, state.layer);
    mark(state, recordId, fieldKey, before);
    return;
  }

  // a connection under `@paginate`/`@list` gets its own record even when its element type is
  // embedded, so pages and membership stay addressable (§4.5.1, §6.3 third form)
  const target = id ?? `${type}:${recordId}:${fieldKey}`;
  state.context.storage.setLink(recordId, fieldKey, target, state.layer);
  mark(state, recordId, fieldKey, before);
  writeRecord(state, selectionForWrite(spec, type), target, single);

  if (spec.list?.connection === true) {
    seedMembership(state, spec, connectionNodeIds(state, spec, single, target));
    // §6.7: remember where this named connection lives, so a later mutation insert can
    // synthesize an edge into its `edges` array without a refetch.
    state.context.lists.rememberConnection({
      name: spec.list.name,
      parentId: recordId,
      fieldKey,
      connectionId: target,
      field: spec,
      variables: state.variables,
    });
  }
}

/** Writes a list value: an inline JSON array, or an array of links plus `@list` membership. */
function writeArrayField(
  state: WriteState,
  spec: FieldSpec,
  recordId: RecordId,
  fieldKey: string,
  value: readonly unknown[],
  before: ResolvedField,
): void {
  // An element is a link when its type has key fields the payload satisfies; the decision is per
  // element, never from `value[0]` alone, because one key-less element would otherwise turn a link
  // array into the mixed array the read path cannot represent (§4.5.1, `review-f1`).
  const elements: (readonly [Readonly<Record<string, unknown>>, string, RecordId | null])[] = [];
  for (const element of value) {
    const single = asRecord(element);
    if (single === null) {
      continue;
    }
    const elementType = concreteType(spec, single);
    elements.push([single, elementType, recordIdFor(state.context.config, elementType, single)]);
  }
  // a field holds either links or inline JSON, never both: an array that already holds links stays
  // a link array, so a later insert can never downgrade the server's ids to inline objects
  const storedLinks = before.found && before.link && Array.isArray(before.value);
  const links = storedLinks || elements.some(([, , id]) => id !== null);
  // An empty array has no payload to inspect: the type is embedded unless the compiler configured
  // keys for it (only the compiler knows which types actually have key fields, §4.5.1). A
  // non-empty array with no addressable element is embedded whatever the configured keys say.
  const embedded = !links && (value.length > 0 || state.context.config.keys?.[spec.type] === undefined);

  if (embedded) {
    // an array of embedded elements is inlined as JSON; there is nothing addressable to list
    const merged = mergeInlineArray(state, spec, before, value);
    state.context.storage.set(recordId, fieldKey, merged, state.layer);
    mark(state, recordId, fieldKey, before);
    if (spec.list !== undefined) {
      seedMembership(state, spec, []);
    }
    return;
  }

  const targets: RecordId[] = [];
  for (const [single, elementType, id] of elements) {
    // A key-less element inside a link array still needs an address: `computeID` degrades it to a
    // deterministic payload id (and throws in dev when the type's keys are an explicit contract),
    // which keeps the array homogeneous instead of dropping the element or inlining it (FLM4001).
    const target =
      id ?? `${elementType}:${computeID(state.context.config, elementType, single)}`;
    targets.push(target);
    writeRecord(state, selectionForWrite(spec, elementType), target, single);
  }

  // a link array merges *ids*, not payloads: the merge happens once the payload's ids exist
  const merged = mergeLinkArray(state, spec, before, targets);
  state.context.storage.setLink(recordId, fieldKey, merged, state.layer);
  mark(state, recordId, fieldKey, before);

  if (spec.list !== undefined) {
    seedMembership(state, spec, merged);
  }
}

/**
 * Seeds `@list` membership from a written payload (§6.7).
 *
 * On the base layer the payload *adds* to the membership instead of replacing it: the ids a
 * payload lists are the server's confirmed membership, while ids already in the base came from a
 * confirmed mutation operation. Overwriting would drop an id the server confirmed (the
 * `optimistic` + response flow of §7.4, `review-slice34-adversarial.md` M2/M3), so the payload's
 * ids keep their order and any confirmed id the payload does not mention follows them.
 *
 * The declaring field's arguments are resolved against this write's variables and remembered with
 * the registration: a mutation operation's `@when`/`@when_not` compares the mutation's own
 * variables against exactly these values (§6.7).
 */
function seedMembership(state: WriteState, spec: FieldSpec, ids: readonly RecordId[]): void {
  const list = spec.list;
  if (list === undefined) {
    return;
  }
  state.context.lists.register(list.name, list, resolveFilters(spec, state.variables));
  const base = state.context.storage.baseLayer();
  const stored = state.layer === base ? state.context.lists.ids(list.name, base) : [];
  const next = [...ids];
  for (const id of stored) {
    if (!next.includes(id)) {
      next.push(id);
    }
  }
  state.context.lists.seed(list.name, next, state.layer);
}

/**
 * The declaring field's `filters` with every artifact value resolved against the write's variables,
 * or `undefined` when the field declares none (which leaves the manager's stored filters alone).
 */
function resolveFilters(
  spec: FieldSpec,
  variables: Variables,
): Readonly<Record<string, unknown>> | undefined {
  if (spec.filters === undefined) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(spec.filters)) {
    out[name] = evaluateValue(value, variables);
  }
  return out;
}

/** The membership ids of a connection list: one per `edges[].node` (§7.4). */
function connectionNodeIds(
  state: WriteState,
  spec: FieldSpec,
  connection: Readonly<Record<string, unknown>>,
  connectionId: RecordId,
): RecordId[] {
  // the payload is keyed by response key while the spec keeps the field name, so `myEdges: edges`
  // has to be located by name and indexed by its response key (C3)
  const edgesName = responseKeyFor(spec.selection, 'edges');
  if (edgesName === undefined) {
    return [];
  }
  const edges = connection[edgesName];
  if (!Array.isArray(edges)) {
    return [];
  }
  const edgesField = spec.selection?.fields?.[edgesName];
  const nodeName = responseKeyFor(edgesField?.selection, 'node');
  if (nodeName === undefined) {
    return [];
  }
  const nodeSpec = edgesField?.selection?.fields?.[nodeName];
  const ids: RecordId[] = [];
  for (const edge of edges) {
    const node = asRecord(asRecord(edge)?.[nodeName]);
    if (node === null) {
      continue;
    }
    const type =
      nodeSpec !== undefined &&
      nodeSpec.abstractFields !== undefined &&
      typeof node['__typename'] === 'string'
        ? node['__typename']
        : (nodeSpec?.type ?? spec.list?.type ?? spec.type);
    // an embedded node has no record of its own, so the connection record is the addressable entry
    ids.push(recordIdFor(state.context.config, type, node) ?? connectionId);
  }
  return ids;
}

/**
 * The selection to write into a target record: for an abstract field, the base selection merged with
 * the branch that matched the payload's concrete type (§3.2).
 */
function selectionForWrite(spec: FieldSpec, type: string): SubscriptionSelection {
  const base = spec.selection ?? {};
  const branch = spec.abstractFields?.[type];
  if (branch === undefined) {
    return base;
  }
  return {
    fields: { ...base.fields, ...branch.fields },
    fragments: { ...base.fragments, ...branch.fragments },
    abstractFields: { ...base.abstractFields, ...branch.abstractFields },
  };
}

/** The concrete type of a payload: the `__typename` for an abstract selection, else the field type. */
function concreteType(spec: FieldSpec, value: Readonly<Record<string, unknown>>): string {
  if (spec.abstractFields !== undefined) {
    const typename = value['__typename'];
    if (typeof typename === 'string') {
      return typename;
    }
  }
  return spec.type;
}

/** `true` when the field must be addressable as a record whatever its element type is. */
function needsRecord(spec: FieldSpec): boolean {
  return spec.pagination !== undefined || spec.list !== undefined;
}

/** The merge direction this write applies to a field, or `null` when there is none (§6.8). */
function mergeDirection(state: WriteState, spec: FieldSpec): 'append' | 'prepend' | null {
  if (spec.updates === undefined || state.applyUpdates.length === 0) {
    return null;
  }
  return spec.updates.find((entry) => state.applyUpdates.includes(entry)) ?? null;
}

/** A scalar with `append` moves forward; one with `prepend` keeps the older value (pageInfo). */
function mergeScalar(
  state: WriteState,
  spec: FieldSpec,
  before: ResolvedField,
  value: unknown,
): unknown {
  const direction = mergeDirection(state, spec);
  if (direction === null || !before.found) {
    return value;
  }
  return direction === 'append' ? value : (before.value ?? value);
}

/** Merges an inlined array with the array already stored in the same place. */
function mergeInlineArray(
  state: WriteState,
  spec: FieldSpec,
  before: ResolvedField,
  value: readonly unknown[],
): readonly unknown[] {
  const direction = mergeDirection(state, spec);
  // a stored link array is never a merge target for inline JSON: mixing the two representations in
  // one field is unrepresentable, so the inline payload replaces it (or, for an append, the caller
  // had a link array to keep and did not take this branch)
  if (direction === null || !before.found || before.link || !Array.isArray(before.value)) {
    return value;
  }
  const previous = before.value;
  return direction === 'append' ? [...previous, ...value] : [...value, ...previous];
}

/** Merges a link array with the ids already stored, honouring the field's direction metadata. */
function mergeLinkArray(
  state: WriteState,
  spec: FieldSpec,
  before: ResolvedField,
  targets: readonly RecordId[],
): RecordId[] {
  const direction = mergeDirection(state, spec);
  if (direction === null || !before.found || !before.link || !Array.isArray(before.value)) {
    return [...targets];
  }
  const previous = before.value.filter((entry): entry is RecordId => typeof entry === 'string');
  return direction === 'append' ? [...previous, ...targets] : [...targets, ...previous];
}

/** Applies the configured scalar unmarshal to a leaf value, once, at write time. */
function unmarshal(state: WriteState, spec: FieldSpec, value: unknown): unknown {
  const scalars = state.context.config.scalars;
  if (scalars === undefined) {
    return value;
  }
  const scalarUnmarshal = scalars[spec.type]?.unmarshal;
  return scalarUnmarshal === undefined ? value : scalarUnmarshal(value);
}

/**
 * Records one written field. A field whose value did not change is written but is *not* reported as
 * a change: that is what keeps a mutation payload that re-states `id`/`__typename` from dirtying
 * every key that selects them, and it is what the §6.12 worked example asserts (the `ToggleFavorite`
 * payload writes `Species:1.id` and only the key that selected `favorite` is dirty).
 */
function mark(
  state: WriteState,
  recordId: RecordId,
  fieldKey: string,
  before: ResolvedField,
): void {
  state.fields.add(fieldKey);
  const after = state.context.storage.resolve(recordId, fieldKey);
  if (
    !before.found ||
    !after.found ||
    before.link !== after.link ||
    !sameValue(before.value, after.value)
  ) {
    state.changes.set(`${recordId}\u0000${fieldKey}`, [recordId, fieldKey]);
  }
  state.context.stale.markFresh(recordId, fieldKey, state.layer.id);
}

/** `Object.is`, with a shallow comparison for the link arrays the storage copies on write. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((entry, index) => Object.is(entry, right[index]))
    );
  }
  return false;
}

/** Records one touched record for the GC and the result's `records` list. */
function touch(state: WriteState, recordId: RecordId): void {
  if (!state.records.has(recordId)) {
    state.records.add(recordId);
    state.context.gc.touch(recordId);
  }
}
