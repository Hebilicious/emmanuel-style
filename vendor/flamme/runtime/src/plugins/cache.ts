/**
 * `cachePlugin` (§5.2): the policy decision and the cache read.
 *
 * `beforeNetwork` resolves what the cache can answer, commits it (plus the loading frame of §7.1 and
 * the `CacheMiss` marker of §5.5) and records whether this request needs the network at all;
 * `afterNetwork` writes the payload, captures the document's page and commits the network result.
 * A page request (`cacheParams.disableSubscriptions`) never commits cache data: it exists to load a
 * page into the cache, and the waiting document store hears about it through its subscription.
 */
import type { Artifact, CachePolicy, DataSource } from '../artifact.js';
import { isLoadingFrame } from '../loading.js';
import { devWarn } from '../dev.js';
import { FlammeRuntimeError, NetworkError } from '../errors.js';
import {
  advanceDeferredState,
  applyIncrementalPatch,
  initialDeferredState,
  matchDeferred,
  type IncrementalPatch,
} from '../incremental.js';
import { isAbortError } from './fetch.js';
import type { ClientPlugin, RequestContext } from '../pipeline.js';
import { requestStateOf } from '../pipeline.js';
import { readDocument, reportPartial, writeDocument } from '../reader.js';
import type { GraphQLResponseError } from '../client.js';
import type { DocumentRead } from '../reader.js';

/**
 * The one exception to "a GraphQL error payload is data, not an exception" (§12.1): a `CacheOnly`
 * read that cannot answer reports this plain, frozen marker rather than an error class.
 */
export const CACHE_MISS: GraphQLResponseError = Object.freeze({ message: 'CacheMiss' });

/** `true` when this error is the `CacheMiss` marker rather than a real failure. */
export function isCacheMiss(error: GraphQLResponseError): boolean {
  return error === CACHE_MISS;
}

/**
 * The incremental state a request that will *not* fetch leaves behind (§7.13): nothing is coming, so
 * no target stays pending. The fields either are in the cache (`partial`/the fragment read says so)
 * or they are not, and a boundary that waited would wait forever.
 */
function settledIncremental(artifact: Artifact): {
  readonly hasNext: false;
  readonly deferred: ReturnType<typeof initialDeferredState>;
} {
  return {
    hasNext: false,
    deferred: initialDeferredState(artifact, {}, false),
  };
}

/** `true` when the policy needs a transport call, given what the cache just answered (§5.5). */
export function requiresNetwork(policy: CachePolicy, read: DocumentRead<unknown> | null): boolean {
  if (policy === 'CacheOnly') {
    return false;
  }
  if (policy === 'CacheOrNetwork') {
    return read === null || !read.hasData || read.partial || read.stale;
  }
  // NetworkOnly and CacheAndNetwork both always fetch
  return true;
}

/** The `source` a cache read reports: `partial` when fields are missing, `cache` otherwise. */
function cacheSource(partial: boolean): DataSource {
  return partial ? 'partial' : 'cache';
}

