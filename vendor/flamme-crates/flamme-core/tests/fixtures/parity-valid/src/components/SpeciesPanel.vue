<script setup lang="ts">
/**
 * The left panel: favourite star, sprite, dex number, flavour text and the evolution chain.
 *
 * It reads only what `Info` selected (the loaded species), and hands that same masked object to
 * `Sprite` and to each `SpeciesPreview`, which is where the fragment masking chain is exercised.
 *
 * Its `types` slot is where the page puts `<RouterView />`: the species' types are a route group of
 * their own (`(types)/+page.vue`), so this panel stays a presentation component with no second read.
 */
import { computed } from 'vue';

import { Deferred, type DeferredSource } from '@flamme/vue';

import { EVOLUTION_SLOTS, type InfoSpecies } from '../species-types.js';
import Display from './Display.vue';
import Icon from './Icon.vue';
import Panel from './Panel.vue';
import Shimmer from './Shimmer.vue';
import SpeciesPreview from './SpeciesPreview.vue';
import SpeciesPreviewNumber from './SpeciesPreviewNumber.vue';
import SpeciesPreviewPlaceholder from './SpeciesPreviewPlaceholder.vue';
import Sprite from './Sprite.vue';

const props = defineProps<{
  readonly species: InfoSpecies | null;
  readonly loading: boolean;
  readonly favoritePending: boolean;
  /**
   * The page's query handle (or any `{ deferred, hasNext }` source): the boundary reads its
   * `@defer(label: "evolutionChain")` state, so the chain renders a skeleton until its patch lands
   * and never invents an empty chain.
   */
  readonly result: DeferredSource;
}>();

const emit = defineEmits<{ readonly toggle: [] }>();

/**
 * The chain padded to `EVOLUTION_SLOTS`; a missing form renders as a placeholder. Only the boundary's
 * default slot calls this, so it reads a chain the defer has already delivered — the optional field
 * cannot be `undefined` there, and `?? null` keeps the padding honest if a form is genuinely absent.
 */
const forms = computed(() =>
  Array.from(
    { length: EVOLUTION_SLOTS },
    (_, index) => props.species?.evolution_chain?.[index] ?? null,
  ),
);
</script>

<template>
  <Panel side="left" id="species-panel">
    <button
      id="favorite"
      type="button"
      class="favorite-button"
      data-testid="favorite"
      :disabled="props.favoritePending || props.species === null"
      @click="emit('toggle')"
    >
      <Icon name="star" :filled="props.species?.favorite === true" />
    </button>

    <Sprite id="species-sprite" :species="props.species" class="species-sprite" />

    <Shimmer v-if="props.loading || !props.species" width="60%" height="1.5em" />
    <Display v-else :message="props.species.name" />

    <SpeciesPreviewNumber :value="props.species?.pokedexNumber ?? '-'" />

    <!-- The species' types are a route group (`(types)/+page.vue`), not a prop: the page renders
         its `<RouterView />` into this slot, so the section owns its document and its loader. -->
    <slot name="types" />

    <Shimmer v-if="props.loading || !props.species" width="90%" height="3em" />
    <p v-else class="flavor-text" data-testid="flavor-text">{{ props.species.flavor_text }}</p>

    <div class="evolution" data-testid="evolution-chain">
      <Deferred :result="props.result" label="evolutionChain">
        <template #default>
          <template v-for="(form, index) in forms" :key="index">
            <SpeciesPreview v-if="form" :species="form" :number="index + 1" />
            <SpeciesPreviewPlaceholder v-else :number="index + 1" />
          </template>
        </template>
        <template #fallback="{ failed }">
          <span v-if="failed" class="warning" data-testid="evolution-chain-failed">
            the evolution chain could not be loaded
          </span>
          <div v-else class="evolution-fallback" data-testid="evolution-chain-fallback">
            <SpeciesPreviewPlaceholder v-for="index in EVOLUTION_SLOTS" :key="index" :number="index" />
          </div>
        </template>
      </Deferred>
    </div>
  </Panel>
</template>

<style scoped>
.species-sprite {
  width: 160px;
  height: 160px;
  margin: 0 auto;
}
.favorite-button {
  border: none;
  background: none;
  cursor: pointer;
}
.evolution {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1rem;
}
</style>
