<script setup lang="ts">
/**
 * One evolution-chain entry (`SpeciesPreview.tsx`). It declares its own fragment, which itself
 * spreads `SpriteInfo`, so the nested masking chain `SpeciesPreview → SpriteInfo` is exercised by
 * passing this component's masked object straight to `Sprite`.
 */
import { isPending, useFragment } from '@flamme/vue';
import { graphql } from '$flamme';
import type { SpeciesPreview$key } from '$flamme';
import { computed } from 'vue';

import { useSpeciesPrefetch } from '../prefetch.js';
import { speciesPath } from '../species-path.js';
import Display from './Display.vue';
import NavLink from './NavLink.vue';
import SpeciesPreviewNumber from './SpeciesPreviewNumber.vue';
import SpeciesPreviewPlaceholder from './SpeciesPreviewPlaceholder.vue';
import Sprite from './Sprite.vue';

const props = defineProps<{
  readonly species: SpeciesPreview$key;
  readonly number: number;
}>();

const document = graphql(`
	fragment SpeciesPreview on Species @loading {
		name
		id
		pokedexNumber
		...SpriteInfo
	}
`);

const { data, pending } = useFragment(() => props.species, document);

/** Hovering this entry warms that species' page through its own `SpeciesPreview` fragment. */
const prefetchSpecies = useSpeciesPrefetch();

/**
 * The hover handler `NavLink` calls. It is guarded because the template's `form` is nullable while
 * the fragment is pending, even though the link itself only renders once it is loaded.
 */
function prefetchThisForm(): void {
  const value = form.value;
  if (value !== null) {
    prefetchSpecies(value.pokedexNumber);
  }
}

/** The loaded leaves plus the masked object `Sprite` needs, or `null` while pending. */
const form = computed(() => {
  const value = data.value;
  if (value === null || pending.value) {
    return null;
  }
  const name = value.name;
  const pokedexNumber = value.pokedexNumber;
  if (isPending(name) || isPending(pokedexNumber)) {
    return null;
  }
  return { name, pokedexNumber, masked: value };
});
</script>

<template>
  <SpeciesPreviewPlaceholder v-if="!form" :number="props.number" loading />
  <NavLink
    v-else
    class="preview"
    :to="speciesPath(form.pokedexNumber)"
    :prefetch="prefetchThisForm"
  >
    <SpeciesPreviewNumber :value="props.number" />
    <Sprite class="preview-sprite" :species="form.masked" />
    <Display :message="form.name" />
  </NavLink>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  color: inherit;
  padding: 0.5rem;
}
.preview-sprite {
  width: 102px;
  height: 102px;
}
</style>
