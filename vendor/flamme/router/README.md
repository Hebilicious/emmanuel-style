# @flamme/router

The bridge between a route and a GraphQL query, built on vue-router's experimental data loaders.

`src/pages/**` is the route table. `flamme()` (or `flammeRoutesPlugin()` in `flamme.config.ts`, for
the CLI) generates one route record per page, each carrying the loader of the query that page
declares, so neither the router nor the page names a document, a variable or the client:

```ts
// src/main.ts — the client is named once
import { DataLoaderPlugin } from '@flamme/router'
import { createFlammeRouter } from '@flamme/router/auto'
import { createApp } from 'vue'
import { createWebHistory } from 'vue-router'
import App from './pages/+layout.vue'
import { createAppClient } from './client.js'

const flamme = createAppClient()
const { router, dataLoader } = await createFlammeRouter({
  client: flamme.client,
  history: createWebHistory(),
})
const app = createApp(App)

app.use(flamme.plugin)
app.use(DataLoaderPlugin, dataLoader()) // before the router
app.use(router)
app.mount('#app')
```

```vue
<!-- src/pages/[[id]].vue — no loader import, no client, no variables getter -->
<script setup lang="ts">
import { usePageQuery } from '@flamme/router/auto'

const { data, errors, fetching, loadNextPage, pageInfo } = usePageQuery()
</script>
```

`src/pages/[[id]].vue` is `/:id?`; the loader's `$id` comes from `params.id`, coerced from the
document's own `Int!` (a param that cannot be coerced falls back to the document's default). The
explicit API below is unchanged and is the **escape hatch** for routes that do not follow the
convention — a hover prefetch, an app with its own route table, a loader with no page.

One route the file tree cannot express (a legacy URL, a redirect) does not need that escape hatch:
`createFlammeRouter({ client, routes: records, handwritten: [record] })` composes hand-written
`FlammeRoute` records with the generated table. A hand-written `name` that matches a generated record
**replaces** it, a `parent` nests under a generated record, `path: ''` is a pathless child (the
route-group shape), and a `path` collision or an unknown `parent` is a diagnostic (`FLM4017`,
`FLM4016`) rather than a route that is silently unreachable.

```ts
// src/loaders.ts — the escape hatch: the one place the query is declared, client included
import { createRouteLoaders, routeLoadersKey, type RouteQueryLoader } from '@flamme/router'
import { Info, type Info$result } from '$flamme'
import { client } from './client'

const loaders = createRouteLoaders(client)

export const info = loaders.query({
  artifact: Info,
  variables: (route) => ({ id: Number(route.params.id ?? 1) }),
})

export interface AppLoaders {
  readonly info: RouteQueryLoader<Info$result>
}
export const LOADERS_KEY = routeLoadersKey<AppLoaders>()
```

## Install

```sh
pnpm add @flamme/router vue-router
```

`vue-router` is pinned to the 5.x line that ships the loaders (`>= 5.0.0`; this package is built
against `5.3.1`). Loaders are experimental in vue-router and carry no semver promise, so this
package is the only place that imports `vue-router/experimental`.

