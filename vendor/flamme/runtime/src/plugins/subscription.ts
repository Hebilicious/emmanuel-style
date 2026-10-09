/**
 * `subscriptionPlugin` (§5.2, §8.6): the kind plugin for `subscription` artifacts.
 *
 * It owns the `network` stage (`fetchPlugin` skips subscription artifacts): it opens
 * `config.subscribe(request, handlers)`, writes every payload into the cache and commits the
 * re-read result, and keeps the returned close function for the teardown. A transport that errors
 * or closes before `complete` surfaces as `SubscriptionTransportError` (FLM3004).
 */
import type { ClientPlugin, RequestContext } from '../pipeline.js';
import { requestStateOf } from '../pipeline.js';
import { readDocument, reportPartial } from '../reader.js';
import { SubscriptionTransportError } from '../errors.js';
import type { TransportRequest } from '../client.js';

/** The subscription transport: one open stream per store, closed on teardown. */
export function subscriptionPlugin(): ClientPlugin {
  return {
    name: 'subscriptionPlugin',
    network: (ctx: RequestContext) => {
      if (ctx.artifact.kind !== 'subscription') {
        return;
      }
      const state = requestStateOf(ctx);
      const subscribe = ctx.client.config.subscribe;
      if (subscribe === undefined) {
        const failure = new SubscriptionTransportError(
          `No subscription transport is configured, so "${ctx.artifact.name}" cannot be opened.`,
          { hint: 'pass `subscribe` to createClient (see §5.1)' },
        );
        state.error = failure;
        ctx.commit({ errors: [failure], fetching: false });
        return;
      }

      state.fetched = true;
      const request: TransportRequest = {
        query: ctx.artifact.raw,
        operationName: ctx.artifact.name,
        hash: ctx.artifact.hash,
        variables: ctx.variables,
        artifact: ctx.artifact,
      };
      const partialAllowed = ctx.artifact.partial ?? ctx.client.config.partial;

      const close = subscribe(request, {
        next: (response) => {
          reportOpened(state);
          if (response.data !== undefined && response.data !== null) {
            ctx.client.cache.write({
              selection: ctx.artifact.selection,
              data: response.data,
              variables: ctx.variables,
            });
          }
          const read = readDocument<unknown>(ctx.client.cache, ctx.artifact, state.storeVariables, {
            previous: ctx.result.data,
          });
          ctx.commit({
            data: read.data,
            partial: reportPartial(read.partial, partialAllowed),
            stale: read.stale,
            source: 'network',
            errors: response.errors ?? null,
            extensions: response.extensions ?? null,
            fetching: false,
            variables: state.storeVariables,
          });
        },
        error: (error) => {
          const failure = new SubscriptionTransportError(
            `The subscription "${ctx.artifact.name}" errored before it completed.`,
            { cause: error, hint: 'check the subscription transport and the server logs' },
          );
          state.error = failure;
          ctx.commit({ errors: [failure], fetching: false });
          reportClosed(state);
        },
        complete: () => {
          ctx.commit({ fetching: false });
          reportClosed(state);
        },
      });
      state.closeSubscription = close;
      // `open` means "the transport accepted this subscription", which is the moment
      // `config.subscribe` returned a closer. A transport that failed synchronously already fired
      // `close`, so it must not open retroactively (`review-slice34-adversarial.md` M14).
      if (!state.subscriptionClosed) {
        reportOpened(state);
      }
    },
    cleanup: (ctx: RequestContext) => {
      const state = requestStateOf(ctx);
      const close = state.closeSubscription;
      state.closeSubscription = null;
      close?.();
      reportClosed(state);
    },
  };
}

/** Fires the `Client.subscribe` open hook exactly once per request, on the first payload. */
function reportOpened(state: { onSubscriptionOpen: (() => void) | undefined; subscriptionOpened: boolean }): void {
  if (state.subscriptionOpened) {
    return;
  }
  state.subscriptionOpened = true;
  state.onSubscriptionOpen?.();
}

/** Fires the `Client.subscribe` close hook exactly once per request. */
function reportClosed(state: { onSubscriptionClose: (() => void) | undefined; subscriptionClosed: boolean }): void {
  if (state.subscriptionClosed) {
    return;
  }
  state.subscriptionClosed = true;
  state.onSubscriptionClose?.();
}
