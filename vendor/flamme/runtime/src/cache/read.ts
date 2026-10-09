/**
 * `read`: the selection walker (§6.4, §6.5, D3).
 *
 * One function walks a selection against the storage and produces both the value graph and the
 * `(record, field)` pairs it resolved, because the subscription registry needs the pairs for
 * field-level invalidation and the two must never disagree about what a read touched. Masking,
 * structural sharing and loading frames are all decided here, per field, in one pass.
 */
import type {
  FieldSpec,
  FragmentReference,
  GraphQLValue,
  RecordId,
  SubscriptionSelection,
  Variables,
} from '../artifact.js';
import type { CacheLayer, ReadOptions, ReadResult } from '../cache.js';
import { evaluateValue, isIncluded } from '../directives.js';
import { markLoadingFrame, PendingValue } from '../loading.js';
import { fragmentKey } from '../mask.js';
import { REQUIRED_MISSING_TYPENAME, warnRequiredMissing } from '../required.js';
import type { FieldRef, ReadContext } from './internal.js';
import { asRecord, evaluateKey, isRecord, keyFieldsForType } from './keys.js';
import { LIST_IDS_FIELD, listRecordId, opaqueListID } from './lists.js';

/** The mutable state of one read; `refs` is the field list the registry indexes. */
interface ReadState {
  readonly context: ReadContext;
  readonly mask: boolean;
  readonly variables: Variables;
  readonly top: CacheLayer | undefined;
  readonly refs: FieldRef[];
  /**
   * How many levels below a connection field this read is, or `null` outside one.
   *
   * Houdini's `stepsFromConnection` (`cache/index.ts:1317-1336`): a connection field resets the
   * counter to 0, every descent increments it, and at 2 it stops counting. A `cursor` exactly one
   * step inside a connection is a compiler-injected value that a locally inserted edge never has,
   * so a missing one is not partial data.
   */
  stepsFromConnection: number | null;
  partial: boolean;
  stale: boolean;
}

/** The value of one field plus whether it was absent (which is what `partial` means). */
interface FieldValue {
  readonly missing: boolean;
  readonly value: unknown;
  /** The value is null because a `@required` descendant collapsed, not because the cache holds null. */
  readonly cascaded?: boolean;
}

/**
 * One record read: the value, and whether a `@required` field of this record was null or missing
 * (which the caller turns into a null at the nearest nullable position).
 */
interface RecordRead {
  readonly value: Record<string, unknown> | null;
  readonly cascaded: boolean;
}

const MISSING: FieldValue = { missing: true, value: undefined };
const CASCADED: FieldValue = { missing: false, value: null, cascaded: true };

/** Walks a selection against the storage and returns the masked value plus the resolved fields. */
export function readSelection(context: ReadContext, options: ReadOptions): ReadResult<unknown> {
  const parent = options.parent ?? '_ROOT_';
  const state = createState(context, options);

  if (options.loading === true) {
    const frame = buildFrame(state, options.selection, parent, true);
    return {
      data: frame,
      partial: false,
      stale: false,
      hasData: frame !== null,
      readFields: fieldKeys(state.refs),
    };
  }

  const outcome = readRecord(state, options.selection, parent, options.previous);
  return {
    data: outcome.value,
    partial: state.partial,
    stale: state.stale,
    hasData: outcome.value !== null,
    readFields: fieldKeys(state.refs),
  };
}

/** The subscription registry's reader: the same walk, with the field pairs the index needs. */
export function readForSubscription(
  context: ReadContext,
  options: {
    readonly selection: SubscriptionSelection;
    readonly parent: RecordId;
    readonly variables: Variables;
    readonly previous?: unknown;
  },
): { data: unknown; refs: readonly FieldRef[] } {
  const parent = options.parent;
  const state = createState(context, options);
  const data = readRecord(state, options.selection, parent, options.previous).value;
  return { data, refs: state.refs };
}

