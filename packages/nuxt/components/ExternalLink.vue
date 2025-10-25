<script lang="ts" setup>
const { url, label } = defineProps<{ url: string; label: string }>()
</script>
<template>
  <a
    target="_blank"
    :href="`https://${url}`"
    :aria-label="label"
    rel="noopener noreferrer">
    <slot></slot>
  </a>
</template>

<style lang="postcss" scoped>
a {
  &:hover {
    transform: scale(1.2);
    transition: all 0.1s ease-out;
  }
}
</style>
