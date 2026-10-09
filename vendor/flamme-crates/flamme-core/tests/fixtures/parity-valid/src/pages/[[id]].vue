<script setup lang="ts">
/**
 * The species page (`src/routes/[[id]]/+page.tsx` in the example), as `src/pages/[[id]].vue`.
 *
 * Its `Info` document is the colocated `[[id]]/+page.gql` next to it, which the route generator
 * finds and turns into the route's loader: the `[[id]]` segment is coerced from the URL's string to
 * the document's `$id: Int!` by name, with no call-site wiring (REQ-2). The `ToggleFavorite`
 * mutation is colocated as a `graphql()` tagged template and the layout's favourites query is a
 * `.gql` file, so both document surfaces of the app are exercised.
 *
 * The page's **second** document, `SpeciesTypes`, is a **route group**: `[[id]]/(types)/+page.gql`
 * with its own component, `[[id]]/(types)/+page.vue`, which this page renders through the
 * `SpeciesPanel`'s `types` slot (`<RouterView />`). The group's record nests inside this one at the
 * same URL and its loader is issued in the same navigation, so the two documents cost two requests
 * in one round trip; each component reads its own with `usePageQuery()` and neither can read the
 * other's.
 *
 * `usePageQuery()` takes **no argument**: it reads the loader of the page currently rendering from
 * vue-router's own route records, so this file names no document, no client and no variables. The
 * handle is `useQuery`'s, so the template renders, pages and refetches exactly as before, and the
 * loader's failed read arrives in the same `errors`.
 *
 * The star is the ordinary `useMutation`, and it is local-first because the app installed a local
 * store (`createFlamme({ local })` in `src/client.ts`): the write is queued durably, replayed when
 * connectivity returns, and the page shows one status banner while it waits. The component imports
 * nothing from `@flamme/local` to get that.
 */
import { computed, shallowRef } from 'vue';

import { usePageQuery } from '@flamme/router/auto';
import { isLoaded, useMutation, useSyncStatus } from '@flamme/vue';
import { RouterView, useRoute } from 'vue-router';
import { graphql, type Info$result } from '$flamme';

import Container from '../components/Container.vue';
import { speciesIdOf } from '../species-id.js';
import ErrorPanel from '../components/ErrorPanel.vue';
import MoveBrowser from '../components/MoveBrowser.vue';
import SpeciesPanel from '../components/SpeciesPanel.vue';

/**
 * The route id, for the child that renders the move page. It comes from the route itself, not from
 * a `props` function: the generated route record passes no props, because the id the page renders
 * is the id the loader already read (through the generator's coercion of `[[id]]`), so a second
 * prop would be a second source of truth.
 */
const route = useRoute();
const id = computed(() => speciesIdOf(route.params['id']));

/**
 * The route's `Info` read, sourced from the loader and therefore from the cache. Paging is the
 * handle's own surface (`loadNextPage`/`loadPreviousPage` plus `loadingNextPage`/
 * `loadingPreviousPage` and `hasNextPage`/`hasPreviousPage`), exactly as spec §8.3 documents it; the
 * app keeps no cursor state of its own.
 *
 * `errors` is already the page's whole error surface: the loader's failure and this read's own
 * errors, merged and deduplicated by the composable.
 */
// The type argument is the record's own document: with a route group in the table the generated
// registry is a union of both records' data, and `usePageQuery()` picks its loader at runtime.
const query = usePageQuery<Info$result>();
const {
  data,
  errors,
  fetching,
  refetch,
  hasNextPage,
  hasPreviousPage,
  loadingNextPage,
  loadingPreviousPage,
  loadNextPage,
  loadPreviousPage,
} = query;

const toggleFavoriteDocument = graphql(`
	mutation ToggleFavorite($id: Int!) {
		toggleFavorite(id: $id) {
			species {
				id
				favorite
				...FavoriteSpecies_toggle
			}
		}
	}
`);

const { online, pending } = useSyncStatus();

/**
 * The star's own call, not the queue's state: `pending` here is true only from this click's call
 * until its outcome is known, and `errors` carries what the server said if the write was refused.
 * The queue-wide `pending` above counts entries waiting for a delivery pass, which is not what a
 * disabled control means.
 */
const { mutate, pending: favoritePending, errors: mutationErrors } = useMutation(toggleFavoriteDocument);
const mutationError = shallowRef<string | null>(null);

/** `isLoaded` removes the loading frame, so the panels only ever see readable fields (§8.3). */
const species = computed(() => {
  const value = data.value?.species ?? null;
  return value !== null && isLoaded(value) ? value : null;
});

/** The error row of §12.3: no data, no request in flight, and at least one error. */
const failed = computed(
  () => species.value === null && !fetching.value && (errors.value?.length ?? 0) > 0,
);

/** Shimmer state: no readable species and no error to show. */
const loading = computed(() => species.value === null && !failed.value);

/**
 * Flips the star. The optimistic payload writes `favorite` into a cache layer before anything is
 * sent, so the star turns immediately; the mutation's `...FavoriteSpecies_toggle` spread updates the
 * `FavoriteSpecies` list in the same layer, which is why the bar needs no refetch (§8.5).
 *
 * Because the app is local-first, this call queues the write durably: the star survives a reload
 * while offline and is replayed in order when the server is reachable again. A GraphQL rejection
 * parks the entry instead of rejecting the call, so the server's reason arrives in `errors` and the
 * queue-wide `pending` (the banner's count) keeps the entry visible until the app resolves it. The
 * call needs no `try`/`finally` of its own: `favoritePending` is the handle's, and it goes back down
 * when the call settles.
 */
async function toggleFavorite(): Promise<void> {
  const current = species.value;
  if (current === null) {
    return;
  }
  mutationError.value = null;
  await mutate({
    variables: { id: current.id },
    optimistic: {
      toggleFavorite: { species: { id: current.id, favorite: !current.favorite } },
    },
  });
  mutationError.value = mutationErrors.value?.[0]?.message ?? null;
}
</script>

<template>
  <ErrorPanel v-if="failed" :errors="errors ?? []" :retry="refetch" />
  <Container v-else>
    <p v-if="mutationError" class="warning" data-testid="mutation-error">{{ mutationError }}</p>
    <p v-else-if="(errors?.length ?? 0) > 0" class="warning" data-testid="partial-warning">
      {{ errors?.[0]?.message }}
    </p>

    <!-- The whole local-first surface a reader sees: offline, or writes still on their way. -->
    <p
      v-if="!online || pending > 0"
      class="local-status"
      data-testid="sync-status"
      :data-online="String(online)"
      :data-pending="String(pending)"
    >
      {{
        online
          ? `${pending} change${pending === 1 ? '' : 's'} waiting to sync`
          : 'Offline, changes are saved locally'
      }}
    </p>

    <SpeciesPanel
      :species="species"
      :loading="loading"
      :favorite-pending="favoritePending"
      :result="query"
      @toggle="toggleFavorite"
    >
      <!-- The route group's section: `(types)/+page.vue` renders its own document here. -->
      <template #types><RouterView /></template>
    </SpeciesPanel>

    <MoveBrowser
      :id="id"
      :species="species"
      :loading="loading"
      :has-next-page="hasNextPage"
      :has-previous-page="hasPreviousPage"
      :loading-next-page="loadingNextPage"
      :loading-previous-page="loadingPreviousPage"
      @next="loadNextPage()"
      @previous="loadPreviousPage()"
    />
  </Container>
</template>

<style scoped>
.warning {
  flex-basis: 100%;
  color: darkorange;
}
.local-status {
  flex-basis: 100%;
  color: dimgray;
  font-style: italic;
}
</style>
