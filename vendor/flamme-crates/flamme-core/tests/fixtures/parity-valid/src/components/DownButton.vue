<script setup lang="ts">
/** The down arrow of the move browser. */
defineProps<{ readonly disabled?: boolean }>();
defineEmits<{ readonly click: [] }>();
</script>

<template>
  <button
    type="button"
    class="page-button"
    data-testid="move-next"
    aria-label="next move"
    :disabled="disabled"
    @click="$emit('click')"
  >
    ↓
  </button>
</template>

<style scoped>
.page-button {
  padding: 0.25rem 0.75rem;
  cursor: pointer;
}
.page-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
