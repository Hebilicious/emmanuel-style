<script setup lang="ts">
/**
 * The right panel: one move per page, with the up/down arrows whose disabled state comes from the
 * paginated connection's `pageInfo`, plus the prev/next species navigation (`NavLink`).
 */
import { computed } from 'vue';

import { useSpeciesPrefetch } from '../prefetch.js';
import { speciesPath } from '../species-path.js';
import type { InfoSpecies, MoveEntry } from '../species-types.js';
import DownButton from './DownButton.vue';
import MoveDisplay from './MoveDisplay.vue';
import NavLink from './NavLink.vue';
import Panel from './Panel.vue';
import Shimmer from './Shimmer.vue';
import UpButton from './UpButton.vue';

const props = defineProps<{
  readonly species: InfoSpecies | null;
  readonly loading: boolean;
  readonly id: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly loadingNextPage: boolean;
  readonly loadingPreviousPage: boolean;
}>();

const emit = defineEmits<{ readonly next: []; readonly previous: [] }>();

/** Hovering a species link warms that species' page through its `SpeciesPreview` fragment. */
const prefetchSpecies = useSpeciesPrefetch();

/**
 * `moves(first: 1)` in `SinglePage` mode replaces the edge, so the first edge is the page. A page
 * request materializes an `@loading(count: 1)` placeholder list, which yields no node here, so the
 * previous page's stats are replaced by a shimmer rather than by a layout jump.
 */
const firstMove = computed<MoveEntry | null>(() => props.species?.moves.edges[0]?.node ?? null);

const previousDisabled = computed(
  () => props.loading || props.loadingPreviousPage || !props.hasPreviousPage,
);
const nextDisabled = computed(() => props.loading || props.loadingNextPage || !props.hasNextPage);
</script>

<template>
  <Panel side="right" id="move-panel">
    <div id="move-controls" class="move-controls">
      <UpButton :disabled="previousDisabled" @click="emit('previous')" />
      <DownButton :disabled="nextDisabled" @click="emit('next')" />
    </div>

    <MoveDisplay v-if="firstMove" :move="firstMove" />
    <Shimmer v-else width="100%" height="8em" />

    <nav class="species-nav">
      <NavLink
        :to="speciesPath(props.id - 1)"
        :disabled="props.id <= 1"
        :prefetch="() => prefetchSpecies(props.id - 1)"
      >
        previous
      </NavLink>
      <NavLink
        :to="speciesPath(props.id + 1)"
        :prefetch="() => prefetchSpecies(props.id + 1)"
      >
        next
      </NavLink>
    </nav>
  </Panel>
</template>

<style scoped>
.move-controls {
  display: flex;
  gap: 0.5rem;
}
.species-nav {
  display: flex;
  gap: 1rem;
  margin-top: 1rem;
  text-transform: uppercase;
}
</style>