/** The cache plugin: masked reads, policy, partial/stale, loading frames and the payload write. */
export function cachePlugin(): ClientPlugin {
  return {
    name: 'cachePlugin',
    beforeNetwork: (ctx: RequestContext) => {
      const state = requestStateOf(ctx);
      const client = ctx.client;
      const enabled = client.config.enabled;
      const partialOk = ctx.artifact.partial ?? client.config.partial;
      const layer = state.layer ?? undefined;

      if (state.pageRequest) {
        // a page request writes the page and leaves the document state alone
        const shouldFetch = enabled && ctx.policy !== 'CacheOnly';
        state.shouldFetch = shouldFetch;
        ctx.commit({
          fetching: shouldFetch,
          variables: state.storeVariables,
          errors: null,
          ...(shouldFetch ? {} : settledIncremental(ctx.artifact)),
        });
        return;
      }

      if (state.optimistic !== undefined) {
        // the mutation plugin already committed the layer's read; the cache read would clobber it
        state.shouldFetch = enabled && requiresNetwork(ctx.policy, null);
        ctx.commit({
          fetching: state.shouldFetch,
          variables: ctx.variables,
          errors: null,
          ...(state.shouldFetch ? {} : settledIncremental(ctx.artifact)),
        });
        return;
      }

      if (ctx.policy === 'NetworkOnly') {
        // the read is skipped for the result but the write below still uses the selection
        state.shouldFetch = enabled;
        ctx.commit({
          fetching: enabled,
          variables: ctx.variables,
          errors: null,
          ...(enabled ? {} : settledIncremental(ctx.artifact)),
        });
        return;
      }

      const read = readDocument<unknown>(client.cache, ctx.artifact, ctx.variables, {
        previous: ctx.result.data,
        ...(layer === undefined ? {} : { layer }),
      });
      state.read = read;
      state.shouldFetch = enabled && requiresNetwork(ctx.policy, read);
      const missing = !read.hasData || read.partial;

      if (read.hasData) {
        // the stored value graph; for a `@loading` artifact it already carries the frame's
        // placeholders for every field the cache could not answer (§7.1)
        ctx.commit({
          data: read.data,
          partial: reportPartial(read.partial, partialOk),
          stale: read.stale,
          source: cacheSource(read.partial),
          variables: ctx.variables,
        });
      } else if (state.shouldFetch && read.data !== null) {
        // nothing is stored and a request is on the way: the whole read is the loading frame
        ctx.commit({ data: read.data, partial: false });
      } else {
        // nothing is stored and nothing will arrive: the store is partial, with no frame
        ctx.commit({ partial: reportPartial(true, partialOk), variables: ctx.variables });
      }

      if (ctx.policy === 'CacheOnly' && missing) {
        ctx.commit({
          partial: true,
          source: 'cache',
          errors: [CACHE_MISS],
          fetching: false,
          variables: ctx.variables,
        });
        return;
      }

      ctx.commit({
        fetching: state.shouldFetch,
        variables: ctx.variables,
        errors: null,
        ...(state.shouldFetch ? {} : settledIncremental(ctx.artifact)),
      });
    },
    afterNetwork: async (ctx: RequestContext): Promise<void> => {
      const state = requestStateOf(ctx);
      if (!state.fetched || state.aborted) {
        return;
      }
      if (state.error !== undefined) {
        const failure =
          state.error instanceof Error
            ? state.error
            : new NetworkError('The transport rejected before a response existed.', {
                cause: state.error,
              });
        ctx.commit({
          errors: [failure],
          fetching: false,
          // the stream is over: a target that never arrived stays pending, which the boundary reads
          // as failed because `hasNext` is now false (§7.13)
          hasNext: false,
          ...frameCleared(ctx.result.data),
        });
        return;
      }
      const response = state.response;
      if (response === null) {
        return;
      }
      const errors = response.errors ?? null;
      if (response.data === undefined || response.data === null) {
        // an errors-only response is data: the store keeps the data it already had (§12.1), except
        // for a loading frame, which stands for a request that has now failed
        ctx.commit({ errors, fetching: false, hasNext: false, ...frameCleared(ctx.result.data) });
        return;
      }

      const partialOk = ctx.artifact.partial ?? ctx.client.config.partial;
      const layer = state.layer ?? undefined;
      writeDocument(ctx.client.cache, ctx.artifact, response.data, ctx.variables, {
        ...(layer === undefined ? {} : { layer }),
        ...(state.pageUpdates.length === 0 ? {} : { applyUpdates: state.pageUpdates }),
      });

      if (!state.pageRequest) {
        // the document's own write owns the current page of the page cache (§6.10)
        ctx.client.cache.capturePage(ctx.artifact, ctx.variables);
      }

      const read = readDocument<unknown>(
        ctx.client.cache,
        ctx.artifact,
        state.pageRequest ? state.storeVariables : ctx.variables,
        {
          previous: state.pageRequest ? ctx.result.data : undefined,
          ...(layer === undefined ? {} : { layer }),
        },
      );
      // §7.13: `hasNext` announces that this is the first of several payloads. The result says so,
      // and every declared `@defer`/`@stream` target whose `if:` holds is `pending` until its patch
      // lands; a server that ignored the directives answers with no `hasNext` and everything is
      // already `ready`.
      const incremental = response.hasNext === true;
      state.deferred = initialDeferredState(ctx.artifact, ctx.variables, incremental);
      ctx.commit({
        data: read.data,
        partial: reportPartial(read.partial, partialOk),
        stale: read.stale,
        source: 'network',
        errors,
        extensions: response.extensions ?? null,
        fetching: incremental || ctx.result.fetching,
        hasNext: incremental,
        deferred: state.deferred,
        variables: state.pageRequest ? state.storeVariables : ctx.variables,
      });

      if (incremental && response.patches !== undefined) {
        await consumePatches(ctx, response.patches);
      }
    },
  };
}

