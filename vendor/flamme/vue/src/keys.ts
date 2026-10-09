/**
 * The three keys the Vue layer derives: the store-registry key of a `(artifact, variables)` pair,
 * the variables comparison the variables watcher gates on, and a key for the once-per-site warnings.
 */
import type { Artifact, Variables } from '@flamme/runtime';

/** The registry key of an observed document: `${hash}::${stable variables}` (§5.6's dedupe key). */
export function storeKey(artifact: Artifact, variables: Variables): string {
  return `${artifact.hash}::${stableStringify(variables)}`;
}

/** `true` for an object that can be used as a variables record. */
export function isVariables(value: unknown): value is Variables {
  return isRecord(value);
}

/** The variables record of a generated input, or `{}` when the caller passed none. */
export function asVariables(value: unknown): Variables {
  return isVariables(value) ? value : {};
}

/** `true` for a plain object: never `null`, never an array, never a primitive. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shallow `Object.is` over a variables record, the same comparison the cache uses for markers. */
export function sameVariables(left: Variables, right: Variables): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => Object.is(left[key], right[key]));
}

/** A JSON-ish serialization with sorted keys, so `{a,b}` and `{b,a}` produce one key. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!isPlainRecord(entry)) {
      return entry;
    }
    return Object.fromEntries(
      Object.entries(entry).toSorted(([left], [right]) => (left < right ? -1 : 1)),
    );
  });
}

/** `true` for a plain object (never an array, never `null`). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