/**
 * Reads one record: the parent's own visible fields in selection order, the ` $fragments` marker,
 * and structurally shared containers (§6.5).
 *
 * `cascaded` is `true` when one of the record's own `@required` fields was null or missing: the
 * compiler marked the field that reads this record nullable, so the caller stops the null there
 * (or poisons an abstract value), which is the "null bubbles to the nearest nullable ancestor"
 * rule of `@required`.
 */
function readRecord(
  state: ReadState,
  selection: SubscriptionSelection,
  recordId: RecordId,
  previous: unknown,
  stamp?: string,
): RecordRead {
  if (!state.context.storage.hasRecord(recordId, state.top)) {
    // A missing record still resolves *which* fields the selection reads. Returning without the
    // refs (the pre-fix behaviour) dropped the key from the registry's reverse index, so a later
    // write of the record could never dirty it again (C1): the index has to outlive the data.
    pushSelectionRefs(state, selection, recordId);
    state.partial = true;
    return { value: null, cascaded: false };
  }

  const out: Record<string, unknown> = {};
  let found = 0;
  let cascade = false;
  // the counter this record's selection reads at; every field descends from that same base
  const stepsHere = state.stepsFromConnection;

  for (const [name, spec] of Object.entries(selection.fields ?? {})) {
    if (state.mask && spec.visible !== true) {
      continue;
    }
    if (!isIncluded(spec, state.variables)) {
      continue;
    }
    const fieldKey = evaluateKey(spec.keyRaw, state.variables);
    state.refs.push([recordId, fieldKey]);
    markStale(state, recordId, fieldKey);

    const embeddedCursor = fieldKey === 'cursor' && stepsHere === 1;
    state.stepsFromConnection = nextSteps(stepsHere, spec);
    const result = readField(state, spec, recordId, fieldKey, previousValue(previous, name));
    state.stepsFromConnection = stepsHere;
    if (result.missing && embeddedCursor) {
      // an edge a mutation synthesized locally has no cursor yet; that is not partial data
      if (!state.mask) {
        out[name] = null;
      }
      continue;
    }
    if (result.missing || (result.value === null && spec.required === true)) {
      state.partial = true;
      if (spec.required === true) {
        // `@required`: a null is the same as absent, and the enclosing object takes the null
        warnRequiredMissing(recordId, name);
        cascade = true;
      } else if (!state.mask) {
        out[name] = null;
      }
      continue;
    }
    if (result.cascaded === true) {
      state.partial = true;
      if (spec.abstractHasRequired === true) {
        out[name] = poison();
        found += 1;
        continue;
      }
      if (spec.nullable !== true) {
        // a non-null position: the null climbs to the nearest nullable ancestor
        cascade = true;
        continue;
      }
      // the null stops here, and a null the selection holds is data: `found` counts it
      out[name] = result.value;
      found += 1;
      continue;
    }
    found += 1;
    out[name] = result.value;
  }

  // The `@includeListID` stamp belongs in the object *before* `reuse` runs, both because a frozen
  // container cannot take a new property afterwards and because a key the previous snapshot already
  // carries is what keeps its identity across reads (§6.5 rule 1, §6.7).
  if (stamp !== undefined) {
    out['__id'] = stamp;
  }

  // The marker is the **masked** read's channel to a child fragment (§3.5, §6.4): an unmasked read
  // inlines the spread's fields instead (`$unmasked` declares no marker), so it must not carry one.
  // A spread with `@when`/`@when_not` keeps its reference either way: the reference points at the
  // parent record, which exists whatever the condition says, and the child's `$key` type is a
  // required-property shape — only the *fields* are conditional, so a child read of an excluded
  // spread reports `partial: true` with the fields absent.
  if (
    state.mask &&
    selection.fragments !== undefined &&
    Object.keys(selection.fragments).length > 0
  ) {
    out[fragmentKey] = reuseMarker(
      previousValue(previous, fragmentKey),
      buildMarker(selection, recordId, state.variables, false),
    );
    found += 1;
  }

  if (cascade) {
    return { value: null, cascaded: true };
  }
  if (found === 0) {
    return { value: null, cascaded: false };
  }
  return { value: reuse(previous, out), cascaded: false };
}

