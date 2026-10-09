<script setup lang="ts">
/**
 * The loading placeholder (`Shimmer` in the example). Every pending read renders one of these
 * instead of disappearing, so the layout does not jump (PoC behaviour 6).
 */
const props = withDefaults(
  defineProps<{
    readonly width?: string;
    readonly height?: string;
    readonly radius?: string;
    readonly background?: string;
  }>(),
  {
    width: '100%',
    height: '1em',
    radius: '4px',
    background: 'currentColor',
  },
);

const style = {
  width: props.width,
  height: props.height,
  borderRadius: props.radius,
  background: props.background,
};
</script>

<template>
  <div class="shimmer" data-testid="shimmer" :style="style"></div>
</template>

<style scoped>
.shimmer {
  display: inline-block;
  opacity: 0.25;
  animation: shimmer-pulse 1.2s ease-in-out infinite;
}

@keyframes shimmer-pulse {
  0%,
  100% {
    opacity: 0.15;
  }
  50% {
    opacity: 0.35;
  }
}
</style>
