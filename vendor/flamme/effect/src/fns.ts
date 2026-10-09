/**
 * The free-function surface: the operations with `Flamme` left in their requirements.
 *
 * `Effect.gen(function* () { const species = yield* query(Species) })` needs the `Flamme` service,
 * so a program is provided once with {@link flammeLayer} or {@link clientLayer}. The service methods
 * of `Flamme` are the same operations with the requirement already discharged, which is what the
 * atom layer of `@flamme/effect/vue` uses.
 */
import * as Effect from 'effect/Effect';
import * as Stream from 'effect/Stream';

import type { Artifact, QueryResult } from '@flamme/runtime';

import type { FlammeError } from './errors.js';
import type {
  FlammeMutationOptions,
  FlammeMutationResult,
  FlammeQueryOptions,
} from './operations.js';
import { Flamme } from './service.js';

/** One query, with `Flamme` required: the request aborts when this effect is interrupted. */
export function query<TData>(
  artifact: Artifact<'query', TData>,
  options: FlammeQueryOptions = {},
): Effect.Effect<QueryResult<TData>, FlammeError, Flamme> {
  return Effect.flatMap(Flamme, (service) => service.query(artifact, options));
}

/**
 * One mutation, with `Flamme` required; `optimistic` opens the runtime's optimistic layer, or hands
 * the payload to the local-first queue when the layer has one.
 */
export function mutate<TData>(
  artifact: Artifact<'mutation', TData>,
  options: FlammeMutationOptions,
): Effect.Effect<FlammeMutationResult<TData>, FlammeError, Flamme> {
  return Effect.flatMap(Flamme, (service) => service.mutate(artifact, options));
}

/** Warms the cache with one query and discards the value. */
export function prefetch<TData>(
  artifact: Artifact<'query', TData>,
  options: FlammeQueryOptions = {},
): Effect.Effect<void, FlammeError, Flamme> {
  return Effect.flatMap(Flamme, (service) => service.prefetch(artifact, options));
}

/** A subscription's payloads; the scope of the stream owns the transport. */
export function subscribe<TData>(
  artifact: Artifact<'subscription', TData>,
  options: FlammeQueryOptions = {},
): Stream.Stream<TData, FlammeError, Flamme> {
  return Stream.unwrap(Effect.map(Flamme, (service) => service.subscribe(artifact, options)));
}

/** The frames of one query response, one element per `@defer`/`@stream` patch. */
export function incremental<TData>(
  artifact: Artifact<'query', TData>,
  options: FlammeQueryOptions = {},
): Stream.Stream<TData, FlammeError, Flamme> {
  return Stream.unwrap(Effect.map(Flamme, (service) => service.incremental(artifact, options)));
}
