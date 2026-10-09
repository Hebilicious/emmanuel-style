<script setup lang="ts">
/**
 * The front sprite, declared next to the component that reads it (`Sprite.tsx` in the example).
 * The fragment is colocated through `graphql()`; the parent passes its own masked object, so this
 * component can only see `name` and `sprites.front` (REQ-2.3).
 *
 * `useFragment` returns the fragment's `$data`, whose leaves are `LoadingType | T` (a fragment read
 * can mix a loaded field with a pending one, §9.2). `isPending` is the predicate that narrows a leaf
 * to its loaded branch, so the computed below is where the narrowing happens once (§8.7).
 */
import { isPending, useFragment } from '@flamme/vue';
import { graphql } from '$flamme';
import type { SpriteInfo$key } from '$flamme';
import { computed } from 'vue';

import Shimmer from './Shimmer.vue';

const props = defineProps<{
  readonly species: SpriteInfo$key | null;
  readonly id?: string;
  readonly className?: string;
}>();

const document = graphql(`
	fragment SpriteInfo on Species @loading {
		name
		sprites {
			front
		}
	}
`);

const { data, pending } = useFragment(() => props.species, document);

/** The loaded leaves, or `null` while the read is a placeholder. */
const info = computed(() => {
  const value = data.value;
  if (value === null || pending.value) {
    return null;
  }
  const name = value.name;
  const front = value.sprites.front;
  if (isPending(name) || isPending(front)) {
    return null;
  }
  return { name, front };
});
</script>

<template>
  <div :id="props.id" class="sprite" :class="props.className">
    <Shimmer v-if="!info" width="90%" height="90%" radius="5px" background="transparent" />
    <img v-else class="sprite-image" :src="info.front" :alt="`${info.name} sprite`" />
  </div>
</template>

<style scoped>
.sprite {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 6rem;
}
.sprite-image {
  max-width: 100%;
  image-rendering: pixelated;
}
</style>
