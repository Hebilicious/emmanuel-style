<script setup lang="ts">
/**
 * The app shell: the list, and the sync banner.
 *
 * `useAtomValue` takes a *stable* factory: the atoms are built once here (the row atoms come from
 * `app.cardOf`'s family), because the factory is re-run on every render and a factory that built a
 * new atom would hand the component a different atom each time.
 */
import { AsyncResult, useAtomValue } from '@effect/atom-vue';
import * as Option from 'effect/Option';
import { computed } from 'vue';

import { useApp } from './app.js';
import SpeciesCard from './components/SpeciesCard.vue';

const app = useApp();
const list = useAtomValue(() => app.list);
const queue = useAtomValue(() => app.queue);

/** The rows, or an empty list while the query loads. */
const rows = computed(() => Option.getOrNull(AsyncResult.value(list.value))?.species ?? []);
const failure = computed(() => Option.getOrNull(AsyncResult.error(list.value)));
</script>

<template>
  <main>
    <h1>Flamme + Effect v4</h1>
    <p class="banner" data-testid="queue">
      <span v-if="queue.error">sync failed: {{ queue.error.message }}</span>
      <span v-else-if="queue.pending > 0">{{ queue.pending }} write(s) waiting for the server</span>
      <span v-else-if="!queue.online">offline, nothing queued</span>
      <span v-else>in sync</span>
    </p>
    <p v-if="rows.length === 0 && AsyncResult.isWaiting(list)" data-testid="loading">loading…</p>
    <p v-else-if="failure" data-testid="error">{{ failure.message }}</p>
    <ul>
      <li v-for="row in rows" :key="row.id">
        <span data-testid="name">{{ row.name }}</span>
        <SpeciesCard :id="row.id" />
      </li>
    </ul>
  </main>
</template>
