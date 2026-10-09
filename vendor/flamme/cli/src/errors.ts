/**
 * Error formatting shared by the commands. `@flamme/core` keeps its
 * `errorMessage` internal, so the CLI carries its own copy rather than widening
 * core's public surface for one line of text.
 */

/** The message of a thrown value, without claiming it is an `Error`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
