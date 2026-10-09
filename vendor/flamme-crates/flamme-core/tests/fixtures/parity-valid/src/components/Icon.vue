<script setup lang="ts">
/**
 * The star button (the example's `Icon name="star"`). `filled` is the example's
 * `style={{ fill: 'goldenrod' }}` condition, stated as a prop because Vue has no `$`-style prop
 * pass-through for an SVG's presentation attributes.
 */
defineProps<{ readonly name: 'star'; readonly filled?: boolean }>();
</script>

<template>
  <svg
    v-if="name === 'star'"
    class="icon"
    viewBox="0 0 24 24"
    width="24"
    height="24"
    :fill="filled ? 'goldenrod' : 'none'"
    :stroke="filled ? 'goldenrod' : 'currentColor'"
    stroke-width="1.5"
    aria-hidden="true"
  >
    <path
      d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"
      stroke-linejoin="round"
    />
  </svg>
</template>

<style scoped>
.icon {
  display: block;
}
</style>
