/**
 * The identities the atom layer keys on.
 *
 * A query atom is shared by `(artifact, variables)`, and {@link queryKey} is that pair's identity:
 * the artifact's hash plus its **marshalled** variables, which is the same pair the runtime's cache
 * and in-flight table use. Marshalling is what makes `{ id: '1' }`, `{ id: 1 }` and a variable left
 * to its document default one key, so two components that spell the same request differently still
 * share one atom, one store and one request.
 */
import { marshalInputs, stableStringify } from '@flamme/runtime';
import type { Artifact, Variables } from '@flamme/runtime';

/** `true` for an object usable as a variables record: never `null`, never an array. */
export function isRecord(value: unknown): value is Variables {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The variables record of a caller-supplied input, or `{}` when none was passed. */
export function asVariables(value: unknown): Variables {
  return isRecord(value) ? value : {};
}

/** The registry key of one query: the artifact's hash plus its marshalled variables. */
export function queryKey(artifact: Artifact, variables: Variables): string {
  return `${artifact.hash}::${stableStringify(marshalInputs(artifact, variables))}`;
}