/**
 * Houdini's `stepsFromConnection` step: a connection field resets, everything else descends.
 *
 * The field is a connection when it is a `@list(name:)` connection **or** a `@paginate` one: a
 * bare `@paginate` writes no list spec, and keying the reset off `spec.list` alone left its
 * synthesized edges reporting a missing cursor as partial data (`review-f5e`, §6.7).
 */
function nextSteps(steps: number | null, spec: FieldSpec): number | null {
  let next = steps;
  if (next !== null) {
    next = next >= 2 ? null : next + 1;
  }
  if (spec.list?.connection === true || spec.pagination?.paginated === true) {
    next = 0;
  }
  return next;
}

/** The value an abstract `@required` parent reads as instead of being nulled. */
function poison(): Record<string, unknown> {
  return freeze({ __typename: REQUIRED_MISSING_TYPENAME });
}

/**
 * The `(record, field)` pairs a selection reads from one record, for a record that is not there yet.
 *
 * Masking and `@include`/`@skip` are honoured exactly as the value walk honours them, so the index a
 * missing record leaves behind is the index a present one would have produced (C1).
 */
function pushSelectionRefs(
  state: ReadState,
  selection: SubscriptionSelection,
  recordId: RecordId,
): void {
  for (const spec of Object.values(selection.fields ?? {})) {
    if (state.mask && spec.visible !== true) {
      continue;
    }
    if (!isIncluded(spec, state.variables)) {
      continue;
    }
    if (spec.list !== undefined) {
      state.refs.push([listRecordId(spec.list.name), LIST_IDS_FIELD]);
      continue;
    }
    state.refs.push([recordId, evaluateKey(spec.keyRaw, state.variables)]);
  }
}

/** One field: a list, an inline embedded value, a link, or a scalar. */
function readField(
  state: ReadState,
  spec: FieldSpec,
  recordId: RecordId,
  fieldKey: string,
  previous: unknown,
): FieldValue {
  if (spec.list !== undefined && !spec.list.connection) {
    return readListField(state, spec, recordId, previous);
  }

  const resolved = state.context.storage.resolve(recordId, fieldKey, state.top);
  if (!resolved.found) {
    return MISSING;
  }

  // An array under a composite selection is read element by element when it holds record ids: a
  // string element hydrates the record it names. The shapes are decided per element because an
  // array written before the invariant held (a snapshot from an older version) can hold both a
  // record id and an inline object, and handing out a raw record id as data is worse than
  // hydrating it (`review-f1`). An array of plain values with no embedded object in it is inline
  // JSON and stays verbatim.
  if (
    Array.isArray(resolved.value) &&
    spec.selection !== undefined &&
    (resolved.link || resolved.value.some((entry) => isRecord(entry)))
  ) {
    return readElementArray(state, spec, resolved.value, previous);
  }

  if (!resolved.link) {
    // an inlined embedded value (or a scalar): a plain JSON object, array or primitive
    const value = resolved.value;
    if (spec.selection === undefined) {
      // A stored array/object is handed out as a frozen copy, never as the cache's own value: a
      // component that mutates what it was given would otherwise rewrite the cache with no write
      // and no invalidation (`review-slice34-adversarial.md` M8). Identity is preserved across
      // reads through `previous`, so structural sharing (§6.5 rule 1) still holds.
      return { missing: false, value: copyLeaf(value, previous) };
    }
    return readInline(state, spec, value, previous);
  }

  const link = resolved.value;
  if (spec.selection === undefined) {
    // a link to a keyed record read without a sub-selection is a plain reference; an id *array*
    // (an inline `[String!]` field) is copied for the same reason as above
    return { missing: false, value: copyLeaf(link, previous) };
  }
  if (!isLinkValue(link)) {
    return { missing: false, value: null };
  }
  if (link === null) {
    return { missing: false, value: null };
  }

  const read = readRecord(
    state,
    selectionFor(state, spec, link),
    link,
    previous,
    listIDOf(spec, recordId),
  );
  if (read.cascaded) {
    return spec.abstractHasRequired === true ? { missing: false, value: poison() } : CASCADED;
  }
  return { missing: false, value: read.value === null ? null : freeze(read.value) };
}

