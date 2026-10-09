/**
 * The two streaming operations: a subscription's payloads and the incremental frames of a query.
 *
 * Both are `Stream.callback` over the runtime's push channels, wrapped in `Effect.acquireRelease`,
 * so the stream's scope owns the transport: closing the scope (an interrupt, a `Stream.take`, the
 * end of `Stream.runCollect`) runs the release and unsubscribes, and a query stream's release also
 * tears the store down, which aborts a request still in flight.
 *
 * Both emit the document's **data**: one element per payload, already read through the cache and
 * masked exactly as the Vue layer's handles read it. A payload the server answered with errors and
 * no data fails the stream with `FlammeGraphQLError`, which is the same rule the query effect uses.
 */
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Queue from 'effect/Queue';
import * as Stream from 'effect/Stream';

import { SubscriptionTransportError, createClient } from '@flamme/runtime';
import type { Artifact, Client, QueryResult, SubscribeFn } from '@flamme/runtime';

import { FlammeGraphQLError, toFlammeError } from './errors.js';
import type { FlammeError } from './errors.js';
import type { FlammeQueryOptions } from './operations.js';

/**
 * A view of `client` whose subscription frames are marked as they are produced.
 *
 * `Client.subscribe`'s payload channel reports every commit of the subscription's store, and the
 * runtime's own completion bookkeeping (`{ fetching: false }`) commits the same values as the
 * payload that preceded it, so the two are indistinguishable from a result alone. The wrapper calls
 * `onPayload` synchronously before the runtime handles the payload, and the commit the runtime
 * produces in response runs before anything else can, so a frame that follows a marked payload is
 * that payload's frame. The client is a view over the same cache, plugins and transports; it is
 * never disposed, because the stream owns the subscription, not the client.
 */
function payloadTappedClient(client: Client, onPayload: () => void): Client {
  const transport: SubscribeFn | undefined = client.config.subscribe;
  if (transport === undefined) {
    return client;
  }
  return createClient({
    ...client.config,
    subscribe: (request, handlers) =>
      transport(request, {
        next: (value) => {
          onPayload();
          handlers.next(value);
        },
        error: (error) => {
          handlers.error(error);
        },
        complete: () => {
          handlers.complete();
        },
      }),
  });
}

/** The data of one result, failing with the result's GraphQL errors when it carries none. */
function dataOf<TData>(result: QueryResult<TData>, artifact: string): TData {
  if (result.data !== null) {
    return result.data;
  }
  throw new FlammeGraphQLError({
    message: `"${artifact}" answered with ${result.errors?.length ?? 0} GraphQL error(s) and no data.`,
    errors: result.errors ?? [],
  });
}

/**
 * One element per subscription payload, as the store's masked data; the transport's failure fails
 * the stream with `FlammeSubscriptionError` and its completion ends it.
 */
export function subscribeWith<TData>(
  client: Client,
  artifact: Artifact<'subscription', TData>,
  options: FlammeQueryOptions = {},
): Stream.Stream<TData, FlammeError> {
  const variables = options.variables ?? {};
  const context = { operation: artifact.name, variables };
  return Stream.callback<TData, FlammeError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let payload = false;
        const view = payloadTappedClient(client, () => {
          payload = true;
        });
        return view.subscribe<TData>(
          artifact,
          {
            variables,
            ...(options.policy === undefined ? {} : { policy: options.policy }),
          },
          {
            next: (result) => {
              const failure = result.errors?.find(
                (error) => error instanceof SubscriptionTransportError,
              );
              if (failure !== undefined) {
                Queue.failCauseUnsafe(queue, Cause.fail(toFlammeError(failure, context)));
                return;
              }
              if (!payload) {
                // a seed or bookkeeping commit: the transport delivered nothing in this turn
                return;
              }
              payload = false;
              try {
                Queue.offerUnsafe(queue, dataOf(result, artifact.name));
              } catch (error) {
                Queue.failCauseUnsafe(queue, Cause.fail(toFlammeError(error, context)));
              }
            },
            close: () => {
              Queue.endUnsafe(queue);
            },
          },
        );
      }),
      (close) =>
        Effect.sync(() => {
          close();
        }),
    ),
  );
}

/**
 * The frames of one query response: the initial payload and then one per `@defer`/`@stream` patch,
 * ending when the response reports `hasNext: false`. A response without incremental directives is a
 * single element.
 *
 * Only the commits the network stage produced are elements. A cache write wakes the document's own
 * cache subscription, which re-reads and commits the same values again; those frames are the same
 * data and are not part of the response, so they are filtered out by their `source`. A frame whose
 * read produced no data (a `@stream` patch that only appends to a list the document has not read
 * yet) is skipped rather than offered as `null`.
 */
export function incrementalWith<TData>(
  client: Client,
  artifact: Artifact<'query', TData>,
  options: FlammeQueryOptions = {},
): Stream.Stream<TData, FlammeError> {
  const variables = options.variables ?? {};
  const context = { operation: artifact.name, variables };
  return Stream.callback<TData, FlammeError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const store = client.observe<TData>({ artifact, variables });
        let settled = false;
        let last: QueryResult<TData> | null = null;
        let ended = false;
        const end = (): void => {
          ended = true;
          Queue.endUnsafe(queue);
        };
        const maybeEnd = (): void => {
          if (!ended && settled && (last === null || !last.hasNext)) {
            end();
          }
        };
        const off = store.subscribe((result) => {
          if (ended || result.source !== 'network') {
            return;
          }
          last = result;
          if (result.data !== null) {
            Queue.offerUnsafe(queue, result.data);
          }
          maybeEnd();
        });
        const settle = (): void => {
          settled = true;
          if (last !== null && last.data === null && last.errors !== null) {
            ended = true;
            Queue.failCauseUnsafe(queue, Cause.fail(toFlammeError(last.errors, context)));
            return;
          }
          maybeEnd();
        };
        const failed = (cause: unknown): void => {
          if (ended) {
            return;
          }
          ended = true;
          Queue.failCauseUnsafe(queue, Cause.fail(toFlammeError(cause, context)));
        };
        void store
          .send({ variables, policy: options.policy ?? 'NetworkOnly' })
          .then(settle, failed);
        return () => {
          off();
          store.cleanup();
        };
      }),
      (teardown) =>
        Effect.sync(() => {
          teardown();
        }),
    ),
  );
}
