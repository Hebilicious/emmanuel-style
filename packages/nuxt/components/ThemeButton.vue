<script lang="ts" setup>
import type { Theme } from "~/composables/useTheme"

const { theme } = defineProps<{ theme: [Theme, string] }>()
const { mode, selectTheme } = useTheme()

const name = computed(() => theme[0])
const themeClass = computed(() => theme[1])

const classes = computed(() => {
	const isActive = mode.value === name.value
	return { Selector: true, isActive, [themeClass.value]: true }
})
</script>

<template>
  <button
    :class="classes"
    aria-label="themeColorButton"
    @click="selectTheme(name)">
  </button>
</template>

<style lang="postcss" scoped>
button {
  --size: 2.5rem;

  outline: none;
  border: 2px solid var(--secondaryAccent);
  background: var(--primaryBackground);
  border-radius: 100%;
  width: var(--size);
  height: var(--size);
  transition: border-color 1s ease;
  &.isActive {
    border: 4px solid var(--activeBorder);
    filter: drop-shadow(0 0 4px var(--activeBorder));
  }
}
</style>
