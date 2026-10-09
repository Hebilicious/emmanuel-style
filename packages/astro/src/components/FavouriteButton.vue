<script setup lang="ts">
/**
 * Favourite control for one article.
 *
 * The count comes from the backend worker. Locally we remember whether this
 * browser already favourited the article, so a second click does not inflate
 * the number. When the worker cannot be reached the control stays usable and
 * simply reports no total, which keeps the page honest offline.
 */
import { onMounted, ref } from "vue"
import { addFavourite, getFavourites } from "../utils/api"

const { slug } = defineProps<{ slug: string }>()

const count = ref<number | null>(null)
const favourited = ref(false)
const busy = ref(false)

const storageKey = `favourite:${slug}`

onMounted(async () => {
	favourited.value = localStorage.getItem(storageKey) === "1"

	const result = await getFavourites(slug)
	if (result) count.value = result.count
})

const toggle = async () => {
	if (busy.value || favourited.value) return
	busy.value = true

	const result = await addFavourite(slug)
	if (result) {
		count.value = result.count
		favourited.value = true
		localStorage.setItem(storageKey, "1")
	}

	busy.value = false
}
</script>

<template>
  <button
    type="button"
    class="Favourite"
    :class="{ On: favourited }"
    :disabled="favourited || busy"
    :aria-pressed="favourited"
    :title='favourited ? "Already favourited" : "Add a favourite"'
    @click="toggle">
    <span class="Mark" aria-hidden="true">{{
      favourited ? "★" : "☆"
    }}</span>
    <span class="Count">{{ count === null ? "–" : count }}</span>
    <span class="visually-hidden">favourites</span>
  </button>
</template>

<style scoped>
.Favourite {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  margin-top: var(--spacing_fluid-tight-space-tight-l);
  padding: var(--spacing_fluid-tight-space-tight-xs)
    var(--spacing_fluid-tight-space-tight-s);
  border: var(--spacing-size-hairline) solid var(--rule);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
  transition: color 120ms linear, border-color 120ms linear;
}

.Favourite:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}

.On {
  color: var(--accent);
  border-color: var(--accent);
}

.Favourite:disabled {
  cursor: default;
}
</style>
