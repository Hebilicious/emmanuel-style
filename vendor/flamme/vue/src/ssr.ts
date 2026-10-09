/**
 * The awaited SSR read (§8.3, §8.11).
 *
 * A page document normally reaches the server render through its route loader: the loader awaits the
 * request, `serialize()` carries the answer, and the component's `setup` seeds from the cache. A
 * document with **no loader** (an explicit `useQuery` on a shared document, `loaders: false`, a
 * component on a page whose query is not the route's) starts its request during `setup` and the
 * render finishes first, so the HTML carries the loading frame and the client fetches again.
 *
 * `useAwaitedQuery` is that read with one difference: on the server it waits for the request before
 * returning. On the client it is exactly `useQuery` — the hydrated payload answers the read, the
 * cache policy sees a complete read, and no request is issued. The component needs a `<Suspense>`
 * boundary, because an awaited `setup` is an async component (the same requirement every async
 * `setup` has).
 */
import type { MaybeRefOrGetter } from 'vue';
import { inject } from 'vue';
import type { Artifact, ArtifactData, ArtifactInput } from '@flamme/runtime';

import { useQuery, type QueryHandle, type UseQueryOptions } from './query.js';

/**
 * `useQuery`, awaited on the server.
 *
 * ```vue
 * const { data } = await useAwaitedQuery(NoLoaderQuery, () => ({ id: props.id }))
 * ```
 *
 * With `@flamme/router` the page's own document is a route contract and belongs in a loader; this is
 * for the documents a loader does not cover.
 */
export async function useAwaitedQuery<A extends Artifact<'query'>>(
  artifact: A,
  variables?: MaybeRefOrGetter<ArtifactInput<A>>,
  options?: UseQueryOptions,
): Promise<QueryHandle<ArtifactData<A>>> {
  const handle = useQuery(artifact, variables, options);
  // Before the first `await`, so the read stays inside the setup scope. This is the context
  // `useSSRContext()` returns (`@vue/server-renderer` provides it under this key), read with a
  // default: the public reader warns in DEV when there is no SSR context, which is the *normal*
  // case on the client, and a hydration warning per query is not acceptable noise.
  if (inject(SSR_CONTEXT_KEY, null) === null) {
    return handle;
  }
  await handle.settled?.();
  return handle;
}

/** Vue's SSR-context injection key: `Symbol.for('v-scx')`, the same one `useSSRContext()` reads. */
const SSR_CONTEXT_KEY: symbol = Symbol.for('v-scx');
