<script setup lang="ts">
/**
 * The evolution-chain slot shown when the chain has fewer than three forms, or while the chain is
 * still pending. It keeps the row's height so the layout does not jump (PoC behaviour 3 and 6).
 */
import Shimmer from './Shimmer.vue';

withDefaults(defineProps<{ readonly number: number; readonly loading?: boolean }>(), {
  loading: false,
});
</script>

<template>
  <div class="preview-placeholder" data-testid="species-preview-placeholder">
    <span class="preview-number">{{ number }}</span>
    <Shimmer width="102px" height="102px" radius="5px" background="transparent" />
  </div>
</template>

<style scoped>
.preview-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.5rem;
}
</style>
