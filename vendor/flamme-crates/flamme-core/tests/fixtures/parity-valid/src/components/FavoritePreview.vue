<script setup lang="ts">
/**
 * One element of the favourites bar (`FavoritePreview.tsx`). Its fragment is spread by the
 * `favorites @list(name: "FavoriteSpecies")` field, and the generated `FavoriteSpecies_toggle`
 * fragment in the `ToggleFavorite` payload carries exactly this selection, which is what makes the
 * bar update from the mutation response with no refetch (PoC behaviour 5).
 */
import { isPending, useFragment } from '@flamme/vue';
import { graphql } from '$flamme';
import type { FavoritePreview$key } from '$flamme';
import { computed } from 'vue';

import { speciesPath } from '../species-path.js';
import NavLink from './NavLink.vue';

const props = defineProps<{ readonly species: FavoritePreview$key }>();

const document = graphql(`
	fragment FavoritePreview on Species @loading {
		id
		pokedexNumber
		name
		sprites {
			front
		}
	}
`);

const { data, pending } = useFragment(() => props.species, document);

/** The loaded leaves, or `null` while the entry is a placeholder. */
const preview = computed(() => {
  const value = data.value;
  if (value === null || pending.value) {
    return null;
  }
  const name = value.name;
  const pokedexNumber = value.pokedexNumber;
  const front = value.sprites.front;
  if (isPending(name) || isPending(pokedexNumber) || isPending(front)) {
    return null;
  }
  return { name, pokedexNumber, front };
});
</script>

<template>
  <NavLink
    v-if="preview"
    class="favorite-preview"
    :to="speciesPath(preview.pokedexNumber)"
  >
    <img class="favorite-sprite" :src="preview.front" :alt="`${preview.name} sprite`" />
  </NavLink>
</template>

<style scoped>
.favorite-preview {
  display: flex;
  height: 100%;
}
.favorite-sprite {
  height: 3rem;
  width: auto;
  image-rendering: pixelated;
}
</style>
