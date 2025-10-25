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
		quote: "In the midst of chaos, there is also opportunity",
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

onMounted(() => {
	interval = setInterval(() => {
		index.value = (index.value + 1) % quotes.length
	}, 7500)
})

onUnmounted(() => {
	clearInterval(interval)
})
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
