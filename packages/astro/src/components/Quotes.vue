<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref } from "vue"

const quotes = [
	{
		quote: "The noblest pleasure is the joy of understanding.",
		author: "DaVinci"
	},
	{
		quote: "The only way to do great work is to love what you do.",
		author: "Steve Jobs"
	},
	{
		quote: "People dreams never end.",
		author: "Blackbeard"
	},
	{
		quote:
			"And you will know my name is the lord, when I lay my vengeance upon thee.",
		author: "Samuel L. Jackson"
	}
]
const index = ref(0)
const currentQuote = computed(() => quotes[index.value])

let interval: ReturnType<typeof setInterval>

onMounted(() => {
	interval = setInterval(() => {
		index.value = (index.value + 1) % quotes.length
	}, 5000)
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
