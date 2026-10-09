<script setup lang="ts">
/**
 * One row's card: the fragment atom and the mutation atom, and nothing else.
 *
 * The card is handed the row's **id**, not the row: `app.cardOf(id)` reads the fragment through the
 * `$key` the list's masked value carries, so this component cannot see `name` (the list's own field)
 * even though both read the same cache record. That is masking, and it survives the atom API.
 *
 * The atom is built once, in `setup`. `useAtomValue` re-runs its factory on every render, and
 * `app.cardOf(id)` is a family, so the atom it returns is the same one each time.
 */
import { AsyncResult, useAtom, useAtomValue } from '@effect/atom-vue';
import * as Option from 'effect/Option';
import { computed } from 'vue';

import { useApp } from '../app.js';

const props = defineProps<{ id: number }>();
const app = useApp();
const value = useAtomValue(() => app.cardOf(props.id));
const [outcome, toggle] = useAtom(() => app.toggle, { mode: 'promise' });

const favorite = computed(() => Option.getOrNull(AsyncResult.value(value.value))?.favorite ?? null);
const label = computed(() => (favorite.value === true ? '★ favourite' : '☆ favourite'));
// `AsyncResult.match` hands each handler its *variant*, so the outcome is `result.value`
const saved = computed(() =>
  AsyncResult.match(outcome.value, {
    onInitial: () => '',
    onFailure: () => 'failed',
    onSuccess: (result) => (result.value.status === 'queued' ? 'saved offline' : 'saved'),
  }),
);
const pending = computed(() => AsyncResult.isWaiting(outcome.value));

/** One optimistic write: the cache shows it immediately, the queue decides when it lands. */
function onToggle(): void {
  void toggle({
    variables: { id: props.id },
    optimistic: {
      toggleFavorite: {
        __typename: 'Species',
        id: props.id,
        favorite: favorite.value !== true,
      },
    },
  }).catch(() => undefined);
}
</script>

<template>
  <span class="card" :data-testid="`card-${id}`">
    <button type="button" :data-testid="`toggle-${id}`" :disabled="pending" @click="onToggle">
      {{ label }}
    </button>
    <em v-if="saved !== ''" :data-testid="`saved-${id}`">{{ saved }}</em>
  </span>
</template>
