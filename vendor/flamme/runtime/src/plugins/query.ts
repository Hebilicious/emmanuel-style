/**
 * `queryPlugin` (§5.2): the kind plugin for `query` artifacts.
 *
 * `end` installs the document's cache subscription exactly once, at the fragment granularity the
 * registry speaks: the key is `_ROOT_::<hash>`, the selection is the artifact's own, and the
 * variables are read from the store at message time. An `update` message re-reads the document and
 * commits it; a `refetch` message re-sends the store with `NetworkOnly`. A page request never
 * installs a subscription (`cacheParams.disableSubscriptions`), and a torn-down request does not
 * install one at all.
 */
import type { ClientPlugin, RequestContext } from '../pipeline.js';
import { requestStateOf } from '../pipeline.js';
import { readDocument, reportPartial, ROOT_RECORD } from '../reader.js';
import type { CacheMessage } from '../cache.js';

/** The document-scoped cache subscription: masked reads resolve updates into the store. */
export function queryPlugin(): ClientPlugin {
  return {
    name: 'queryPlugin',
    end: (ctx: RequestContext) => {
      const state = requestStateOf(ctx);
      if (ctx.artifact.kind !== 'query' || state.pageRequest || state.aborted) {
        return;
      }
      const cache = ctx.client.cache;
      const artifact = ctx.artifact;
      const partialAllowed = artifact.partial ?? ctx.client.config.partial;

      const dispose = cache.subscribe({
        key: `${ROOT_RECORD}::${artifact.hash}`,
        rootType: artifact.rootType,
        selection: artifact.selection,
        parentID: ROOT_RECORD,
        variables: () => state.storeVariables,
        onMessage: (message: CacheMessage) => {
          if (message.kind === 'refetch') {
            state.resend('NetworkOnly');
            return;
          }
          const read = readDocument<unknown>(cache, artifact, state.storeVariables, {
            previous: ctx.result.data,
            ...(state.layer === null ? {} : { layer: state.layer }),
          });
          state.commitBackground({
            data: read.data,
            partial: reportPartial(read.partial, partialAllowed),
            stale: read.stale,
            source: read.partial ? 'partial' : 'cache',
          });
        },
      });
      state.installSubscription(dispose);
    },
  };
}