/**
 * One stored array of a composite field, read element by element (§6.4).
 *
 * A string element is a record id (a link array), an object is an embedded value read inline, and
 * anything else is handed out as it was stored. Every element keeps its slot, so a mixed array
 * reads as the connection's edges rather than as record ids.
 */
function readElementArray(
  state: ReadState,
  spec: FieldSpec,
  value: readonly unknown[],
  previous: unknown,
): FieldValue {
  const elements: unknown[] = [];
  let cascaded = false;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const read =
      typeof entry === 'string'
        ? readRecord(
            state,
            selectionFor(state, spec, entry),
            entry,
            previousValue(previous, index),
          )
        : readInline(state, spec, entry, previousValue(previous, index));
    if (read.cascaded === true) {
      // The null of a `@required` descendant reaches this element. An abstract element keeps its
      // slot (poisoned) because only one branch declares the required child; otherwise the whole
      // list takes the null, which the compiler made room for on the field.
      if (spec.abstractHasRequired === true) {
        elements.push(poison());
        continue;
      }
      cascaded = true;
      continue;
    }
    elements.push(read.value === null ? null : freeze(read.value));
  }
  if (cascaded) {
    return CASCADED;
  }
  return { missing: false, value: reuseArray(previous, elements) };
}

/**
 * The opaque list id a field marked `@includeListID` stamps on the value it returns, or `undefined`
 * when the field does not ask for one (§6.7). The parent is the record that *holds* the field.
 */
function listIDOf(spec: FieldSpec, parentId: RecordId): string | undefined {
  const list = spec.list;
  return list !== undefined && list.includeListID === true
    ? opaqueListID(parentId, list.name)
    : undefined;
}

/** An array that may carry the runtime-stamped `__id` a `@list` field with `@includeListID` has. */
function isIDArray(value: unknown): value is readonly unknown[] & { readonly ['__id']?: string } {
  return Array.isArray(value);
}

/**
 * Attaches the opaque list id to the array a plain `@list` field reads (§6.7).
 *
 * `reuseArray` hands back a **frozen** array, so a copy is built when the id is not on it yet; an
 * array that already carries the same id (the previous read's value, reused by identity) is returned
 * untouched, which is what keeps structural sharing working across reads.
 */
function stampListID(value: unknown, id: string | undefined): unknown {
  if (id === undefined || !isIDArray(value) || value['__id'] === id) {
    return value;
  }
  return freeze(Object.assign([...value], { ['__id']: id }));
}

/**
 * `true` when a resolved link value is a record id or `null`.
 *
 * An array link value never reaches this test: {@link readField} reads a stored array element by
 * element first, so a mixed or all-id array is hydrated rather than compared to a shape.
 */
