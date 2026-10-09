/**
 * The Effect error channel of `@flamme/effect`.
 *
 * Every failure the runtime can hand a caller becomes a `Data.TaggedError` with a `_tag`, so
 * `Effect.catchTag` and `Effect.catchTags` select it by name and TypeScript narrows the class. The
 * tags are a 1:1 map of the runtime taxonomy (`packages/runtime/src/errors.ts`) plus the three
 * states that are not rejections there: a `@flamme/runtime` cache miss (`CACHE_MISS`), a GraphQL
 * error list carried by a `QueryResult`, and a mutation the local-first queue parked. A thrown value
 * that is not in the taxonomy is a `FlammeUnknownError` carrying the value as `cause`.
 */
import * as Data from 'effect/Data';

import {
  ClientDisposedError,
  FlammeRuntimeError,
  GraphQLHttpError,
  HttpError,
  NetworkError,
  SubscriptionTransportError,
} from '@flamme/runtime';
import type { GraphQLResponseError, Variables } from '@flamme/runtime';

/** FLM3001 in the Effect world: the transport rejected before a response existed. */
export class FlammeTransportError extends Data.TaggedError('FlammeTransportError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** FLM3002: a non-2xx response; `status` and `body` are the transport's own fields. */
export class FlammeHttpError extends Data.TaggedError('FlammeHttpError')<{
  readonly message: string;
  readonly status: number;
  readonly body: string;
  readonly cause?: unknown;
}> {}

/** FLM3003: a 2xx response whose body is not a GraphQL response. */
export class FlammeGraphQLHttpError extends Data.TaggedError('FlammeGraphQLHttpError')<{
  readonly message: string;
  readonly status: number;
  readonly body: string;
  readonly cause?: unknown;
}> {}

/** A GraphQL execution error list: the runtime rejects with the list itself when a response has no data. */
export class FlammeGraphQLError extends Data.TaggedError('FlammeGraphQLError')<{
  readonly message: string;
  readonly errors: readonly GraphQLResponseError[];
}> {}

/** A `CacheOnly` policy read that found no data: the runtime's `CACHE_MISS` marker, as a failure. */
export class FlammeCacheMissError extends Data.TaggedError('FlammeCacheMissError')<{
  readonly message: string;
  readonly artifact: string;
  readonly variables: Variables;
}> {}

/** FLM4006: the client was disposed, so the request can never be delivered. */
export class FlammeDisposedError extends Data.TaggedError('FlammeDisposedError')<{
  readonly message: string;
}> {}

/** FLM3004: the subscription transport is absent, errored, or closed before `complete`. */
export class FlammeSubscriptionError extends Data.TaggedError('FlammeSubscriptionError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The queue parked the mutation: the server rejected it with a GraphQL error, or it spent the
 * store's attempt budget. The entry stays durably queued until the app retries or discards it.
 */
export class FlammeParkedError extends Data.TaggedError('FlammeParkedError')<{
  readonly message: string;
  /** The queue entry; `discard(id)` and `retry()` of the store take it. */
  readonly id: string;
  readonly cause?: unknown;
}> {}

/** A fragment read through a value that carries no ` $fragments` entry for that fragment. */
export class FlammeFragmentError extends Data.TaggedError('FlammeFragmentError')<{
  readonly message: string;
  /** The fragment's name. */
  readonly fragment: string;
  /** The record id the parent value belongs to, or `'unknown'`. */
  readonly parent: string;
}> {}

/** Any other member of the runtime taxonomy, kept selectable by its `FLMxxxx` code. */
export class FlammeRuntimeFailure extends Data.TaggedError('FlammeRuntimeFailure')<{
  readonly message: string;
  readonly code: `FLM${number}`;
  readonly hint?: string;
  readonly cause?: unknown;
}> {}

/** A thrown value outside the runtime taxonomy: a transport or plugin failure nobody named. */
export class FlammeUnknownError extends Data.TaggedError('FlammeUnknownError')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Everything the operations of this package can fail with; `Effect.catchTag` works on every member. */
export type FlammeError =
  | FlammeTransportError
  | FlammeHttpError
  | FlammeGraphQLHttpError
  | FlammeGraphQLError
  | FlammeCacheMissError
  | FlammeDisposedError
  | FlammeSubscriptionError
  | FlammeParkedError
  | FlammeFragmentError
  | FlammeRuntimeFailure
  | FlammeUnknownError;

/** The tag of every member of {@link FlammeError}, for the guard below. */
const FLAMME_ERROR_TAGS: ReadonlySet<unknown> = new Set([
  'FlammeTransportError',
  'FlammeHttpError',
  'FlammeGraphQLHttpError',
  'FlammeGraphQLError',
  'FlammeCacheMissError',
  'FlammeDisposedError',
  'FlammeSubscriptionError',
  'FlammeParkedError',
  'FlammeFragmentError',
  'FlammeRuntimeFailure',
  'FlammeUnknownError',
]);

/**
 * `true` for a value that is already a {@link FlammeError}; `toFlammeError` returns those as they are.
 *
 * The check is the tag Effect's `Data.TaggedError` writes, read through `Reflect` so neither the
 * `_tag` spelling nor a cast has to appear in this module.
 */
export function isFlammeError(value: unknown): value is FlammeError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return FLAMME_ERROR_TAGS.has(Reflect.get(value, '_tag'));
}

/** What a mapping needs to name the operation that failed in the error message. */
export interface FlammeFailureContext {
  /** The artifact name, e.g. `Info`. */
  readonly operation: string;
  /** The marshalled variables the request carried. */
  readonly variables: Variables;
}

/** `true` for a value the runtime rejected with as a GraphQL error list. */
function isGraphQLErrorList(value: unknown): value is readonly GraphQLResponseError[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' && entry !== null && typeof entry['message'] === 'string',
    )
  );
}

