<script setup lang="ts">
import { useTheme } from "../utils/useTheme"

const { mode, selectTheme } = useTheme()
</script>

<template>
  <button
    type="button"
    class="Switch"
    :title='`Switch to ${mode === "dark" ? "light" : "dark"} theme`'
    :aria-label='`Switch to ${mode === "dark" ? "light" : "dark"} theme`'
    @click='selectTheme(mode === "dark" ? "light" : "dark")'>
    <span class="Glyph" aria-hidden="true">{{
      mode === "dark" ? "◐" : "◑"
    }}</span>
  </button>
</template>

<style scoped>
/* One compact control instead of two word-buttons. */
.Switch {
  display: inline-flex;
  align-items: center;
  padding: 0 var(--spacing_fluid-tight-space-tight-xs);
  border: var(--spacing-size-hairline) solid var(--rule);
  color: var(--muted);
  text-transform: lowercase;
  letter-spacing: 0.06em;
  transition: color 120ms linear, border-color 120ms linear;
}

.Switch:hover {
  color: var(--ink);
  border-color: var(--rule-strong);
}

.Glyph {
  color: var(--accent);
}
</style>
