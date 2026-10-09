<script setup lang="ts">
/**
 * The favourites bar (`FavoritesContainer.tsx`). The query lives in the layout, not the page, so the
 * bar outlives navigation between species (spec §14.1 row 8). Its `favorites @list(name:
 * "FavoriteSpecies")` field is what the `ToggleFavorite` payload's `...FavoriteSpecies_toggle`
 * spread updates in place, with no refetch (behaviour 5).
 *
 * This is the app's one **component-level** read, and deliberately so: the bar is rendered by the
 * layout, which is the record for `/` and outlives the page, so the document has no route of its own
 * to hang a generated loader on. A layout that *does* want a loader puts its document in
 * `+layout.gql` beside the file, which the generator picks up exactly like a page's `+page.gql`.
 *
 * The document is a `.gql` file imported here, alongside the `graphql()` tags a component uses for
 * its own fragments.
 */
import { computed } from 'vue';

import { useQuery } from '@flamme/vue';

import FavoritesQuery from '../documents/Favorites.gql';
import FavoritePreview from './FavoritePreview.vue';
import Shimmer from './Shimmer.vue';

const { data, fetching, source } = useQuery(FavoritesQuery);

/**
 * `source` is `null` until a result exists, which is what separates "the bar has not answered yet"
 * from "the bar answered and nothing is selected". Without it the empty state can flash (and be
 * acted on) before the first response.
 */
const settled = computed(() => source.value !== null);

/**
 * The list elements; the loaded objects and a loading frame both satisfy the fragment's `$key`.
 *
 * `Array.isArray` is load-bearing and the compiler's types say so: a bare list loading frame is a
 * `LoadingType`, not an array (`Favorites$result` is the union of the answered shape and
 * `{ favorites: LoadingType }`), and `v-for` over the frame object would render one child per key.
 * The guard keeps the bar on its shimmer until a real array arrives.
 */
const favorites = computed(() => {
  const value = data.value?.favorites;
  return Array.isArray(value) ? value : [];
});
</script>

<template>
  <div id="favorites" class="favorites">
    <div
      v-if="!settled || (fetching && favorites.length === 0)"
      class="favorites-row"
      data-testid="favorites-loading"
    >
      <Shimmer v-for="slot in 3" :key="slot" width="3rem" height="3rem" />
    </div>
    <p v-else-if="favorites.length === 0" class="favorites-empty" data-testid="favorites-empty">
      No Favorites Selected
    </p>
    <ul v-else class="favorites-row" data-testid="favorites-list">
      <li v-for="(favorite, index) in favorites" :key="index" class="favorites-item">
        <FavoritePreview :species="favorite" />
      </li>
    </ul>
  </div>
</template>

<style scoped>
.favorites {
  min-height: 3.5rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid rgb(0 0 0 / 10%);
}
.favorites-row {
  display: flex;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
