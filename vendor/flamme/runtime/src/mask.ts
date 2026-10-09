/**
 * The ` $fragments` masking channel: `fragmentKey` and the guards a hand-written parent, the Vue
 * layer or a generated prop descriptor use to validate a reference before reading through it.
 *
 * The marker object itself is `FragmentMarker` and the payload is `FragmentReference` (§3.2); this
 * module owns only the runtime half, because the key spelling with its leading space (D2) is a
 * runtime constant every slice must share.
 */
import type { FragmentRef } from './artifact.js';

/** The key a masked read writes fragment references under. `' $fragments'`, leading space (D2). */
export const fragmentKey = ' $fragments';

/**
 * `true` when `value` is a `{ parent, variables }` fragment reference. Total: it never throws and
 * it rejects `null`, arrays, a bare record id and a payload missing either field.
 */
export function isFragmentRef(value: unknown): value is FragmentRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'parent' in value &&
    'variables' in value &&
    typeof value.parent === 'string' &&
    typeof value.variables === 'object' &&
    value.variables !== null
  );
}

/**
 * `true` when `value` carries a ` $fragments` entry for `name` that is a real
 * `{ parent, variables }` reference.
 *
 * This is the runtime half of the generated fragment prop descriptor (`props.ts`, §8.9): the
 * generated `is<Name>Key` predicate is a thin call to it. It is total and name-only, and it is
 * deliberately the same check `useFragment` performs before reading through a reference (§8.4):
 *
 * - a masked value and a loading frame both validate, because a frame keeps the references it was
 *   read with;
 * - a plain object with the fragment's field names does not, because there is no marker to read
 *   through and no parent record to subscribe to;
 * - `null`, a primitive, an array, a non-object marker and an entry belonging to a different
 *   fragment do not.
 *
 * Two directive cases are the honest edge of the check:
 *
 * - `@when`/`@when_not` on a spread never removes the reference (only the spread's *fields* are
 *   conditional), so a conditionally excluded spread still validates; the child read reports
 *   `partial: true` with those fields absent.
 * - `@mask_disable` writes no marker at all, because the spread is inlined as the parent's own
 *   fields. Such a value does not validate; the generated `$key` type rejects it too, and a child
 *   that wants the inlined data takes the parent's own type (`$unmasked`).
 */
export function hasFragment(value: unknown, name: string): boolean {
  if (typeof value !== 'object' || value === null || !(fragmentKey in value)) {
    return false;
  }
  const marker = value[fragmentKey];
  return isRecord(marker) && isFragmentRef(marker[name]);
}

/** `true` for a plain object: the only shape a ` $fragments` marker is written as. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
