<script setup lang="ts">
/**
 * The figure viewer.
 *
 * A plate is set small enough to share a column with text, so a painting can be
 * too small to look at. Enter on a figure, or a tap, opens it across the whole
 * screen, contained rather than cropped; Esc, Enter or a click closes it.
 */
import { computed } from "vue"
import { useShell } from "../shell/shell.js"

const shell = useShell()
const figure = computed(() =>
	shell.dialog?.kind === "zoom" ? shell.dialog : null
)
</script>

<template>
  <div
    v-if="figure"
    class="Zoom"
    role="dialog"
    aria-modal="true"
    :aria-label='figure.caption || "Figure"'
    @click="shell.dialog = null">
    <img class="Shot" :src="figure.src" :alt="figure.caption" />
    <p v-if="figure.caption" class="Caption">
      <span class="Label">fig.</span>
      {{ figure.caption }}
    </p>
    <p class="Close" aria-hidden="true"><span class="Key">esc</span> close</p>
  </div>
</template>

<style scoped>
.Zoom {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto auto;
  place-items: center;
  gap: var(--spacing_fluid-tight-space-tight-m);
  padding: var(--spacing_fluid-flow-space-s)
    var(--spacing_fluid-gutter-space-gutter-s);
  background: color-mix(in oklab, black 92%, transparent);
  animation: zoom-in 220ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
}

.Shot {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  box-shadow: 0 1.5rem 4rem rgb(0 0 0 / 60%);
}

.Caption {
  max-width: 80ch;
  color: oklch(88% 0.01 90);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  text-align: center;
  text-wrap: balance;
}

.Label {
  color: var(--palette-aqua-300);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.Close {
  color: oklch(70% 0.01 90);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Key {
  padding: 0 0.35em;
  border: var(--spacing-size-hairline) solid oklch(50% 0.01 90);
}

@keyframes zoom-in {
  from {
    opacity: 0;
    transform: scale(0.985);
  }
}
</style>
