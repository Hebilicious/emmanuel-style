<script setup lang="ts">
/** The dex number as its own row (`SpeciesPreviewNumber` in the example). */
defineProps<{ readonly value: number | string }>();
</script>

<template>
  <span class="dex-number" data-testid="dex-number">{{ value }}</span>
</template>

<style scoped>
.dex-number {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
</style>