function isLinkValue(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

/** A `@list` field reads its membership array, not the payload's stale link array (§6.7). */
function readListField(
  state: ReadState,
  spec: FieldSpec,
  recordId: RecordId,
  previous: unknown,
): FieldValue {
  const list = spec.list;
  if (list === undefined) {
    return MISSING;
  }
  state.refs.push([listRecordId(list.name), LIST_IDS_FIELD]);
  // A list the cache knows nothing about is *missing*, not empty: `ids()` answers `[]` for an
  // unregistered list too, and reporting that as a present value made a cold `@list` document a
  // complete cache hit (`hasData: true`, `partial: false`), so it rendered empty forever and never
  // fetched under `CacheOrNetwork`. The field keeps its ref either way, so the response that writes
  // the membership dirties this key (§6.7, §6.12).
  const ids = state.context.lists.knownIds(list.name);
  if (ids === null) {
    return MISSING;
  }
  const elements: unknown[] = [];
  let cascaded = false;
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index] ?? '';
    const read = readRecord(
      state,
      selectionFor(state, spec, id),
      id,
      previousValue(previous, index),
    );
    if (read.cascaded) {
      if (spec.abstractHasRequired === true) {
        elements.push(poison());
        continue;
      }
      cascaded = true;
      continue;
    }
    elements.push(read.value === null ? null : freeze(read.value));
  }
  if (cascaded) {
    return CASCADED;
  }
  return {
    missing: false,
    value: stampListID(reuseArray(previous, elements), listIDOf(spec, recordId)),
  };
}

/** Reads an inlined embedded value, descending with the same selection and variable state. */
function readInline(
  state: ReadState,
  spec: FieldSpec,
  value: unknown,
  previous: unknown,
): FieldValue {
  if (Array.isArray(value)) {
    const elements: unknown[] = [];
    let cascaded = false;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (entry === null || typeof entry !== 'object') {
        elements.push(entry);
        continue;
      }
      const read = readInline(state, spec, entry, previousValue(previous, index));
      if (read.cascaded !== true) {
        elements.push(read.value);
        continue;
      }
      if (spec.abstractHasRequired === true) {
        elements.push(poison());
        continue;
      }
      cascaded = true;
    }
    if (cascaded) {
      return CASCADED;
    }
    return { missing: false, value: reuseArray(previous, elements) };
  }
  if (value === null || typeof value !== 'object') {
    return { missing: false, value };
  }
  if (!isRecord(value)) {
    return { missing: false, value };
  }
  const read = readInlineObject(state, spec.selection ?? {}, value, previous);
  if (read.cascaded) {
    return CASCADED;
  }
  return { missing: false, value: read.value === null ? null : freeze(read.value) };
}

/** The record-less twin of `readRecord`: masked fields over an inlined object (§6.4). */
function readInlineObject(
  state: ReadState,
  selection: SubscriptionSelection,
  value: Readonly<Record<string, unknown>>,
  previous: unknown,
): RecordRead {
  const out: Record<string, unknown> = {};
  let found = 0;
  let cascade = false;
  const stepsHere = state.stepsFromConnection;
  for (const [name, spec] of Object.entries(selection.fields ?? {})) {
    if (state.mask && spec.visible !== true) {
      continue;
    }
    if (!isIncluded(spec, state.variables)) {
      continue;
    }
    if (!(name in value)) {
      // an embedded edge's missing cursor is the synthesized-edge marker, not partial data
      if (evaluateKey(spec.keyRaw, state.variables) === 'cursor' && stepsHere === 1) {
        if (!state.mask) {
          out[name] = null;
        }
        continue;
      }
      state.partial = true;
      if (spec.required === true) {
        warnRequiredMissing(inlineOwner(selection, value), name);
        cascade = true;
      } else if (!state.mask) {
        out[name] = null;
      }
      continue;
    }
    const raw = value[name];
    state.stepsFromConnection = nextSteps(stepsHere, spec);
    const field = readInline(state, spec, raw, previousValue(previous, name));
    state.stepsFromConnection = stepsHere;
    if (field.cascaded === true) {
      state.partial = true;
      if (spec.abstractHasRequired === true) {
        out[name] = poison();
        found += 1;
      } else if (spec.nullable !== true) {
        cascade = true;
      } else {
        // the null stops here, and a null the selection holds is data
        out[name] = null;
        found += 1;
      }
      continue;
    }
    if (field.value === null && spec.required === true) {
      state.partial = true;
      warnRequiredMissing(inlineOwner(selection, value), name);
      cascade = true;
      continue;
    }
    found += 1;
    out[name] = field.value;
  }
  // No ` $fragments` marker here: an inlined object is not addressable as a record, so a reference
  // has no `parent` to point at. The compiler stops promising one at such a position (K1), and the
  // fragment's fields stay readable through the unmasked read, which inlines the spread (§6.4).
  if (cascade) {
    return { value: null, cascaded: true };
  }
  if (found === 0) {
    // an inlined selection that resolved nothing reads as an empty object; `reuse` keeps its
    // identity stable across reads so every enclosing container keeps its own (§6.5 rule 1)
    return { value: reuse(previous, {}), cascaded: false };
  }
  return { value: reuse(previous, out), cascaded: false };
}

