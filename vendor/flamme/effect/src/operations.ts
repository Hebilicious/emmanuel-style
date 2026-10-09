/**
 * The one-shot operations, implemented against a `Client` (and, for mutations, a queue).
 *
 * Each one wraps exactly one call of the runtime's one-shot API in `Effect.tryPromise`, so
 * interruption aborts the request through the `AbortSignal` Effect hands the thunk, and every
 * rejection is mapped by {@link toFlammeError} into the tagged error channel. A query resolves with
 * the runtime's `QueryResult` unchanged; a mutation resolves with {@link FlammeMutationResult},
 * which is what carries the local-first queue's outcome into the Effect world.
 */
import * as Effect from 'effect/Effect';

import { isCacheMiss } from '@flamme/runtime';
import type { Artifact, CachePolicy, Client, QueryResult, Variables } from '@flamme/runtime';

import { FlammeCacheMissError, FlammeParkedError, toFlammeError } from './errors.js';
import type { FlammeError } from './errors.js';
import type { FlammeQueue } from './queue.js';

/** What `query` and `prefetch` accept: the request's variables and its cache policy. */
export interface FlammeQueryOptions {
  /** The request variables, marshalled by the runtime against the artifact's defaults. */
  readonly variables?: Variables;
  /** Overrides the artifact's baked policy for this request only. */
  readonly policy?: CachePolicy;
}

/** What `mutate` accepts: variables are required on a mutation, plus the optimistic payload. */
export interface FlammeMutationOptions {
  /** The mutation variables. */
  readonly variables: Variables;
  /** Written into an optimistic layer before the request and rolled back on failure. */
  readonly optimistic?: Variables;
}

/**
 * What one mutation did: the server confirmed it, or the local-first queue owns it now.
 *
 * The queue parks a mutation the server rejected with a GraphQL error, or one that spent the
 * store's attempt budget; that is a failure of the effect (`FlammeParkedError`), not an outcome,
 * because the caller has to decide between retrying and discarding.
 */
export type FlammeMutationResult<TData> =
  | { readonly status: 'confirmed'; readonly data: TData | null }
  | { readonly status: 'queued'; readonly id: string };

/**
 * `CacheOnly` reads have no failure to reject with, so the marker the runtime leaves in
 * `result.errors` is turned into the typed `FlammeCacheMissError` here.
 */
function assertDelivered<TData>(
  result: QueryResult<TData>,
  artifact: string,
  variables: Variables,
): Effect.Effect<QueryResult<TData>, FlammeCacheMissError> {
  const missed =
    result.data === null && result.errors?.some((error) => isCacheMiss(error)) === true;
  return missed
    ? Effect.fail(
        new FlammeCacheMissError({
          message: `"${artifact}" was read with a cache-only policy and the cache holds no data for it.`,
          artifact,
          variables,
        }),
      )
    : Effect.succeed(result);
}

/** One query through `client.query`: the request, its abort wiring and the typed failure mapping. */
export function queryWith<TData>(
  client: Client,
  artifact: Artifact<'query', TData>,
  options: FlammeQueryOptions = {},
): Effect.Effect<QueryResult<TData>, FlammeError> {
  const variables = options.variables ?? {};
  return Effect.flatMap(
    Effect.tryPromise({
      try: (signal) =>
        client.query(artifact, {
          variables,
          signal,
          ...(options.policy === undefined ? {} : { policy: options.policy }),
        }),
      catch: (cause) => toFlammeError(cause, { operation: artifact.name, variables }),
    }),
    (result) => assertDelivered(result, artifact.name, variables),
  );
}

/**
 * One mutation, through the queue when the layer was given one and through `client.mutate`
 * otherwise.
 *
 * Both paths bridge `Effect.tryPromise`'s signal, so interrupting the fiber aborts an in-flight
 * request and rolls the optimistic layer back. A queued mutation is the exception the local-first
 * model demands: the thunk has no signal, the write is already durable when the promise settles,
 * and interrupting the fiber only stops the caller waiting for the outcome.
 */
export function mutateWith<TData>(
  client: Client,
  queue: FlammeQueue | null,
  artifact: Artifact<'mutation', TData>,
  options: FlammeMutationOptions,
): Effect.Effect<FlammeMutationResult<TData>, FlammeError> {
  const variables = options.variables;
  if (queue !== null) {
    return Effect.tryPromise({
      try: () =>
        queue
          .mutate<TData>(artifact, {
            variables,
            ...(options.optimistic === undefined ? {} : { optimistic: options.optimistic }),
          })
          .then((outcome): FlammeMutationResult<TData> => {
            if (outcome.status === 'parked') {
              throw new FlammeParkedError({
                message: `"${artifact.name}" is parked in the local-first queue: ${outcome.error.message}`,
                id: outcome.id,
                cause: outcome.error,
              });
            }
            if (outcome.status === 'queued') {
              return { status: 'queued', id: outcome.id };
            }
            return { status: 'confirmed', data: outcome.data };
          }),
      catch: (cause) =>
        cause instanceof FlammeParkedError
          ? cause
          : toFlammeError(cause, { operation: artifact.name, variables }),
    });
  }
  return Effect.map(
    Effect.tryPromise({
      try: (signal) =>
        client.mutate(artifact, {
          variables,
          signal,
          ...(options.optimistic === undefined ? {} : { optimistic: options.optimistic }),
        }),
      catch: (cause) => toFlammeError(cause, { operation: artifact.name, variables }),
    }),
    (result): FlammeMutationResult<TData> => ({ status: 'confirmed', data: result.data }),
  );
}

/**
 * Runs the one-shot query pipeline and discards the value: the payload is in the cache for the
 * query that reads it later, which is what a prefetch is for.
 */
export function prefetchWith<TData>(
  client: Client,
  artifact: Artifact<'query', TData>,
  options: FlammeQueryOptions = {},
): Effect.Effect<void, FlammeError> {
  return Effect.asVoid(queryWith(client, artifact, options));
}
