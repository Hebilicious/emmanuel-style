/**
 * Variable marshalling (§9.2, `marshalInputs`).
 *
 * The artifact carries the defaults the document declares (`$id: Int! = 1`), so a caller may omit
 * them; `stripVariables` names the variables that survive printing but are unused, and they are
 * dropped before the request is built. Scalars are *output* configuration (`config.scalars`), so
 * unmarshalling happens in the cache on write, never here.
 */
import type { Artifact, ArtifactKind, Variables } from './artifact.js';

/**
 * Merges the artifact's variable defaults under `variables` and removes `stripVariables`.
 *
 * `undefined` values in the input are treated as "not provided", which is what makes a variable
 * with a default optional at the call site. The result is frozen: variables are plain data and the
 * dedupe key is computed from them.
 */
export function marshalInputs<TData>(
  artifact: Artifact<ArtifactKind, TData>,
  variables: Variables = {},
): Variables {
  const provided: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(variables)) {
    if (value !== undefined) {
      provided[name] = value;
    }
  }

  const merged: Record<string, unknown> = { ...artifact.input?.defaults, ...provided };
  for (const name of artifact.stripVariables) {
    delete merged[name];
  }
  return Object.freeze(merged);
}
