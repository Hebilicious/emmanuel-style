/**
 * The browser entry point (`src/main.ts`).
 *
 * The router is **one call**: `createFlammeRouter` reads the generated route table
 * (`$flamme/routes`, written by `flamme()` from `src/pages/**`), binds every page's loader to this
 * client and hands back the `DataLoaderPlugin` options. There is no route table here, no
 * `createRouteLoaders`, no `meta.loaders` and no `provide`: the generator owns all of it, and the
 * pages call `usePageQuery()` with no argument.
 *
 * The client is built inside `start()` (one per page load, never at module scope, §8.11) and
 * installed before the router mounts, so the first component that calls a composable already has
 * its client injected.
 *
 * Local-first is the container's own `local` mode (`src/client.ts`): the one `app.use(flamme.plugin)`
 * installs the durable cache and the offline queue, and `useMutation` is local-first in every
 * component. `await flamme.ready` restores both **before** the router is built, so a warm page load
 * paints from the device with no request at all, and a queued write comes back with it.
 *
 * Order: the Flamme client, `DataLoaderPlugin` (before the router, the order vue-router documents),
 * then the router. `DataLoaderPlugin` installs the navigation guards that run each route's
 * generated loaders, so the page's request is already issued while the navigation resolves (REQ-4).
 */
import { DataLoaderPlugin } from '@flamme/router';
import { createApp, h } from 'vue';
import { RouterView, createWebHistory } from 'vue-router';

import { createAppClient } from './client.js';
import { createAppRouter } from './routes.js';

// Vite's CSS pipeline is entered through a bare import, and there is no binding to assign.
// oxlint-disable-next-line import/no-unassigned-import
import './styles.css';

async function start(): Promise<void> {
  const flamme = createAppClient();
  // before the router and before the first render: the loaders must be able to read the restored
  // cache, and the restore is what re-derives a queued local write into its optimistic layer
  await flamme.ready;
  const { router, dataLoader } = await createAppRouter({
    client: flamme.client,
    history: createWebHistory(),
  });
  // A bare `RouterView` root: the generated table already nests every page under the root layout
  // record, so mounting `+layout.vue` here as well would render the shell twice.
  const app = createApp({ render: () => h(RouterView) });

  app.use(flamme.plugin);
  app.use(DataLoaderPlugin, dataLoader());
  app.use(router);
  // Mounted before the first navigation settles (the page's loader makes `isReady()` wait for its
  // request). The shell renders its own loading state and the layout's `Favorites` query is issued
  // against an empty cache; waiting for the loader first would leave that query reading the cache
  // the loader had just written, and it would never send a request of its own.
  app.mount('#app');
}

void start();
