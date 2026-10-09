/**
 * `fetchPlugin` (§5.2): the default `network` stage.
 *
 * It builds the `TransportRequest` (the artifact's printed document, its hash and the marshalled
 * variables) and calls the configured transport with the request's signal. A transport rejection is
 * classified here: an abort is never an error (§5.6), a `FlammeRuntimeError` from a transport that
 * already knows its taxonomy (the HTTP transport's `HttpError`) travels unchanged, and anything
 * else becomes `NetworkError` (FLM3001) with the original failure kept as `cause`.
 *
 * A subscription artifact never reaches this stage: `subscriptionPlugin` owns its `network` stage.
 *
 * Persisted queries (`research/answers-report.md` Q4): when the client is configured for them the
 * request carries a `persistedQuery` marker, and a response that asks for the document is retried
 * once with `sendDocument: true`. The default HTTP transport retries an APQ miss itself (it must,
 * because a miss is an `errors`-only body it would otherwise classify as `GraphQLHttpError`); this
 * plugin's retry is the same rule for a custom transport that hands the miss back as a response. The
 * two can never stack: a retry is only attempted while `sendDocument === false`, and the retry sets
 * it to `true`.
 */
import type { ClientPlugin, RequestContext } from '../pipeline.js';
import { requestStateOf } from '../pipeline.js';
import type { TransportRequest } from '../client.js';
import { FlammeRuntimeError, NetworkError } from '../errors.js';
import { isPersistedQueryMiss } from '../network/transport.js';

/** `true` when a signal rejected the request (either the client aborted it or the transport did). */
export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  return error instanceof Error && error.name === 'AbortError';
}

/** The default network stage: `config.fetch(request, signal)` (or a per-request override). */
export function fetchPlugin(): ClientPlugin {
  return {
    name: 'fetchPlugin',
    network: async (ctx: RequestContext) => {
      const state = requestStateOf(ctx);
      if (!state.shouldFetch || ctx.artifact.kind === 'subscription') {
        return;
      }

      const persisted = ctx.client.config.persistedQueries;
      const request: TransportRequest = {
        query: ctx.artifact.raw,
        operationName: ctx.artifact.name,
        hash: ctx.artifact.hash,
        variables: ctx.variables,
        artifact: ctx.artifact,
        ...(persisted === undefined
          ? {}
          : {
              persistedQuery: {
                mode: 'apq' as const,
                hash: ctx.artifact.hash,
                sendDocument: false,
                retryOnNotFound: persisted.retryOnNotFound,
              },
            }),
      };
      const transport = state.fetcher ?? ctx.client.config.fetch;
      state.fetched = true;

      try {
        let response = await transport(request, ctx.signal);
        const spec = request.persistedQuery;
        if (
          spec !== undefined &&
          !spec.sendDocument &&
          spec.retryOnNotFound &&
          isPersistedQueryMiss(response)
        ) {
          response = await transport(
            { ...request, persistedQuery: { ...spec, sendDocument: true } },
            ctx.signal,
          );
        }
        state.response = response;
      } catch (error) {
        if (isAbortError(error, ctx.signal)) {
          state.aborted = true;
          state.abortReason = error;
          return;
        }
        state.error =
          error instanceof FlammeRuntimeError
            ? error
            : new NetworkError(
                `The transport for "${ctx.artifact.name}" rejected before a response existed.`,
                {
                  cause: error,
                  hint: 'check that the GraphQL endpoint is reachable and that the transport handles the request',
                },
              );
      }
    },
  };
}
