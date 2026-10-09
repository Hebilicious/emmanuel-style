/**
 * `fragmentPlugin` (§5.2): no network path at all.
 *
 * A fragment store reads one `{ parent, variables }` reference; `end` registers one
 * `SubscriptionSpec` keyed by that parent (`<parent>::<hash>`) and resolves `update` messages
 * straight into the store, so a write anywhere in the parent record re-reads the fragment's own
 * masked fields. `client.readFragment` / `client.subscribeFragment` are the reference-based form of
 * the same path; the store form needs the additive `DocumentStoreOptions.reference` (§5.3), because
 * the frozen options carry no parent id.
 */
import type { ClientPlugin, RequestContext } from '../pipeline.js';
import { requestStateOf } from '../pipeline.js';
import { readDocument, reportPartial } from '../reader.js';
import type { CacheMessage } from '../cache.js';
import { devWarn } from '../dev.js';

/** The fragment store's cache subscription: `${reference.parent}::${artifact.hash}`. */
export function fragmentPlugin(): ClientPlugin {
  return {
    name: 'fragmentPlugin',
    end: (ctx: RequestContext) => {
      const state = requestStateOf(ctx);
      if (ctx.artifact.kind !== 'fragment' || state.aborted) {
        return;
      }
      const reference = state.reference;
      if (reference === null) {
        devWarn(
          `A store for fragment "${ctx.artifact.name}" has no reference to read through (FLM4002).`,
          'pass reference: { parent, variables } to client.observe, or use client.readFragment',
        );
        return;
      }
      const cache = ctx.client.cache;
      const artifact = ctx.artifact;
      const partialAllowed = artifact.partial ?? ctx.client.config.partial;

      const dispose = cache.subscribe({
        key: `${reference.parent}::${artifact.hash}`,
        rootType: artifact.rootType,
        selection: artifact.selection,
        parentID: reference.parent,
        variables: () => reference.variables,
        onMessage: (_message: CacheMessage) => {
          const read = readDocument<unknown>(cache, artifact, reference.variables, {
            parent: reference.parent,
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