`DataLoaderPlugin` must be registered on the app before the router is installed; the plugin
registers the navigation guards that collect and run the loaders. Pass the error types the app
renders itself as `errors`, so a failed query does not cancel the navigation (see
[Errors and redirects](#errors-and-redirects)).

## `createRouteLoaders(client)`

A loader runs during navigation, outside any component, so it cannot `inject` the client the app
installed. The factory binds the client **once**, at router-creation time, and every loader,
prefetch and fragment prefetch after it takes no client argument:

```ts
import { createRouteLoaders } from '@flamme/router'

const loaders = createRouteLoaders(client) // `client` is a `@flamme/runtime` Client

const info = loaders.query({ artifact: Info, variables: (route) => ({ id: route.params.id }) })
const warm = loaders.prefetch(Info, { id: 25 }) // a whole query
const fragment = loaders.prefetchFragment(SpriteInfo, reference, {
  // one fragment, for a known parent reference
  parent: Info,
  variables: { id: 25 },
})

void warm
void fragment
```

| member | purpose |
| --- | --- |
| `query({ artifact, variables, policy?, enabled?, background? })` | the route loader: list it in `meta.loaders` |
| `prefetch(artifact, variables, { policy?, signal? }?)` | warm a whole query (hover, idle, a guard) |
| `prefetchFragment(fragment, reference, { parent, variables, policy?, signal? })` | warm one fragment for a known parent reference |
| `client` | the client the factory bound |

`variables` is either a static object or a function of the resolved route; `enabled(route)` skips the
request for routes that cannot satisfy a precondition; `policy` overrides the artifact's cache policy
for this loader's request; `background: true` lets the navigation commit before the read answers
(see [Background documents](#background-documents)).

`client.queryLoader({ client, … })` remains the client-first form the factory delegates to. Use it
directly only when the client must be named per loader.

## `useRouteQuery(loader)`

The composable returns `useQuery`'s handle — `data`, `errors`, `fetching`, `partial`, `stale`,
`source`, `variables`, `connection`, `pageInfo`, `hasNextPage`, `hasPreviousPage`,
`loadingNextPage`, `loadingPreviousPage`, `loadNextPage()`, `loadPreviousPage()`, `refetch()`,
`store` — with two differences:

- it is built from the loader's artifact, variables and policy, so the page declares nothing; and
- `errors` is a `computed` union of the read's errors and the loader's, deduplicated by message, and
  `loaderError` exposes the loader's `QueryLoaderError` on its own.

Because the handle is `useQuery`, a page renders, pages and refetches exactly as it did before. And
because the loader's request already ran during navigation, mounting the page (and every fragment
child under it) issues **no** further request: the page reads the warm cache.

`DataLoaderPlugin` must be installed (it is what creates the per-router loader entry). A route that
does not list the loader still works: the page's handle triggers the loader at mount, so the first
paint is the loading state and the request is still the loader's one.

## Background documents

By default the navigation guard awaits every loader, so a cold move to a route holds the old screen
for the whole round trip. `background: true` (or `await: false` on `queryLoader`/`loaders.query`)
starts the read and commits the navigation immediately: the page renders its own pending state, the
payload lands in the cache when it arrives, and the page updates.

```ts
const info = loaders.query({
  artifact: Info,
  variables: (route) => ({ id: route.params.id }),
  background: true, // the guard does not wait for the response
})
```

```vue
<script setup lang="ts">
const { data, errors, fetching } = usePageQuery()
// `fetching` is true from the first paint until the payload lands; `data` is null until then
</script>
```

What a background loader guarantees:

- **The read is the same one request.** The guard calls `client.query` exactly as it does for an
  awaited loader, so the request is deduplicated and joinable through the client's in-flight table
  (§5.6): the page's own read joins it, a `prefetchRoute` warm either answers it from the cache or is
  joined by it, and a second navigation to a warm route costs nothing.
- **The handle is honest.** `usePageQuery()`/`useRouteQuery()` reports `fetching` while the response
  is outstanding and `data` stays `null`, which is exactly a read that has not answered yet. On a
  **composed** record the guard's composed request is the read, so its `isLoading` is what the handle
  reports while the record's own document read waits for the composed claim to end.
- **A failure lands on the page.** The navigation has already committed, so a failed background read
  cannot cancel it: the failure arrives in the handle's `errors` (and on the loader's `error` ref,
  which is also `loaderError`). `DataLoaderPlugin`'s `errors: [QueryLoaderError]` is still what keeps
  an *awaited* route's failure from cancelling its navigation.
- **SSR still awaits.** A server render cannot paint a pending state, so the option has no effect
  there: vue-router's guard awaits a background loader on the server, and the loader's own read
  settles before the navigation does, which is what the server renders from.
- **The composed claim still ends.** A background composed loader marks its request on the
  navigation exactly as an awaited one does, so the participant reads it pauses are released when the
  request settles; the claim is never left open.

For a generated app the whole table is one setting (`flamme.config.ts`):

```ts
export default defineConfig({
  routing: { loaders: 'background' }, // every generated loader is background
})
```

The generator writes the option into the composed loader and into every per-document loader, so a
record's own read agrees with the composed one. `routing.loaders: 'await'` (the default) reproduces
the previous behavior exactly.

## Route params to variables

One function of the route is the whole mapping:

```ts
const info = loaders.query({
  artifact: Info,
  // `/[[id]]` → `{ id }`, with the same fallback the route's `props` function uses
  variables: (route) => ({ id: Number(route.params.id ?? 1) }),
})
```

When the param changes while the route stays the same (`/1` → `/2`), the loader re-runs for the new
variables, the page's handle re-points at the new `(artifact, variables)` store, and the component is
not remounted.

## Fragments resolve warm

A route's colocated fragments are the reason the loader exists. The loader runs the page's query
during navigation, so each child component's `useFragment` reads its own fragment out of the cache
with no request of its own:

```vue
<!-- SpeciesPreview.vue — the child declares only its fragment -->
<script setup lang="ts">
import { useFragment } from '@flamme/vue'
import { graphql } from '$flamme'
import type { SpeciesPreview$key } from '$flamme'

const props = defineProps<{ readonly species: SpeciesPreview$key }>()
const document = graphql(`fragment SpeciesPreview on Species @loading { name id pokedexNumber }`)
const { data, pending } = useFragment(() => props.species, document)
</script>
```

The request count is the proof: one `Info` request for the navigation, then mounting `SpeciesPanel`,
`SpeciesPreview`, `Sprite`, `FavoritePreview` and the rest of the fragment tree adds none — the
loader's single request is what filled every fragment. `apps/pokedex/test/route-query.test.ts`
asserts exactly that, with the real client, a counting transport and the generated artifacts.

## Fragment-aware prefetch

`prefetch` warms a whole query; `prefetchFragment` warms **one fragment** for a known parent
reference (a hover, a modal, a sidebar). A fragment has no request of its own, so the parent document
is part of the call:

```ts
const loaders = createRouteLoaders(client)

// The reference a parent read produced: `{ parent: 'Species:25', variables: {} }`
void loaders.prefetchFragment(SpeciesPreview, { parent: 'Species:25', variables: {} }, {
  parent: Info, // the document whose selection spreads the fragment
  variables: { id: 25 },
})
```

- **Already warm** data is returned without a request: a hover over a record the current page already
  loaded is a cache read.
- **Otherwise** the parent document is fetched and the fragment is re-read; that request is the
  client's own in-flight entry for `(parent hash, variables)`, so it deduplicates against an
  identical read that is already running (a component's `useQuery`, the route's loader, another
  prefetch).
- A failed parent request still resolves when the fragment read produced data, and rethrows only when
  it did not.

## Prefetch outside a route

`prefetch` fills the cache for cases with no loader involved (hover, idle, a guard). Two prefetches
of the same artifact and variables share one request: deduplication is the client's own in-flight
table, so a prefetch that races a component's `useQuery` also joins it.

```ts
const loaders = createRouteLoaders(client)

await loaders.prefetch(Info, { id: 25 })
await loaders.prefetch(Info, { id: 25 }, { policy: 'NetworkOnly' })
```

## Warm the route a link points at

`prefetchRoute` warms what a **navigation** will read, from a location, outside any navigation:

```ts
import { prefetchRoute } from '@flamme/router'

// a row's hover, a viewport entry, idle time
prefetchRoute(client, router, router.resolve(`/${id}`))
void prefetchRoute(client, router, { name: '[id]', params: { id } })
```

A record's documents compile into **one composed operation** and the record's loader reads it, so the
warm is that loader's own read: the composed artifact with the variables the loader's own resolver
produces for the target (the route's params, coerced by the document's variable types). The loaders
come from the matched records' own meta (`meta.loaders`, else `meta.pageLoaders`), so the call site
names no document and the table stays the single source of truth.

| call | warms |
| --- | --- |
| `prefetchRoute(client, router, to, { signal? })` | the document a **navigation** of `to` reads, variables included |
| `prefetch(artifact, variables)` | one query artifact you name, with variables you resolve yourself |
| `prefetchFragment(fragment, reference, …)` | one fragment's data for a known parent reference |

The difference matters, and it is a request count. A warm through `prefetchRoute` is the *same*
`(artifact, variables)` the guard will read, so the navigation that follows is either a cache read or
a **join** of the request the warm started (dedupe is the default: same document and variables, no
`@dedupe(cancelFirst:)` opt-in). A loader settles on its own response's **first payload** for a
`@defer` document, and a read that joins one settles on the same payload, so a warm still in flight
when the reader moves costs the navigation no second request and no wait for the deferred patches.
Warming a participant document instead leaves the composed read incomplete, and warming a fragment
may not run the parent at all, and both are cache writes the navigation can still decide to fetch
around.

A target the cache already answers completely costs no request: each read runs under its loader's own
policy (`CacheOrNetwork` unless the loader or artifact says otherwise). A location a record
**redirects** is the one case the warm cannot follow: a redirect record carries no loader of its own,
and `router.resolve` does not follow the redirect, so warm the location the redirect names.

## Errors and redirects

A query that fails with a transport error, or that settles with any non-`CacheOnly`-miss error,
throws `QueryLoaderError`, which carries the `errors` list and the original `cause`. A `partial`
artifact accepts errors next to the data it resolved, so only a non-partial artifact turns a partial
answer into a failure. vue-router puts the error on the loader's `error` ref and reports it through
`router.onError`; there is no `onDataLoaderError` in the published API. An aborted navigation rethrows
the signal's own reason unchanged so the loader machinery swallows it, and the loader settles rather
than staying in a loading state.

By default a thrown loader error also cancels the navigation. An app that renders failures itself (a
missing record, an error page) passes the error types it expects to `DataLoaderPlugin`:

```ts
import { DataLoaderPlugin, QueryLoaderError } from '@flamme/router'

app.use(DataLoaderPlugin, { router, errors: [QueryLoaderError] })
```

The loader opts into that list with `errors: true` (the adapter's own `defineBasicLoader` call), which
is what vue-router requires before it consults the plugin-level list; without the list, the navigation
still fails exactly as it did before. The failure reaches the page through the handle:
`useRouteQuery(loader)` merges the loader's error into `errors` (deduplicated, so a page whose own
read reports the same GraphQL error renders one message) and exposes it alone as `loaderError`.

A **background** loader's failure cannot cancel a navigation that already committed: it arrives on
the handle's `errors` (and the loader's `error`) once the request settles. The `errors` list is still
what keeps an awaited route's expected failure from cancelling its navigation.

```ts
import { reroute } from '@flamme/router'

const info = loaders.query({
  artifact: Info,
  variables: (route) => ({ id: Number(route.params.id ?? 1) }),
  enabled: (route) => {
    if (Number.isNaN(Number(route.params.id))) reroute({ name: 'not-found' })
    return true
  },
})
```

## Why `defineBasicLoader`

The loader wraps vue-router's `defineBasicLoader`, not the Pinia Colada variant. The basic loader is
the only public integration point with no extra peer dependencies, and the client's normalized cache
already owns caching, deduplication and staleness, so a second query cache would be a second source
of truth. `defineColadaLoader` would pull in `pinia` and `@pinia/colada` and cache by query key,
neither of which fits a fragment-first cache.
