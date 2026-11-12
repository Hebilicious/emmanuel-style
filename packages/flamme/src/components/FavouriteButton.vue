<script setup lang="ts">
/**
 * The favourite control for one article.
 *
 * The count lives in a Durable Object behind the worker, and the toggle is keyed
 * on the reader (`x-reader-id`), so pressing it twice takes the favourite back
 * rather than counting twice, and a replay from the local queue lands on the same
 * state. Whether this reader has favourited the article is remembered on the
 * device, because the worker only answers with the count.
 *
 * The write is local first: the count moves at once, the mutation is queued, and
 * the queue delivers it when the worker can be reached. With the network off the
 * control still works and the count is the last one the device saw.
 */
import { computed, onMounted, ref } from "vue"
import { useMutation, useQuery } from "@flamme/vue"
import { Favourite, ToggleFavourite } from "$flamme"

const props = defineProps<{ slug: string; compact?: boolean }>()

const storageKey = computed(() => `favourite:${props.slug}`)
const mine = ref(false)

onMounted(() => {
	try {
		mine.value = localStorage.getItem(storageKey.value) === "1"
	} catch {
		mine.value = false
	}
})

const { data } = useQuery(Favourite, () => ({ slug: props.slug }), {
	policy: "CacheAndNetwork"
})
const { mutate, pending } = useMutation(ToggleFavourite)

const count = computed(() => data.value?.favourites?.count ?? null)

const toggle = async () => {
	if (pending.value) return
	const next = !mine.value
	mine.value = next
	try {
		localStorage.setItem(storageKey.value, next ? "1" : "0")
	} catch {
		// Storage can be unavailable; the count still moves for this visit.
	}
	const base = count.value ?? 0
	await mutate({
		variables: { slug: props.slug },
		optimistic: {
			toggleFavourite: {
				slug: props.slug,
				count: Math.max(0, base + (next ? 1 : -1))
			}
		}
	})
}
</script>

<template>
  <button
    type="button"
    class="Favourite"
    :class="{ On: mine, Compact: compact }"
    :aria-pressed="mine"
    :title='mine ? "Take your favourite back" : "Favourite this article"'
    data-row
    :data-label='mine ? "favourited" : "favourite"'
    @click.stop="toggle">
    <span class="Mark" aria-hidden="true">{{ mine ? "★" : "☆" }}</span>
    <span class="Count">{{ count === null ? "–" : count }}</span>
    <span class="visually-hidden">favourites</span>
  </button>
</template>

<style scoped>
.Favourite {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  padding: 0.2em 0.6em;
  border: var(--spacing-size-hairline) solid var(--rule);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
  white-space: nowrap;
  transition:
    color 120ms linear,
    border-color 120ms linear,
    background-color 120ms linear;
}

.Mark {
  font-size: 1.1em;
  line-height: 1;
}

.On {
  border-color: var(--accent);
  color: var(--accent);
}

.On .Mark {
  animation: favourite-pop 320ms cubic-bezier(0.3, 1.6, 0.5, 1);
}

:global(.mouse-enabled) .Favourite:hover {
  border-color: var(--accent);
  color: var(--accent);
}

@keyframes favourite-pop {
  0% {
    transform: scale(0.6);
  }
  100% {
    transform: scale(1);
  }
}
</style>
