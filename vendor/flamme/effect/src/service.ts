/**
 * The `Flamme` service and the shape it carries.
 *
 * `Flamme` is a class-style `Context.Service` (v4 replaced `Context.Tag` with it, and there is no
 * `Effect.Service`), so the class value is the context key, the class type is the service
 * identifier, and `yield* Flamme` inside `Effect.gen` yields the {@link FlammeService}. The service
 * holds the runtime `Client`, the queue the layer was configured with (or `null`), and the
 * operations bound to both; the free functions of this package are the same operations with
 * `Flamme` left in their requirements.
 */
import * as Context from 'effect/Context';
import type * as Effect from 'effect/Effect';
import type * as Stream from 'effect/Stream';

import type { Artifact, Client, QueryResult } from '@flamme/runtime';

import type { FlammeError } from './errors.js';
import type {
  FlammeMutationOptions,
  FlammeMutationResult,
  FlammeQueryOptions,
} from './operations.js';
import { mutateWith, prefetchWith, queryWith } from './operations.js';
import type { FlammeQueue } from './queue.js';
import { incrementalWith, subscribeWith } from './streams.js';

/** The service: a Flamme client plus the Effect-native operations bound to it. */
export interface FlammeService {
  /** The underlying runtime client, for everything this package does not wrap. */
  readonly client: Client;
  /** The local-first queue the layer was given, or `null` when it has none. */
  readonly queue: FlammeQueue | null;
  /** One query, resolving with the runtime's `QueryResult`. */
  query<TData>(
    artifact: Artifact<'query', TData>,
    options?: FlammeQueryOptions,
  ): Effect.Effect<QueryResult<TData>, FlammeError>;
  /** One mutation, resolving with its outcome: confirmed, or owned by the queue. */
  mutate<TData>(
    artifact: Artifact<'mutation', TData>,
    options: FlammeMutationOptions,
  ): Effect.Effect<FlammeMutationResult<TData>, FlammeError>;
  /** Warms the cache with one query and discards its value. */
  prefetch<TData>(
    artifact: Artifact<'query', TData>,
    options?: FlammeQueryOptions,
  ): Effect.Effect<void, FlammeError>;
  /** A subscription's payloads, one element per payload, ending when the transport completes. */
  subscribe<TData>(
    artifact: Artifact<'subscription', TData>,
    options?: FlammeQueryOptions,
  ): Stream.Stream<TData, FlammeError>;
  /** The frames of one query response: the initial payload plus one per `@defer`/`@stream` patch. */
  incremental<TData>(
    artifact: Artifact<'query', TData>,
    options?: FlammeQueryOptions,
  ): Stream.Stream<TData, FlammeError>;
}

/** The context key of {@link FlammeService}; `yield* Flamme` yields the service. */
export class Flamme extends Context.Service<Flamme, FlammeService>()('@flamme/effect/Flamme') {}

/** Binds the operations to one client and one queue; this is what every layer provides. */
export function makeFlammeService(client: Client, queue: FlammeQueue | null = null): FlammeService {
  return {
    client,
    queue,
    query: (artifact, options = {}) => queryWith(client, artifact, options),
    mutate: (artifact, options) => mutateWith(client, queue, artifact, options),
    prefetch: (artifact, options = {}) => prefetchWith(client, artifact, options),
    subscribe: (artifact, options = {}) => subscribeWith(client, artifact, options),
    incremental: (artifact, options = {}) => incrementalWith(client, artifact, options),
  };
}
