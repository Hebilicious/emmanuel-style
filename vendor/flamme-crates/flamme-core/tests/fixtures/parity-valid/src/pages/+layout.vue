<script setup lang="ts">
/**
 * The layout: the favourites bar above the routed page (`src/pages/+layout.vue`). The route
 * generator turns it into the outermost route record and nests the pages under it through
 * `<RouterView>`, so the bar is not unmounted when the page navigates between species
 * (REQ-1; `src/routes/[[id]]/+layout.tsx` in the example).
 *
 * Its `Favorites` query is a component-level read (`FavoritesContainer`), not a route loader: the
 * document belongs to the bar, which every route renders, so it has no route of its own to hang a
 * loader on. `+layout.gql` beside this file is the convention for a layout that *does* need one.
 */
import { RouterView } from 'vue-router';

import FavoritesContainer from '../components/FavoritesContainer.vue';
</script>

<template>
  <main class="app">
    <h1 class="app-title">Pokédex</h1>
    <FavoritesContainer />
    <RouterView />
  </main>
</template>

<style scoped>
.app {
  max-width: 60rem;
  margin: 0 auto;
  padding: 1rem;
}
.app-title {
  font-size: 2rem;
}
</style>