/** The label a warning about an inlined object uses: its `__typename` when the payload has one. */
function inlineOwner(
  selection: SubscriptionSelection,
  value: Readonly<Record<string, unknown>>,
): string {
  const typename = value['__typename'];
  if (typeof typename === 'string') {
    return typename;
  }
  // fall back to the first field's key so the warning still names the read that produced it
  const first = Object.values(selection.fields ?? {})[0];
  return first === undefined ? 'an inlined object' : `an inlined ${first.type}`;
}

/** A loading frame: placeholders instead of stored values, marked with the runtime symbol (D3). */
function buildFrame(
  state: ReadState,
  selection: SubscriptionSelection,
  recordId: RecordId | null,
  addressable: boolean,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  let found = 0;
  for (const [name, spec] of Object.entries(selection.fields ?? {})) {
    if (state.mask && spec.visible !== true) {
      continue;
    }
    if (!isIncluded(spec, state.variables)) {
      continue;
    }
    const fieldKey = recordId === null ? spec.keyRaw : evaluateKey(spec.keyRaw, state.variables);
    // a frame for a composite belongs to the *target* record, which is where a child fragment
    // subscribes: `species`'s frame carries the `Species:1` reference (§4.5.1, D3)
    const target = frameTarget(state, spec, recordId, fieldKey);

    if (spec.loading === undefined) {
      // a field outside the loading subtree keeps its stored value in the frame
      if (recordId === null) {
        continue;
      }
      state.refs.push([recordId, fieldKey]);
      const stored = readField(state, spec, recordId, fieldKey, undefined);
      if (stored.missing) {
        state.partial = true;
        continue;
      }
      out[name] = stored.value;
      found += 1;
      continue;
    }
    out[name] = placeholder(state, spec, target.id, addressable && target.addressable);
    found += 1;
  }

  if (
    state.mask &&
    selection.fragments !== undefined &&
    Object.keys(selection.fragments).length > 0
  ) {
    // §7.1/§8.7: a frame keeps its `FragmentRef`s so it is assignable to a child's `$key`; a
    // composite the compiler does not promise a reference for keeps the key count the generated
    // frame type has and carries no marker (K1/K1c).
    const marker = buildMarker(selection, recordId, state.variables, true);
    if (addressable && Object.keys(marker).length > 0) {
      out[fragmentKey] = marker;
    }
    found += 1;
  }
  if (found === 0) {
    return null;
  }
  markLoadingFrame(out);
  return freeze(out);
}

/** Where a nested frame stands: the link target when the field is a record, else the parent. */
function frameTarget(
  state: ReadState,
  spec: FieldSpec,
  recordId: RecordId | null,
  fieldKey: string,
): { readonly id: RecordId | null; readonly addressable: boolean } {
  if (recordId === null || spec.selection === undefined) {
    return { id: recordId, addressable: false };
  }
  const link = state.context.storage.getLink(recordId, fieldKey, state.top);
  if (typeof link === 'string') {
    return { id: link, addressable: true };
  }
  if (state.context.storage.has(recordId, fieldKey, state.top)) {
    // an inlined (embedded) value has no record of its own, and neither does anything below it
    return { id: recordId, addressable: false };
  }
  // nothing written yet: the artifact's key configuration is the only signal the runtime has
  return {
    id: recordId,
    addressable: keyFieldsForType(state.context.config, spec.type).length > 0,
  };
}

