/**
 * The seven default plugins and the order §5.2 pins.
 *
 * `cachePlugin`, `fetchPlugin`, the kind plugin, the user's plugins, then `throwOnError` last so it
 * sees the final state. `fetchPlugin` sits immediately after `cachePlugin` because it supplies the
 * default `network` stage the policy decision feeds; the subscription kind plugin overrides that
 * stage for itself.
 */
import type { ArtifactKind } from '../artifact.js';
import type { ClientPlugin } from '../pipeline.js';
import { cachePlugin } from './cache.js';
import { fetchPlugin } from './fetch.js';
import { fragmentPlugin } from './fragment.js';
import { mutationPlugin } from './mutation.js';
import { queryPlugin } from './query.js';
import { subscriptionPlugin } from './subscription.js';
import { throwOnError } from './throwOnError.js';

export type { ThrowOnErrorOptions } from './throwOnError.js';
export { CACHE_MISS, cachePlugin, isCacheMiss, partialAllowed, requiresNetwork } from './cache.js';
export { fetchPlugin, isAbortError } from './fetch.js';
export { fragmentPlugin } from './fragment.js';
export { applyOperations, mutationPlugin } from './mutation.js';
export { queryPlugin } from './query.js';
export { subscriptionPlugin } from './subscription.js';
export { throwOnError } from './throwOnError.js';

export interface DefaultPluginsOptions {
  /** The user's plugins, placed between the kind plugin and `throwOnError`. */
  readonly userPlugins?: readonly ClientPlugin[];
  /** Enables the `throwOnError` plugin. Default `true`. */
  readonly throwOnError?: boolean;
}

/** The kind plugin of one artifact kind. */
export function kindPlugin(kind: ArtifactKind): ClientPlugin {
  if (kind === 'mutation') {
    return mutationPlugin();
  }
  if (kind === 'fragment') {
    return fragmentPlugin();
  }
  if (kind === 'subscription') {
    return subscriptionPlugin();
  }
  return queryPlugin();
}

/** The default plugin list for one artifact kind, in the §5.2 order. */
export function defaultPlugins(
  kind: ArtifactKind,
  options: DefaultPluginsOptions = {},
): readonly ClientPlugin[] {
  return [
    cachePlugin(),
    fetchPlugin(),
    kindPlugin(kind),
    ...(options.userPlugins ?? []),
    throwOnError({ enabled: options.throwOnError ?? true }),
  ];
}
