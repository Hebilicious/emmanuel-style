/**
 * `@flamme/effect` — the Effect-native way to use Flamme.
 *
 * A Flamme `Client` is provided as a `Context.Service` through a `Layer`; queries, mutations,
 * subscriptions and incremental delivery are `Effect`s and `Stream`s whose failures are the runtime
 * taxonomy as tagged errors, and whose interruption aborts the underlying request. The same layer
 * carries the local-first queue, so a mutation resolves with the queue's outcome instead of
 * pretending an offline write reached the server. `effect` is a peer dependency: this package adds
 * no dependency to `@flamme/runtime` and none on `@flamme/local`.
 *
 * The Vue side of the seam is `@flamme/effect/vue`: atoms over the same client, with the same
 * operations behind them.
 */

/* ------------------------------------------------------------------------------- the service */

export { Flamme, makeFlammeService } from './service.js';
export type { FlammeService } from './service.js';

/* ------------------------------------------------------------------------------------ wiring */

export { buildClient, clientLayer, flammeLayer } from './layer.js';
export type {
  ClientLayerOptions,
  FlammeConfig,
  FlammeEndpointConfig,
  FlammeQueueInput,
  FlammeTransportConfig,
} from './layer.js';

/* -------------------------------------------------------------------------- local-first queue */

export type {
  FlammeQueue,
  FlammeQueueFailure,
  FlammeQueueMutation,
  FlammeQueueOutcome,
} from './queue.js';

/* ------------------------------------------------------------------------------- the effects */

export { incremental, mutate, prefetch, query, subscribe } from './fns.js';
export type {
  FlammeMutationOptions,
  FlammeMutationResult,
  FlammeQueryOptions,
} from './operations.js';

/* ------------------------------------------------------------------------------------ errors */

export {
  FlammeCacheMissError,
  FlammeDisposedError,
  FlammeFragmentError,
  FlammeGraphQLError,
  FlammeGraphQLHttpError,
  FlammeHttpError,
  FlammeParkedError,
  FlammeRuntimeFailure,
  FlammeSubscriptionError,
  FlammeTransportError,
  FlammeUnknownError,
  isFlammeError,
  resultError,
  toFlammeError,
} from './errors.js';
export type { FlammeError, FlammeFailureContext } from './errors.js';

/* ------------------------------------------------------------------------------------- server */

export { makeClientRuntime, makeRuntime } from './runtime.js';
