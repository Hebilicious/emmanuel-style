/**
 * `throwOnError` (§5.2, §12.1): the last plugin, so it sees the final state.
 *
 * It rejects the promise `send` returned when a request produced no data and at least one error.
 * "Never swallow" still holds: the error is in `QueryResult.errors` either way. A rejection value
 * is the first `Error` in the list (a transport failure, so a caller can `instanceof` it) or the
 * error list itself (a GraphQL error payload is data and no runtime error class is thrown for it,
 * §12.1). A `CacheOnly` miss is an expected state, not a failure, and never rejects.
 */
import type { ClientPlugin, RequestContext } from '../pipeline.js';
import { isCacheMiss } from './cache.js';

export interface ThrowOnErrorOptions {
  /** `false` leaves the errors in the store state and resolves the promise. Default `true`. */
  readonly enabled?: boolean;
}

/** Rejects `send` when a request settled with errors and no data. */
export function throwOnError(options: ThrowOnErrorOptions = {}): ClientPlugin {
  const enabled = options.enabled ?? true;
  return {
    name: 'throwOnError',
    end: (ctx: RequestContext) => {
      if (!enabled) {
        return;
      }
      const result = ctx.result;
      if (result.data !== null || result.errors === null || result.errors.length === 0) {
        return;
      }
      const errors = result.errors.filter((error) => !isCacheMiss(error));
      if (errors.length === 0) {
        return;
      }
      const failure = errors.find((error) => error instanceof Error);
      throw failure ?? errors;
    },
  };
}
