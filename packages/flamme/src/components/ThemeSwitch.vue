<script setup lang="ts">
/**
 * The theme switch: one glyph, and the label carried by `aria-label` and `title`
 * so it costs no width in the bar.
 */
import { onMounted, onUnmounted, ref } from "vue"

const STORAGE_KEY = "vueuse-color-scheme"
const dark = ref(false)

const apply = (next: boolean) => {
	const el = document.documentElement
	el.classList.remove("LightTheme", "DarkTheme")
	el.classList.add(next ? "DarkTheme" : "LightTheme")
	try {
		localStorage.setItem(STORAGE_KEY, next ? "dark" : "light")
	} catch {
		// Storage can be unavailable; the class above is what matters.
	}
}

onMounted(() => {
	dark.value = document.documentElement.classList.contains("DarkTheme")
})

const toggle = () => {
	dark.value = !dark.value
	apply(dark.value)
}

onMounted(() => document.addEventListener("theme:toggle", toggle))
onUnmounted(() => document.removeEventListener("theme:toggle", toggle))
</script>

<template>
  <button
    type="button"
    class="Switch"
    :aria-label="dark ? 'Switch to the light theme' : 'Switch to the dark theme'"
    :title="dark ? 'Light theme (t)' : 'Dark theme (t)'"
    @click="toggle"
  >
    {{ dark ? "◑" : "◐" }}
  </button>
</template>

<style scoped>
.Switch {
  display: grid;
  place-items: center;
  width: 1.9rem;
  height: 1.5rem;
  padding: 0;
  background: none;
  border: var(--spacing-size-hairline) solid var(--rule);
  color: var(--muted);
  font: inherit;
  cursor: pointer;
}

.Switch:hover {
  color: var(--accent);
  border-color: var(--accent);
}
</style>