/** One placeholder: `PendingValue`, or `depth` nested arrays of `count` of them (§7.2). */
function placeholder(
  state: ReadState,
  spec: FieldSpec,
  recordId: RecordId | null,
  addressable: boolean,
): unknown {
  const meta = spec.loading?.list;
  const continues = spec.loading?.kind === 'continue' && spec.selection !== undefined;
  const build = (): unknown => {
    if (!continues) {
      return PendingValue;
    }
    return buildFrame(state, spec.selection ?? {}, recordId, addressable);
  };

  if (meta === undefined) {
    return build();
  }
  let nested: unknown = build;
  for (let level = 0; level < meta.depth; level += 1) {
    const inner = nested;
    nested = Array.from({ length: meta.count }, () =>
      typeof inner === 'function' ? inner() : inner,
    );
  }
  return typeof nested === 'function' ? nested() : nested;
}

/**
 * ` $fragments`: one `{ parent, variables }` reference per spread, **flat**, keyed by
 * fragment name. This is the shape the generated types declare (`{ Name: FragmentRef }`,
 * §3.2/§9.2) and the path `useFragment` reads: `reference[' $fragments'][Name]` (§8.4).
 * A loading frame signals itself with `' $loadingFrame': true` on the composite, not
 * with a wrapper object here.
 */
function buildMarker(
  selection: SubscriptionSelection,
  recordId: RecordId | null,
  variables: Variables,
  loading: boolean,
): Record<string, FragmentReference> {
  const refs: Record<string, FragmentReference> = {};
  for (const [name, spec] of Object.entries(selection.fragments ?? {})) {
    if (loading && spec.loading !== true) {
      continue;
    }
    if (recordId === null) {
      continue;
    }
    refs[name] = { parent: recordId, variables: evaluateArguments(spec.arguments, variables) };
  }
  return refs;
}

/** `true` when a value is a flat marker previously built by this module. */
function isMarker(value: unknown): value is Record<string, FragmentReference> {
  return isRecord(value) && Object.values(value).every((entry) => isFragmentRefLike(entry));
}

/** Structural check for one `{ parent, variables }` entry of a flat marker. */
function isFragmentRefLike(value: unknown): boolean {
  return isRecord(value) && typeof value['parent'] === 'string' && isRecord(value['variables']);
}

/** Reuses the previous marker when its references are unchanged, so parents keep identity. */
function reuseMarker(
  previous: unknown,
  next: Record<string, FragmentReference>,
): Record<string, FragmentReference> {
  if (!isMarker(previous)) {
    return freeze(next);
  }
  const beforeNames = Object.keys(previous);
  const nextNames = Object.keys(next);
  if (beforeNames.length !== nextNames.length) {
    return freeze(next);
  }
  for (const name of nextNames) {
    const left = previous[name];
    const right = next[name];
    if (
      left === undefined ||
      right === undefined ||
      left.parent !== right.parent ||
      !sameVariables(left.variables, right.variables)
    ) {
      return freeze(next);
    }
  }
  return previous;
}

/** Shallow `Object.is` over a variables record. */
function sameVariables(left: Variables, right: Variables): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

/** Evaluates a spread's artifact arguments against the parent's variables (§6.4). */
export function evaluateArguments(
  args: Readonly<Record<string, GraphQLValue>>,
  variables: Variables,
): Variables {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    out[name] = evaluateValue(value, variables);
  }
  return out;
}

