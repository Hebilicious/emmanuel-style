<script lang="ts" setup>
import { computed } from "vue"
import type { Theme } from "../utils/useTheme"
import { themesList, useTheme } from "../utils/useTheme"

const { mode } = useTheme()

const classes = computed(() => {
	return {
		SideName: true,
		PaperSideName: themesList.get(mode.value as Theme) === "PaperTheme"
	}
})
</script>

<template>
  <div :class="classes">
    <h1>
      <span>E</span>
      <span>m</span>
      <span>m</span>
      <span>a</span>
      <span>n</span>
      <span>u</span>
      <span>e</span>
      <span>l</span>
    </h1>
  </div>
</template>

<style scoped lang="postcss">
.SideName {
  display: grid;
  place-items: center;
  position: relative;
  overflow: hidden;
  transition: color 0.5s ease-in-out;

  h1 {
    font-size: var(--typography_fluid-content-2xl);
    position: absolute;
    transform: rotate(180deg);
    writing-mode: vertical-rl;
    font-family:
      var(--font-aclonica),
      Aclonica,
      sans-serif;
    text-transform: uppercase;
    color: var(--giantText);

    span {
      transition: color 0.5s ease-in-out;
    }
  }

  &.PaperSideName {
    span {
      color: black;

      &:nth-child(1) {
        color: var(--palette-basic-ultraMarine);
      }
      &:nth-child(2) {
        color: var(--palette-basic-lightBlue);
      }
      &:nth-child(3) {
        color: var(--palette-basic-lightGreen);
      }
      &:nth-child(4) {
        color: var(--palette-basic-darkBeige);
      }
      &:nth-child(5) {
        color: var(--palette-basic-golden);
      }
      &:nth-child(6) {
        color: var(--palette-basic-lightPink);
      }
      &:nth-child(7) {
        color: var(--palette-basic-vividPink);
      }
      &:nth-child(8) {
        color: var(--palette-basic-green);
      }
    }
  }
}
</style>