/**
 * Merges the incremental patches of one response as they arrive (§7.13).
 *
 * Each patch is written into the normalized cache and the document is re-read, so a subscriber at
 * fragment granularity renders the moment its own fields land — the parent's result is only replaced
 * when the read produced something new. The four behaviours this function is responsible for:
 *
 * * **Out of order.** Patches are applied one at a time and each names its own path, so two targets
 *   (and two elements of one target under a list) do not depend on each other's order.
 * * **A patch with `errors`.** The data member is still merged when there is one, and the errors are
 *   appended to the result's `errors`; an errors-only patch changes nothing but the errors.
 * * **A path the cache no longer holds** (a reset, or an evicted record). The write is skipped, a DEV
 *   warning names the label and path, the target still completes, and `partial` reports the absent
 *   fields. No exception reaches the caller: a patch for data nobody asked for any more is not a
 *   failure of the request.
 * * **A stream that is torn down** (the transport rejects mid-body, or the client is disposed). The
 *   patches already merged stay, the error is recorded, `hasNext` becomes `false`, and every target
 *   that never arrived stays `pending` — which, with `hasNext: false`, is how a boundary tells
 *   "failed" from "still coming" (§8.7, the `Deferred` component).
 */
async function consumePatches(
  ctx: RequestContext,
  patches: AsyncIterable<IncrementalPatch>,
): Promise<void> {
  const state = requestStateOf(ctx);
  const partialOk = ctx.artifact.partial ?? ctx.client.config.partial;
  const initialErrors = ctx.result.errors ?? [];
  const collected: GraphQLResponseError[] = [];
  let hasNext = true;

  const commitPatch = (): void => {
    const read = readDocument<unknown>(
      ctx.client.cache,
      ctx.artifact,
      state.pageRequest ? state.storeVariables : ctx.variables,
      { previous: ctx.result.data },
    );
    ctx.commit({
      data: read.data,
      partial: reportPartial(read.partial, partialOk),
      stale: read.stale,
      source: 'network',
      errors: collected.length === 0 ? ctx.result.errors : [...initialErrors, ...collected],
      hasNext,
      deferred: state.deferred,
      variables: state.pageRequest ? state.storeVariables : ctx.variables,
    });
  };

  try {
    for await (const patch of patches) {
      if (ctx.signal.aborted) {
        break;
      }
      const outcome = applyIncrementalPatch(
        ctx.client.cache,
        ctx.artifact,
        state.pageRequest ? state.storeVariables : ctx.variables,
        patch,
      );
      if (outcome.missingPath) {
        devWarn(
          `The incremental patch at [${patch.path.join(', ')}] (label "${patch.label ?? matchDeferred(ctx.artifact.deferred ?? [], patch)?.label ?? '?'}") found no record to write, so its fields stay absent.`,
          'the cache no longer holds that path: a reset or an eviction happened while the response was streaming',
        );
      }
      if (patch.errors !== undefined) {
        collected.push(...patch.errors);
      }
      state.deferred = advanceDeferredState(state.deferred, ctx.artifact, patch);
      hasNext = patch.hasNext;
      if (!state.pageRequest) {
        commitPatch();
      }
      if (!hasNext) {
        break;
      }
    }
  } catch (error) {
    if (isAbortError(error, ctx.signal)) {
      ctx.commit({ hasNext: false, fetching: false, deferred: state.deferred });
      return;
    }
    const failure =
      error instanceof FlammeRuntimeError
        ? error
        : new NetworkError('The incremental response ended before its last patch.', { cause: error });
    ctx.commit({
      errors: [...initialErrors, ...collected, failure],
      hasNext: false,
      fetching: false,
      deferred: state.deferred,
    });
    return;
  }
  ctx.commit({ hasNext: false, fetching: false, deferred: state.deferred });
}

/** The patch that replaces a loading frame with `null` once its request has failed. */
function frameCleared(data: unknown): Partial<{ data: null; partial: boolean }> {
  return isLoadingFrame(data) ? { data: null, partial: true } : {};
}

/** The artifact-level `@cache(partial:)` / `config.partial` a caller can read without a request. */
export function partialAllowed(artifact: Artifact, configured: boolean): boolean {
  return artifact.partial ?? configured;
}
