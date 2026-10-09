<script setup lang="ts">
/**
 * The layout row: the favourites bar above the two panels (the example's `Container`).
 * The React version discovers `Panel` children; Vue's slot API makes the arrangement explicit.
 */
</script>

<template>
  <div class="container">
    <slot />
  </div>
</template>

<style scoped>
.container {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 1rem;
}
</style>