/** The concrete selection for a target record: the abstract branch's fields are merged in (§3.2). */
function selectionFor(
  state: ReadState,
  spec: FieldSpec,
  recordId: RecordId,
): SubscriptionSelection {
  const base = spec.selection ?? {};
  const branches = spec.abstractFields;
  if (branches === undefined) {
    return base;
  }
  const typename = state.context.storage.get(recordId, '__typename', state.top);
  const branch = typeof typename === 'string' ? branches[typename] : undefined;
  if (branch === undefined) {
    return base;
  }
  return mergeSelections(base, branch);
}

function mergeSelections(
  base: SubscriptionSelection,
  extra: SubscriptionSelection,
): SubscriptionSelection {
  return {
    fields: { ...base.fields, ...extra.fields },
    fragments: { ...base.fragments, ...extra.fragments },
    abstractFields: { ...base.abstractFields, ...extra.abstractFields },
  };
}

/** Reuses the previous object when every value in it is `Object.is`-equal (§6.5 rule 1). */
function reuse(previous: unknown, out: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(previous)) {
    return freeze(out);
  }
  const beforeKeys = Object.keys(previous);
  const afterKeys = Object.keys(out);
  if (beforeKeys.length !== afterKeys.length) {
    return freeze(out);
  }
  for (const key of afterKeys) {
    if (!Object.is(previous[key], out[key])) {
      return freeze(out);
    }
  }
  return previous;
}

/** Reuses the previous array when it has the same shape and every element is identical (§6.5). */
function reuseArray(previous: unknown, elements: readonly unknown[]): unknown {
  if (Array.isArray(previous) && previous.length === elements.length) {
    let identical = true;
    for (let index = 0; index < elements.length; index += 1) {
      if (!Object.is(previous[index], elements[index])) {
        identical = false;
        break;
      }
    }
    if (identical) {
      return previous;
    }
  }
  return freeze([...elements]);
}

function previousValue(previous: unknown, key: string | number): unknown {
  if (typeof key === 'number') {
    return Array.isArray(previous) ? previous[key] : undefined;
  }
  return isRecord(previous) ? previous[key] : undefined;
}

/** Freezes a container once; nested values freeze themselves as they are built. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
  }
  return value;
}

function markStale(state: ReadState, recordId: RecordId, field: string): void {
  if (state.context.stale.isStale(recordId, field, state.context.staleTime)) {
    state.stale = true;
  }
}

function fieldKeys(refs: readonly FieldRef[]): readonly string[] {
  const keys = new Set<string>();
  for (const [, field] of refs) {
    keys.add(field);
  }
  return [...keys];
}

function createState(
  context: ReadContext,
  options: {
    readonly mask?: boolean;
    readonly variables?: Variables;
    readonly layer?: CacheLayer;
  },
): ReadState {
  return {
    context,
    mask: options.mask ?? true,
    variables: options.variables ?? {},
    top: options.layer,
    refs: [],
    stepsFromConnection: null,
    partial: false,
    stale: false,
  };
}

/**
 * A stored leaf value, copied and frozen when it is an object or an array.
 *
 * Scalars pass through. A composite is shared only when the read's `previous` snapshot already
 * holds an identical one, which is what keeps an unchanged row's identity (and therefore a
 * component's re-render count) stable across reads while never exposing the cache's own object.
 */
function copyLeaf(value: unknown, previous: unknown): unknown {
  if (Object.is(previous, value)) {
    return previous;
  }
  if (Array.isArray(value)) {
    return reuseArray(previous, value);
  }
  const current = asRecord(value);
  if (current === null) {
    // a scalar, a `Pending`, or a value the storage holds as-is: nothing to copy
    return value;
  }
  const previousRecord = asRecord(previous);
  if (previousRecord !== null) {
    const keys = Object.keys(current);
    if (
      keys.length === Object.keys(previousRecord).length &&
      keys.every((key) => Object.is(previousRecord[key], current[key]))
    ) {
      return previous;
    }
  }
  // a fresh plain record: a caller mutating it can never reach the stored object
  return freeze({ ...current });
}
