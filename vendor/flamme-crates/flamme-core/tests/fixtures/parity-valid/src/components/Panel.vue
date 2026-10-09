<script setup lang="ts">
/** One of the two detail panels (the example's `Panel side="left" | "right"`). */
defineProps<{
  readonly side: 'left' | 'right';
  readonly id?: string;
}>();
</script>

<template>
  <section class="panel" :class="`panel-${side}`" :id="id">
    <slot />
  </section>
</template>

<style scoped>
.panel {
  flex: 1 1 12rem;
  min-width: 0;
  padding: 1rem;
  border: 1px solid rgb(0 0 0 / 10%);
  border-radius: 8px;
}
</style>
