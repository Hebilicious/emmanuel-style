<script setup lang="ts">
/**
 * The species **types** section, as a route group: `src/pages/[[id]]/(types)/+page.vue`.
 *
 * `(types)` contributes no URL segment, so this component renders inside the `[[id]]` page, at the
 * `<RouterView />` the page puts where the section goes. Its document is the colocated
 * `(types)/+page.gql` (`SpeciesTypes`), which the generator compiles like any page document: the
 * `[[id]]` segment is coerced from the URL's string to the document's `$id: Int!` by name, and the
 * request is issued during the navigation by the group record's own loader.
 *
 * `usePageQuery()` takes **no argument**: it reads the loader of the record that renders *this*
 * component, which is the group's record. The parent page cannot read this document and this
 * component cannot read the parent's, which is what makes the two documents independent.
 */
import { computed } from 'vue';

import { usePageQuery } from '@flamme/router/auto';
import { isLoaded } from '@flamme/vue';

import type { SpeciesTypes$result } from '$flamme';

// `SpeciesTypes$result` is this record's own document: the generated registry holds every record's
// data, so a group names its own. The runtime needs no argument at all.
const { data } = usePageQuery<SpeciesTypes$result>();

/**
 * The types to render, or `[]` while the document is still a loading frame. `isLoaded` is the same
 * narrowing the page's primary read uses: a loading frame is not a readable species.
 */
const types = computed<readonly string[]>(() => {
  const value = data.value?.species ?? null;
  return value !== null && isLoaded(value) ? value.types : [];
});
</script>

<template>
  <ul v-if="types.length > 0" class="species-types" data-testid="species-types">
    <li v-for="type in types" :key="type" :data-type="type">{{ type }}</li>
  </ul>
</template>

<style scoped>
.species-types {
  display: flex;
  gap: 0.4rem;
  padding: 0;
  margin: 0.4rem 0 0;
  list-style: none;
}
.species-types li {
  padding: 0.1rem 0.5rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 0.8em;
  text-transform: capitalize;
}
</style>
