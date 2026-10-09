<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from "vue"

const quotes = [
	{
		quote: "Let no one ignorant of geometry enter here.",
		author: "Plato"
	},
	{
		quote: "People dreams never end.",
		author: "Blackbeard"
	},
	{
		quote:
			"And you will know my name is the lord, when I lay my vengeance upon thee.",
		author: "Jules Winnfield"
	},
	{
		quote: "Simplicity is the ultimate sophistication.",
		author: "Leonardo DaVinci"
	},
	{
		quote:
			"One Ring to rule them all, One Ring to find them, One Ring to bring them all and in the darkness bind them.",
		author: "J.R.R. Tolkien"
	},
	{
		quote: "Freedom is a pure idea.",
		author: "Karis Nemik"
	},
	{
		quote: "For those who come after.",
		author: "Gustave"
	},
	{
		quote: "Je pense, donc je suis.",
		author: "René Descartes"
	},
	{
		quote: "These violent delights have violent ends.",
		author: "William Shakespeare"
	},
	{
		quote: "Anything that man can imagine is a possibility in reality.",
		author: "Willy Karen"
	},
	{
		quote: "In medio stat virtus.",
		author: "Loth d'Orcanie"
	},
	{
		quote: "In the midst of chaos, there is also opportunity.",
		author: "Sun Tzu"
	},
	{
		quote:
			"The divine gift does not come from a higher power, but from our own minds.",
		author: "Robert Ford"
	},
	{
		quote: "Rien ne se perd, rien ne se crée, tout se transforme.",
		author: "Antoine Lavoisier"
	}
]
const index = ref(0)
const currentQuote = computed(() => quotes[index.value])

let interval: ReturnType<typeof setInterval>

const INTERVAL = 7500

/**
 * Advance the quote.
 *
 * Exposed so a page turn can drive it: `n` and `p` on the homepage mean "next
 * quote" and "previous quote", and a manual change restarts the timer so the
 * automatic rotation does not immediately jump again.
 */
const next = () => {
	index.value = (index.value + 1) % quotes.length
	restart()
}

const previous = () => {
	index.value = (index.value - 1 + quotes.length) % quotes.length
	restart()
}

const restart = () => {
	clearInterval(interval)
	interval = setInterval(() => {
		index.value = (index.value + 1) % quotes.length
	}, INTERVAL)
}

const onStep = (event: Event) => {
	const delta = (event as CustomEvent<number>).detail
	if (delta > 0) next()
	else previous()
}

onMounted(() => {
	restart()
	// The paginator owns N and P; on a page with nothing to turn they step the
	// quote instead, and each step restarts the rotation timer.
	document.addEventListener("quote:step", onStep)
	onUnmounted(() => document.removeEventListener("quote:step", onStep))
})

onUnmounted(() => clearInterval(interval))
</script>
<template>
  <div class="SubText" :key="currentQuote.quote">
    {{ currentQuote.quote }}
    <br />
    - {{ currentQuote.author }}
  </div>
</template>
<style scoped>
@keyframes fadeIn {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}

.SubText {
  animation: fadeIn 2s;
}
</style>
