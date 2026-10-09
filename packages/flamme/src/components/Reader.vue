<script setup lang="ts">
/**
 * The reader: an article's blocks as a spread of screens.
 *
 * The flow is the whole article laid out once at the column width, which is what
 * the block heights are read from. The spread then shows the pages the paginator
 * produced, two at a time on a wide screen and one on a phone, and `n` / `p` turn a
 * whole spread.
 *
 * The turn is a View Transition with a sheet animation: the outgoing spread rotates
 * about its inner edge while the next settles up behind it. The pane is named for
 * the transition and the keyframes live in `shell.css`.
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"
import type { BlockShape, NoteShape } from "../content.js"
import { paginate, type Page } from "../utils/paginate.js"
import PageColumn from "./PageColumn.vue"

const props = defineProps<{
	blocks: readonly BlockShape[]
	notes: readonly NoteShape[]
}>()

/** The flow, rendered off screen to measure against. */
const flow = ref<HTMLElement | null>(null)
const pane = ref<HTMLElement | null>(null)

/** The measured height of each block, keyed by id. */
const heights = ref<ReadonlyMap<string, number>>(new Map())
const height = ref(0)
const columns = ref(2)
const spread = ref(0)

/** The blocks that open a page: a top-level heading, or one marked wide. */
const pageable = computed(() =>
	props.blocks.map((block) => ({
		...block,
		opens: block.kind === "heading" && block.depth <= 2,
		wide: block.kind === "figure" || (block.kind === "heading" && block.depth === 0)
	}))
)

const pages = computed<Page<BlockShape>[]>(() =>
	paginate(pageable.value, {
		height: height.value,
		columns: columns.value,
		heights: heights.value,
		gap: 0
	})
)

const total = computed(() => Math.max(1, Math.ceil(pages.value.length / columns.value)))

const visible = computed(() => {
	const start = spread.value * columns.value
	return pages.value.slice(start, start + columns.value)
})

/** Read the geometry: how much height a page has, and how wide a column is. */
const measure = () => {
	const el = pane.value
	if (!el) return
	const style = getComputedStyle(el)
	const pad = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
	height.value = Math.max(160, el.clientHeight - pad)
	columns.value = window.matchMedia("(min-width: 60rem)").matches ? 2 : 1
	el.style.setProperty("--column-width", `${columnWidth(el)}px`)
}

const columnWidth = (el: HTMLElement) => {
	const gutter = Number.parseFloat(
		getComputedStyle(document.documentElement).getPropertyValue(
			"--spacing_fluid-column-space-column-s"
		) || "0"
	)
	const gap = Number.isFinite(gutter) ? gutter : 24
	return Math.max(240, (el.clientWidth - gap * (columns.value - 1)) / columns.value)
}

/**
 * Measure every block once.
 *
 * This runs against the flow, which holds the whole article at the column width, so
 * a block's height is the height it will have on a page. Measuring the spread
 * instead would only see the pages currently shown.
 */
const measureBlocks = async () => {
	await nextTick()
	const el = flow.value
	if (!el) return
	const next = new Map<string, number>()
	for (const child of Array.from(el.children)) {
		const block = child as HTMLElement
		const id = block.dataset["blockId"]
		if (id) next.set(id, block.getBoundingClientRect().height)
	}
	heights.value = next
}

const turn = (delta: number) => {
	const target = Math.max(0, Math.min(spread.value + delta, total.value - 1))
	if (target === spread.value) return

	const commit = () => {
		spread.value = target
	}

	const doc = document as Document & { startViewTransition?: (cb: () => void) => void }
	if (typeof doc.startViewTransition === "function") doc.startViewTransition(commit)
	else commit()
}

const onKey = (event: KeyboardEvent) => {
	const target = event.target as HTMLElement | null
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target?.isContentEditable
	)
		return
	if (event.metaKey || event.ctrlKey || event.altKey) return

	if (event.key === "n" || event.key === "PageDown") {
		event.preventDefault()
		turn(1)
		return
	}
	if (event.key === "p" || event.key === "PageUp") {
		event.preventDefault()
		turn(-1)
	}
}

const onResize = () => {
	measure()
	void measureBlocks()
}

onMounted(async () => {
	measure()
	await measureBlocks()
	document.addEventListener("keydown", onKey)
	window.addEventListener("resize", onResize)
})

onUnmounted(() => {
	document.removeEventListener("keydown", onKey)
	window.removeEventListener("resize", onResize)
})

// A new article resets the reader and re-measures.
watch(
	() => props.blocks,
	async () => {
		spread.value = 0
		measure()
		await measureBlocks()
	}
)
</script>

<template>
  <div ref="pane" class="Reader" data-page-count="true">
    <!--
      The measuring flow. It holds the whole article at the column width so every
      block's height is read in the layout it will be shown in, and it is taken out
      of the visual flow: it costs a paint, not a screen.
    -->
    <div ref="flow" class="Flow" aria-hidden="true">
      <div
        v-for="block in pageable"
        :key="block.id"
        :data-block-id="block.id"
        class="Block"
        :class="`is-${block.kind}`"
        v-html="block.html"
      />
    </div>

    <div class="Spread">
      <PageColumn
        v-for="(page, index) in visible"
        :key="`${spread}-${index}`"
        :blocks="page.blocks"
        :notes="notes"
      />
    </div>
  </div>
</template>

<style scoped>
.Reader {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
  overflow: hidden;
  view-transition-name: reading-pane;
  perspective: 2400px;
}

/*
 * The measuring flow is in the layout, because a height cannot be measured from
 * something that is not laid out, but it is not painted and takes no space a reader
 * can reach.
 */
.Flow {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  visibility: hidden;
  pointer-events: none;
  width: var(--column-width, 100%);
}

.Spread {
  display: flex;
  gap: var(--spacing_fluid-column-space-column-s);
  /*
   * Stretched, not start-aligned: a column has to be the height of the page for the
   * notes to be pushed to its foot. Sized to their content, the notes followed the
   * last paragraph instead of sitting under the text as footnotes.
   */
  align-items: stretch;
  height: 100%;
  min-height: 0;
}
</style>

<style>
/*
 * Page turns.
 *
 * The outgoing spread rotates about its inner edge like a sheet being turned, and
 * the incoming one settles up from behind it. Opacity holds near full until the
 * sheet is most of the way over, because fading the whole time hides the rotation
 * and the turn then reads as a plain cross-fade.
 */
::view-transition-old(reading-pane) {
  transform-origin: left center;
  backface-visibility: hidden;
  animation: sheet-turn 420ms cubic-bezier(0.55, 0.06, 0.68, 0.19) both;
}

::view-transition-new(reading-pane) {
  transform-origin: left center;
  backface-visibility: hidden;
  animation: sheet-settle 420ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
}

@keyframes sheet-turn {
  0% {
    opacity: 1;
    transform: rotateY(0deg) scale(1);
    filter: brightness(1);
  }
  70% {
    opacity: 1;
    filter: brightness(0.72);
  }
  100% {
    opacity: 0;
    transform: rotateY(-92deg) scale(0.96);
    filter: brightness(0.4);
  }
}

@keyframes sheet-settle {
  0% {
    opacity: 0;
    transform: rotateY(24deg) translateX(4%) scale(0.98);
    filter: brightness(0.6);
  }
  40% {
    opacity: 1;
  }
  100% {
    opacity: 1;
    transform: rotateY(0deg) translateX(0) scale(1);
    filter: brightness(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  ::view-transition-old(reading-pane),
  ::view-transition-new(reading-pane) {
    animation: none;
  }
}
</style>