/**
 * Maps one thrown runtime value to its Effect error; a value that is not in the taxonomy becomes a
 * `FlammeUnknownError` with the value as `cause`.
 */
export function toFlammeError(cause: unknown, context: FlammeFailureContext): FlammeError {
  if (isFlammeError(cause)) {
    return cause;
  }
  if (cause instanceof HttpError) {
    return new FlammeHttpError({
      message: cause.message,
      status: cause.status,
      body: cause.body,
      cause,
    });
  }
  if (cause instanceof GraphQLHttpError) {
    return new FlammeGraphQLHttpError({
      message: cause.message,
      status: cause.status,
      body: cause.body,
      cause,
    });
  }
  if (cause instanceof NetworkError) {
    return new FlammeTransportError({ message: cause.message, cause });
  }
  if (cause instanceof SubscriptionTransportError) {
    return new FlammeSubscriptionError({ message: cause.message, cause });
  }
  if (cause instanceof ClientDisposedError) {
    return new FlammeDisposedError({ message: cause.message });
  }
  if (isGraphQLErrorList(cause)) {
    return new FlammeGraphQLError({
      message: `"${context.operation}" answered with ${cause.length} GraphQL error(s) and no data.`,
      errors: cause,
    });
  }
  if (cause instanceof FlammeRuntimeError) {
    return new FlammeRuntimeFailure({
      message: cause.message,
      code: cause.code,
      ...(cause.hint === undefined ? {} : { hint: cause.hint }),
      cause,
    });
  }
  return new FlammeUnknownError({
    message: `"${context.operation}" failed with a value outside the Flamme runtime taxonomy.`,
    cause,
  });
}

/**
 * The GraphQL errors one `QueryResult` carries, as the single typed error an atom reports.
 *
 * A result read from the cache can hold errors no effect ever saw: a `CacheOnly` read that found
 * nothing leaves the runtime's `CACHE_MISS` marker in `errors`, and a store another path wrote can
 * carry a GraphQL error list. Both are failures for a reader that asked for data.
 */
export function resultError(
  result: { readonly data: unknown; readonly errors: readonly GraphQLResponseError[] | null },
  artifact: string,
  variables: Variables,
  isCacheMiss: (error: GraphQLResponseError) => boolean,
): FlammeError | null {
  const errors = result.errors;
  if (errors === null || errors.length === 0) {
    return null;
  }
  if (errors.some((error) => isCacheMiss(error))) {
    return new FlammeCacheMissError({
      message: `"${artifact}" was read with a cache-only policy and the cache holds no data for it.`,
      artifact,
      variables,
    });
  }
  return new FlammeGraphQLError({
    message: `"${artifact}" answered with ${errors.length} GraphQL error(s) and no data.`,
    errors,
  });
}
