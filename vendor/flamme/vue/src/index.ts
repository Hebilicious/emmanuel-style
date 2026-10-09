/**
 * `@flamme/vue` — the Vue side of a Flamme artifact: the app plugin and one composable per
 * document kind, all reading the injected client (§8).
 *
 * Everything reactive this package owns is a `shallowRef` written by a cache callback plus
 * `computed` selectors over it; the cache itself is never wrapped in `reactive`/`ref` (D6). The two
 * loading predicates come from `@flamme/runtime` and are re-exported for template use (§8.7).
 */
export { FLAMME_KEY, FlammePlugin, createFlamme, useFlamme } from './client.js';
export type {
  FlammeApp,
  FlammeLocalOptions,
  FlammeOptions,
  FlammePluginOptions,
} from './client.js';

export { useSyncStatus } from './sync.js';
export type { SyncStatusHandle } from './sync.js';

export { useQuery } from './query.js';
export type { QueryHandle, UseQueryOptions } from './query.js';

/** The awaited SSR read of a document no route loader covers (§8.11). */
export { useAwaitedQuery } from './ssr.js';

export { useFragment, usePaginatedFragment } from './fragment.js';
export type {
  FragmentHandle,
  PaginatedFragmentHandle,
  PaginatedFragmentOptions,
} from './fragment.js';

export { Deferred, useDeferred } from './deferred.js';
export type { DeferredBoundary, DeferredInput, DeferredSource } from './deferred.js';

export { useMutation } from './mutation.js';
export type { DeepPartial, MutateOptions, MutationHandle, MutationOutcome } from './mutation.js';

export { useSubscription } from './subscription.js';
export type { SubscriptionHandle } from './subscription.js';

/* The predicates and the sentinel, re-exported so a template can import them from one place (§8.7). */
export { Pending, PendingValue, isLoaded, isPending } from '@flamme/runtime';
export { fragmentKey, isFragmentRef } from '@flamme/runtime';

/* Types a component or its `defineProps` names without importing the runtime directly (§8 intro). */
export type {
  Artifact,
  ArtifactData,
  ArtifactInput,
  ArtifactKey,
  CachePolicy,
  Client,
  DataSource,
  DeferredState,
  DeferredStatus,
  FragmentRef,
  FragmentReference,
  GraphQLResponseError,
  LoadedBranchOf,
  LoadingType,
  PageInfo,
  QueryResult,
  SerializedCache,
  Variables,
} from '@flamme/runtime';
