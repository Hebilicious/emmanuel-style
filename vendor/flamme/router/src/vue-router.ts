/**
 * `vue-router`'s stable entry points, re-exported for the auto layer.
 *
 * The adapter keeps every `vue-router/experimental` import in `./loader.js` (spec §2.2 rule 5). This
 * module is the matching seam for the *stable* surface the auto entry needs, so `./auto.js` names one
 * module instead of three, and a test can see exactly which vue-router bindings the generated-router
 * factory touches.
 *
 * `matchedRouteKey` is the record that renders the component calling `usePageQuery()`: vue-router's
 * `<RouterView>` provides it once per nesting level, which is what lets a page and the route group
 * nested inside it each read their **own** loader.
 */

export {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  matchedRouteKey,
  useRoute,
} from 'vue-router';
export type {
  RouteLocationNormalizedLoaded,
  RouteRecordNormalized,
  RouteRecordRaw,
  Router,
  RouterHistory,
} from 'vue-router';
