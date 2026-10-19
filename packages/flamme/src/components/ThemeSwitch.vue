<script setup lang="ts">
/**
 * The theme switch: one glyph, with the label carried by `aria-label` and `title`
 * so it costs no width in the bar. `t` does the same from the keyboard.
 */
import { useShell, toggleTheme } from "../shell/shell.js"

const shell = useShell()
</script>

<template>
  <button
    type="button"
    class="Switch"
    :aria-label='shell.theme === "dark"
    ? "Switch to the light theme"
    : "Switch to the dark theme"'
    :title='shell.theme === "dark" ? "Light theme (t)" : "Dark theme (t)"'
    aria-keyshortcuts="t"
    @click="toggleTheme(shell)">
    <!-- A half-inked disc: the dark half faces the theme it switches to. -->
    <svg
      class="Glyph"
      viewBox="0 0 16 16"
      aria-hidden="true"
      :class='{ Flip: shell.theme === "light" }'>
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5">
      </circle>
      <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"></path>
    </svg>
  </button>
</template>

<style scoped>
.Switch {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 1.6rem;
  padding: 0;
  border: var(--spacing-size-hairline) solid var(--rule);
  color: var(--muted);
  font: inherit;
  line-height: 1;
  transition: color 120ms linear, border-color 120ms linear;
}

.Glyph {
  width: 0.95rem;
  height: 0.95rem;
  transition: transform 240ms ease;
}

.Glyph.Flip {
  transform: rotate(180deg);
}

:global(.mouse-enabled) .Switch:hover,
.Switch:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
