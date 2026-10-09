/**
 * `@required`'s runtime half.
 *
 * The compiler types a required field non-null and marks its direct parent nullable, so the read
 * path must never hand back a `null` where the type promises a value: a null or missing required
 * field nulls the enclosing object (the "null bubbles to the nearest nullable ancestor" rule) and
 * the result reports `partial: true`. This module owns the two pieces that make that observable:
 * the DEV warning naming the field and the record, and the poison `__typename` an **abstract**
 * parent reads as instead of being nulled (only one branch declares the required child, so nulling
 * the value would throw away the other branches' data).
 */
import { devWarn } from './dev.js';

/**
 * The `__typename` an abstract parent with `abstractHasRequired` carries when its required child is
 * null or missing. It deliberately matches no generated union branch, so a `switch` on `__typename`
 * falls through to its default instead of rendering a branch whose data is not there.
 */
export const REQUIRED_MISSING_TYPENAME = "@required field missing; don't match this";

/** The DEV-only warning a null or missing `@required` field produces, once per read. */
export function warnRequiredMissing(recordId: string, field: string): void {
  devWarn(
    `@required field "${field}" is null or missing on "${recordId}", so the value the type promises is not there; the read reports partial: true.`,
    'select the field without @required, or make the server always return it',
  );
}
