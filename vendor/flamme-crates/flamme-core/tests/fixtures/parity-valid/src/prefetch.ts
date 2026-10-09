/**
 * The hover prefetch this app uses: warming another species' page through the fragment that page
 * renders first (`SpeciesPreview`).
 *
 * This is the **imperative** seam of `@flamme/router` (REQ-3's escape hatch), not the convention: a
 * prefetch happens on a `mouseenter`, outside any navigation, so there is no route loader to carry
 * it. The route's own query is generated (`src/pages/[[id]].vue` -> `Info` -> `/:id`); this module
 * only says "warm species N now, through the document that selects its preview".
 *
 * The call site is `NavLink`'s `mouseenter`. `prefetchFragment` runs the parent document (`Info`)
 * for the target record, so the fragment a child component is about to read through `useFragment`
 * is already in the cache; and because that request is the client's own in-flight entry for
 * `(Info, { id })`, the navigation's loader joins it. A hover followed by a click is therefore one
 * request in total, and the click itself issues none.
 *
 * The species page declares **two** documents (`Info` and the named `SpeciesTypes`), and a route's
 * loader runs every one of them: the hover warms both, so the navigation that follows is a cache
 * read for each and a prefetched page still costs no request.
 */
import { prefetch, prefetchFragment } from '@flamme/router';
import { useFlamme } from '@flamme/vue';
import { Info, SpeciesPreview, SpeciesTypes } from '$flamme';

/**
 * Returns the prefetch this app's components call on hover. The client comes from the app
 * (`useFlamme()`), so no call site passes one and no module-scope client is needed (one client per
 * page load, spec §8.11).
 */
export function useSpeciesPrefetch(): (id: number) => void {
  const client = useFlamme();
  return (id: number): void => {
    void Promise.all([
      prefetchFragment(
        client,
        SpeciesPreview,
        { parent: `${SpeciesPreview.rootType}:${String(id)}`, variables: {} },
        { parent: Info, variables: { id } },
      ),
      // the page's second document, so the navigation's other loader is a cache read too
      prefetch(client, SpeciesTypes, { id }),
    ])
      // a hover that fails is not an error the page renders: the navigation will fetch it itself
      .catch(() => undefined);
  };
}
