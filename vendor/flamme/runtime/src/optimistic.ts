/**
 * `@optimisticKey` at runtime (§7.14): the temporary record id.
 *
 * A mutation that creates a record cannot know the id the server will assign, so an optimistic
 * insert built from a payload without one has nothing to key the record by. `@optimisticKey` marks
 * the field that will hold that id; this module supplies the rest: a generated id stamped into the
 * payload before it is written (so the record, its list membership and every link to it are written
 * consistently under one id) and the list of stamped sites the mutation plugin remaps when the
 * confirmation arrives.
 *
 * The generated value is deliberately recognisable and namespaced (`@@optimistic:1`), because it can
 * be read by application code between the optimistic write and the confirmation:
 *
 * ```ts
 * const item = list[0]
 * if (isOptimisticId(String(item.id))) // the server has not answered yet
 * ```
 *
 * Nothing here reads the cache or the client: `stampOptimisticKeys` is a pure walk over the payload,
 * so the mutation plugin stays the only place that writes a layer.
 */
import type { Artifact, SubscriptionSelection } from './artifact.js';

/** The prefix of a generated id value: `@@optimistic:1`. */
export const OPTIMISTIC_ID_PREFIX = '@@optimistic:';

/** `true` when a value was generated for an unresolved `@optimisticKey` field. */
export function isOptimisticId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(OPTIMISTIC_ID_PREFIX);
}

let counter = 0;

/**
 * The next generated id value. There is no clock and no randomness, so two runs of the same test
 * produce the same ids; the counter is process-wide, which is what keeps concurrent mutations from
 * colliding.
 */
export function nextOptimisticId(): string {
  counter += 1;
  return `${OPTIMISTIC_ID_PREFIX}${counter}`;
}

/** Resets the generator. Test-only: a suite that asserts on a generated id needs a fixed start. */
export function resetOptimisticIds(): void {
  counter = 0;
}

/** One field this payload left unresolved, and the id that was generated for it. */
export interface OptimisticKeySite {
  /** Path from the payload root to the **record** that needed the id (strings, then array indices). */
  readonly path: readonly (string | number)[];
  /** The record's type: its `__typename` when the payload carries one, else the selection's type. */
  readonly type: string;
  /** The generated id value written into the marked field. */
  readonly value: string;
}

/** The result of {@link stampOptimisticKeys}: a copy of the payload plus what was stamped. */
export interface StampedOptimisticPayload {
  readonly data: unknown;
  readonly sites: readonly OptimisticKeySite[];
}

/**
 * Copies `data`, replacing the value of every unresolved `@optimisticKey` field with a generated id.
 *
 * `data` is never mutated: the caller's optimistic payload object is theirs. A document that marks no
 * field (or an artifact the emitter has not yet flagged) is returned untouched, so the pre-existing
 * optimistic path is byte-identical when `@optimisticKey` is not used.
 */
export function stampOptimisticKeys(
  artifact: Artifact,
  data: unknown,
): StampedOptimisticPayload {
  if (!hasOptimisticKeys(artifact)) {
    return { data, sites: [] };
  }
  const sites: OptimisticKeySite[] = [];
  const stamped = walkValue(artifact.selection, data, [], artifact.rootType, sites);
  return { data: stamped, sites };
}

/** `true` when the document marks a field with `@optimisticKey` (artifact flag or field flag). */
export function hasOptimisticKeys(artifact: Artifact): boolean {
  return artifact.optimisticKeys === true || selectionHasOptimisticKey(artifact.selection);
}

/** The record id a stamped site produces: `Species:@@optimistic:1`. */
export function optimisticRecordId(site: OptimisticKeySite): string {
  return `${site.type}:${site.value}`;
}

/** The value at a {@link OptimisticKeySite.path}, or `undefined` when the path is not there. */
export function valueAtPath(data: unknown, path: readonly (string | number)[]): unknown {
  let current: unknown = data;
  for (const step of path) {
    if (typeof step === 'number') {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[step];
      continue;
    }
    const record = asRecord(current);
    if (record === null) {
      return undefined;
    }
    current = record[step];
  }
  return current;
}

/** A field with no usable value yet: absent, `null`, or the empty string a form supplies. */
function isUnresolved(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** `true` when this selection (or a branch of it) marks a field with `@optimisticKey`. */
function selectionHasOptimisticKey(selection: SubscriptionSelection): boolean {
  for (const spec of Object.values(selection.fields ?? {})) {
    if (spec.optimisticKey === true) {
      return true;
    }
    if (spec.selection !== undefined && selectionHasOptimisticKey(spec.selection)) {
      return true;
    }
    for (const branch of Object.values(spec.abstractFields ?? {})) {
      if (selectionHasOptimisticKey(branch)) {
        return true;
      }
    }
  }
  return false;
}

/** Walks one field value: an array of records is walked element by element, path index included. */
function walkValue(
  selection: SubscriptionSelection,
  value: unknown,
  path: readonly (string | number)[],
  type: string,
  sites: OptimisticKeySite[],
): unknown {
  if (!Array.isArray(value)) {
    return walkRecord(selection, value, path, type, sites);
  }
  return value.map((element, index) => walkRecord(selection, element, [...path, index], type, sites));
}

/** Walks one record, stamping a generated id into every unresolved `@optimisticKey` field. */
function walkRecord(
  selection: SubscriptionSelection,
  value: unknown,
  path: readonly (string | number)[],
  type: string,
  sites: OptimisticKeySite[],
): unknown {
  const record = asRecord(value);
  if (record === null) {
    return value;
  }
  const cloned: Record<string, unknown> = { ...record };
  const typename = record['__typename'];
  const recordType = typeof typename === 'string' ? typename : type;
  for (const [name, spec] of Object.entries(selection.fields ?? {})) {
    // the marked field is stamped whether the payload omitted it or supplied `null`: an optimistic
    // create with no id yet is exactly the case this directive exists for
    if (spec.optimisticKey === true) {
      if (!Object.hasOwn(cloned, name) || isUnresolved(cloned[name])) {
        const generated = nextOptimisticId();
        cloned[name] = generated;
        sites.push({ path, type: recordType, value: generated });
      }
      continue;
    }
    if (!Object.hasOwn(cloned, name)) {
      continue;
    }
    if (spec.selection !== undefined) {
      cloned[name] = walkValue(spec.selection, cloned[name], [...path, name], spec.type, sites);
      continue;
    }
    // an abstract field's branches each describe the same value: walk it through every one, since
    // only the fields actually present in the payload are touched
    const branches = Object.values(spec.abstractFields ?? {});
    if (branches.length > 0) {
      let current = cloned[name];
      for (const branchSelection of branches) {
        current = walkValue(branchSelection, current, [...path, name], spec.type, sites);
      }
      cloned[name] = current;
    }
  }
  return cloned;
}

/** The object view of a payload value, or `null`; the one place this module narrows `unknown`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a payload object is a plain record
  return value as Record<string, unknown>;
}
