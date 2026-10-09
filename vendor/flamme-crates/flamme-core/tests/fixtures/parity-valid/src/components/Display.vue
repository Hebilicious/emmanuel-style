<script setup lang="ts">
/**
 * A text row. The example's `Display` renders `message`; the evolution previews also pass a child
 * (the species name), so both a `message` prop and the default slot are supported.
 */
defineProps<{ readonly message?: string }>();
</script>

<template>
  <p class="display">
    <slot>{{ message }}</slot>
  </p>
</template>

<style scoped>
.display {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}
</style>
