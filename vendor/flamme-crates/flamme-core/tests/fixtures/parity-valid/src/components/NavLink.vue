<script setup lang="ts">
/**
 * The `<Link>` equivalent (spec §14.1 row 2). Vue ships no link primitive that both resolves params
 * into a URL and renders a disabled-but-visible control, so this is that primitive: a `RouterLink`
 * when enabled, and a non-navigating `span` with the same slot content when disabled.
 */
import { RouterLink, type RouteLocationRaw } from 'vue-router';

const props = withDefaults(
  defineProps<{
    readonly to: RouteLocationRaw;
    readonly disabled?: boolean;
    /** Warms the destination on hover; `useSpeciesPrefetch` is what the app passes here. */
    readonly prefetch?: () => void;
  }>(),
  { disabled: false },
);
</script>

<template>
  <span v-if="props.disabled" class="nav-link disabled" aria-disabled="true" data-disabled="true">
    <slot />
  </span>
  <RouterLink v-else class="nav-link" :to="props.to" @mouseenter="props.prefetch?.()">
    <slot />
  </RouterLink>
</template>

<style scoped>
.nav-link {
  text-decoration: none;
}
.disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}
</style>
