<script setup lang="ts">
/**
 * The single error surface (spec §12.3). It renders the fixture's `errors[].message` verbatim, so
 * `No Pokémon found with id 152` needs no client-side special case.
 */
import type { GraphQLResponseError } from '@flamme/runtime';

import Display from './Display.vue';
import Panel from './Panel.vue';

defineProps<{
  readonly errors: readonly GraphQLResponseError[] | null;
  readonly retry?: () => void;
}>();
</script>

<template>
  <Panel side="left" id="error" data-testid="error-panel">
    <Display message="Something went wrong." />
    <ul class="error-list">
      <li v-for="(error, index) in errors ?? []" :key="index">{{ error.message }}</li>
    </ul>
    <button v-if="retry" type="button" data-testid="error-retry" @click="retry()">Retry</button>
  </Panel>
</template>

<style scoped>
.error-list {
  padding-left: 1.25rem;
}
</style>
