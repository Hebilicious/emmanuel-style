<script setup lang="ts" generic="T extends PagerItem">
/**
 * The pager: a list of blocks as a series of screens.
 *
 * Every route that has more to show than one screen holds goes through this. The
 * blocks are rendered once, off screen, at the width each will be shown at, and
 * measured: their heights, the gaps between their lines where they may be cut,
 * and the lines their footnote citations sit on. `utils/paginate.ts` turns those
 * numbers into pages, and pages into screens: two columns side by side on a wide
 * screen, one on a phone. Only the current screen is rendered for real.
 *
 * A block split across two pages is rendered on both, each copy clipped to the
 * lines that belong to that page. The clip falls in the leading between two lines,
 * so no line is ever cut, and a column is filled to its foot.
 *
 * `n` and `p` turn a screen. The turn is a View Transition with a sheet animation:
 * the outgoing screen rotates about its edge while the next settles behind it.
 * The pane is the one element named for the transition (`reading-pane`); naming
 * a second element the same aborts the transition.
 */
import {
	computed,
	nextTick,
	onBeforeUnmount,
	onMounted,
	ref,
	shallowRef,
	useSlots,
	watch
} from "vue"
import { useShell } from "../shell/shell.js"
import {
	cutsFrom,
	isWhole,
	type Measured,
	type Page,
	paginate,
	type Screen,
	screens,
	type Slice
} from "../utils/paginate.js"
import type { PagerItem, PagerNote } from "./pager.js"

const props = withDefaults(
	defineProps<{
		items: readonly T[]
		notes?: readonly PagerNote[]
		/** The fewest lines either part of a split block keeps. */
		minLines?: number
		/** Name of the pane for assistive technology. */
		label?: string
		/** Whether an `opens` block starts a new screen rather than a new column. */
		opensScreen?: boolean
		/** Whether this pager answers `n` and `p` itself. */
		turns?: boolean
	}>(),
	{
		notes: () => [],
		minLines: 2,
		label: "Pages",
		opensScreen: false,
		turns: true
	}
)

const emit = defineEmits<{ (event: "layout", total: number): void }>()

defineSlots<{
	item(props: { item: T }): unknown
	lead?(props: Record<string, never>): unknown
}>()

const slots = useSlots()
const shell = useShell()

const root = ref<HTMLElement | null>(null)
const measure = ref<HTMLElement | null>(null)
const columnsEl = ref<HTMLElement | null>(null)

/** The geometry of the pane, read from the DOM. */
const geometry = ref({
	width: 0,
	height: 0,
	columns: 2,
	gutter: 24,
	gap: 12,
	leadGap: 16
})
const columnWidth = computed(() => {
	const { width, columns, gutter } = geometry.value
	return Math.max(200, Math.floor((width - gutter * (columns - 1)) / columns))
})

/** The measured blocks, and the height of the lead. */
const measured = shallowRef<Measured[]>([])
const noteHeights = shallowRef<ReadonlyMap<string, number>>(new Map())
const notesChrome = ref(0)
const noteGap = ref(0)
const leadHeight = ref(0)
/**
 * Height the lead takes on screen beyond what it measured at, found after the
 * first screen renders. A lead can render taller than it measured (a count that
 * arrives, a tag that wraps), and the columns under it must not be packed for room
 * they do not have.
 */
const leadExtra = ref(0)
const ready = ref(false)

const byId = computed(() => new Map(props.items.map((item) => [item.id, item])))
const notesById = computed(
	() => new Map(props.notes.map((note) => [note.id, note]))
)

const pages = computed<Page[]>(() => {
	if (measured.value.length === 0) return []
	const { height, columns, leadGap } = geometry.value
	const lead =
		slots.lead === undefined ? 0 : leadHeight.value + leadGap + leadExtra.value
	return paginate(measured.value, {
		height: (page) => (page < columns ? height - lead : height),
		gap: geometry.value.gap,
		noteHeights: noteHeights.value,
		// The notes are a flex item of the column, so the block gap sits above them too.
		notesChrome: notesChrome.value + geometry.value.gap,
		noteGap: noteGap.value,
		minLines: props.minLines
	})
})

const opensAScreen = (page: Page) =>
	props.opensScreen &&
	byId.value.get(page.slices[0]?.id ?? "")?.opens === true &&
	(page.slices[0]?.from ?? 0) === 0

const spread = computed<Screen[]>(() =>
	screens(pages.value, geometry.value.columns, opensAScreen)
)
const total = computed(() => Math.max(1, spread.value.length))
const current = ref(0)
const screen = computed<Screen | null>(
	() => spread.value[current.value] ?? null
)

/* ------------------------------------------------------------------ measuring */

/** Boxes inside a block that must not be cut, in px from the block's top. */
const boxesOf = (element: HTMLElement): (readonly [number, number])[] => {
	const top = element.getBoundingClientRect().top
	const boxes: (readonly [number, number])[] = []
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
	const range = document.createRange()
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		if (!node.textContent || node.textContent.trim() === "") continue
		range.selectNodeContents(node)
		for (const rect of Array.from(range.getClientRects())) {
			if (rect.height > 0 && rect.width > 0)
				boxes.push([rect.top - top, rect.bottom - top])
		}
	}
	for (const atom of Array.from(
		element.querySelectorAll<HTMLElement>(
			"img, svg, video, canvas, iframe, hr, [data-atomic]"
		)
	)) {
		const rect = atom.getBoundingClientRect()
		boxes.push([rect.top - top, rect.bottom - top])
	}
	return boxes
}

const px = (value: string) => {
	const parsed = Number.parseFloat(value)
	return Number.isFinite(parsed) ? parsed : 0
}

/** Read the pane: its size, how many columns it holds, and the gaps. */
const readGeometry = () => {
	const element = root.value
	if (element === null) return
	const style = getComputedStyle(element)
	lastSize = `${element.clientWidth}x${element.clientHeight}`
	geometry.value = {
		width: element.clientWidth,
		height: element.clientHeight,
		columns: window.matchMedia("(min-width: 60rem)").matches ? 2 : 1,
		gutter: px(style.columnGap) || 24,
		gap: px(style.rowGap),
		/*
		 * Read from a computed length, not from `--lead-gap` itself: a custom property
		 * reads back as the `var(…)` it was written as, which parsed as nothing, and
		 * the 16px guess was 4px short of the real gap, so every column under a lead
		 * ran 4px past the pane.
		 */
		leadGap:
			measure.value === null
				? 16
				: px(getComputedStyle(measure.value).columnGap)
	}
}

let generation = 0
/** The pane size last measured, so a resize that changes nothing does not re-measure. */
let lastSize = ""

/**
 * Measure every block at the width it will be shown at.
 *
 * Fonts are awaited first: a block measured in the fallback face is shorter than
 * the same block in Monaspace, and a page packed to the shorter height overflows
 * once the real face arrives.
 */
const measureAll = async () => {
	const run = (generation += 1)
	readGeometry()
	await nextTick()
	await document.fonts.ready
	if (run !== generation) return
	const host = measure.value
	if (host === null) return

	const next: Measured[] = []
	for (const element of Array.from(
		host.querySelectorAll<HTMLElement>(":scope > [data-measure-id]")
	)) {
		const id = element.dataset["measureId"] ?? ""
		const item = byId.value.get(id)
		if (item === undefined) continue
		const height = element.getBoundingClientRect().height
		const top = element.getBoundingClientRect().top
		const refs = Array.from(
			element.querySelectorAll<HTMLElement>("[data-footnote-ref]")
		).map((ref) => ({
			id: ref.dataset["footnoteRef"] ?? "",
			at: ref.getBoundingClientRect().bottom - top
		}))
		next.push({
			id,
			height,
			// An atomic block still gets its cuts, for the day it is taller than a page.
			cuts: cutsFrom(boxesOf(element), height),
			refs,
			...(item.opens === true ? { opens: true } : {}),
			...(item.screen === true ? { screen: true } : {}),
			...(item.keep === true ? { keep: true } : {}),
			...(item.atomic === true ? { atomic: true } : {})
		})
	}

	const heights = new Map<string, number>()
	const list = host.querySelector<HTMLElement>("[data-measure-notes]")
	if (list !== null) {
		for (const note of Array.from(
			list.querySelectorAll<HTMLElement>("[data-note]")
		)) {
			heights.set(
				note.dataset["note"] ?? "",
				note.getBoundingClientRect().height
			)
		}
		const section = list.closest<HTMLElement>(".Notes")
		const style = section ? getComputedStyle(section) : null
		notesChrome.value = style
			? px(style.paddingTop) +
				px(style.paddingBottom) +
				px(style.borderTopWidth) +
				px(style.borderBottomWidth)
			: 0
		noteGap.value = px(getComputedStyle(list).rowGap)
	}

	const lead = host.querySelector<HTMLElement>("[data-measure-lead]")
	leadHeight.value = lead === null ? 0 : lead.getBoundingClientRect().height
	leadExtra.value = 0

	const anchor = anchorOf()
	noteHeights.value = heights
	measured.value = next
	ready.value = true
	restore(anchor)
}

/** The block and offset at the top of the current screen, to keep the place on a re-layout. */
const anchorOf = (): { id: string; from: number } | null => {
	// The first page of a screen can be empty (a lead with no room under it).
	const first = screen.value?.pages.flatMap((page) => page.slices)[0]
	return first === undefined ? null : { id: first.id, from: first.from }
}

const restore = (anchor: { id: string; from: number } | null) => {
	if (anchor === null) {
		current.value = Math.min(current.value, total.value - 1)
		return
	}
	const index = spread.value.findIndex((candidate) =>
		candidate.pages.some((page) =>
			page.slices.some(
				(slice) =>
					slice.id === anchor.id &&
					slice.from <= anchor.from + 1 &&
					slice.to > anchor.from
			)
		)
	)
	current.value =
		index === -1 ? Math.min(current.value, total.value - 1) : index
}

/* -------------------------------------------------------------------- turning */

type ViewTransitionDocument = Document & {
	startViewTransition?: (callback: () => Promise<void> | void) => {
		finished: Promise<void>
	}
}

const go = (target: number) => {
	const next = Math.max(0, Math.min(target, total.value - 1))
	if (next === current.value) return
	const forward = next > current.value
	const commit = async () => {
		current.value = next
		await nextTick()
	}
	const doc = document as ViewTransitionDocument
	const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
	if (typeof doc.startViewTransition !== "function" || reduced) {
		void commit()
		return
	}
	document.documentElement.dataset["turn"] = forward ? "forward" : "back"
	const transition = doc.startViewTransition(commit)
	void transition.finished.finally(() => {
		delete document.documentElement.dataset["turn"]
	})
}

const turner = { turn: (delta: number) => go(current.value + delta), go }

watch(
	[current, total, ready],
	() => {
		if (!ready.value) return
		shell.position = { current: current.value + 1, total: total.value }
		emit("layout", total.value)
	},
	{ immediate: true }
)

/*
 * The check after a screen with a lead renders: the room the columns really have
 * against the room they were packed for. Any shortfall is added to the lead and the
 * pages are packed again, so a column never runs past the pane. It only ever grows,
 * so it settles after one pass.
 */
watch([current, ready, measured], async () => {
	if (!ready.value || current.value !== 0 || slots.lead === undefined) return
	await nextTick()
	const element = columnsEl.value
	if (element === null) return
	const planned = Number.parseFloat(pageStyle(0).height)
	const shortfall = planned - element.clientHeight
	if (shortfall > 0.5 && leadExtra.value < 400)
		leadExtra.value += Math.ceil(shortfall)
})

/* --------------------------------------------------------------------- touch */

let touch: { x: number; y: number; id: number } | null = null

const onPointerDown = (event: PointerEvent) => {
	if (event.pointerType !== "touch") return
	touch = { x: event.clientX, y: event.clientY, id: event.pointerId }
}

/** A horizontal swipe turns the page, the way a phone reader does. */
const onPointerUp = (event: PointerEvent) => {
	if (touch === null || event.pointerId !== touch.id) return
	const dx = event.clientX - touch.x
	const dy = event.clientY - touch.y
	touch = null
	if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4) return
	turner.turn(dx < 0 ? 1 : -1)
}

/** With the mouse back, the wheel turns pages: there is nothing to scroll. */
let wheelAt = 0
let wheelSum = 0
const onWheel = (event: WheelEvent) => {
	if (!shell.mouse) return
	wheelSum +=
		Math.abs(event.deltaY) > Math.abs(event.deltaX)
			? event.deltaY
			: event.deltaX
	const now = Date.now()
	if (now - wheelAt < 650 || Math.abs(wheelSum) < 60) return
	wheelAt = now
	turner.turn(wheelSum > 0 ? 1 : -1)
	wheelSum = 0
}

/* ------------------------------------------------------------------ lifecycle */

let observer: ResizeObserver | null = null
let resizeTimer = 0

const onFonts = () => void measureAll()

onMounted(() => {
	if (props.turns) shell.turner = turner
	void measureAll()
	observer = new ResizeObserver(() => {
		const element = root.value
		if (element === null) return
		const size = `${element.clientWidth}x${element.clientHeight}`
		if (size === lastSize) return
		lastSize = size
		window.clearTimeout(resizeTimer)
		resizeTimer = window.setTimeout(() => void measureAll(), 120)
	})
	if (root.value) observer.observe(root.value)
	document.fonts.addEventListener("loadingdone", onFonts)
})

onBeforeUnmount(() => {
	observer?.disconnect()
	window.clearTimeout(resizeTimer)
	document.fonts.removeEventListener("loadingdone", onFonts)
	if (shell.turner === turner) shell.turner = null
	shell.position = null
})

watch(
	() => [props.items, props.notes],
	() => {
		current.value = 0
		void measureAll()
	}
)

defineExpose({ turn: turner.turn, go, total, current })

/* ------------------------------------------------------------------ rendering */

const sliceStyle = (slice: Slice) =>
	isWhole(slice) ? undefined : { height: `${slice.to - slice.from}px` }

/** A column is exactly the height its page was packed for, so its notes sit at the foot. */
const pageStyle = (index: number) => {
	const { height, columns, leadGap } = geometry.value
	const lead =
		current.value === 0 && slots.lead !== undefined && index < columns
			? leadHeight.value + leadGap + leadExtra.value
			: 0
	return { height: `${height - lead}px` }
}

const vars = computed(() => ({
	"--page-height": `${geometry.value.height}px`,
	// The share of a page a plate's picture may take, so its caption fits with it.
	"--plate-height": `${Math.round(geometry.value.height * 0.56)}px`,
	"--column-width": `${columnWidth.value}px`,
	"--spread-width": `${geometry.value.width}px`
}))
</script>

<template>
  <div
    ref="root"
    class="Pager"
    :style="vars"
    :data-columns="geometry.columns"
    role="region"
    :aria-label="label"
    aria-roledescription="paginated"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
    @pointercancel="touch = null"
    @wheel.passive="onWheel">
    <!--
      The measuring pass: every block at the width it will be shown at, laid out but
      never painted, inert so neither the keyboard nor assistive technology reaches it.
    -->
    <div ref="measure" class="Measure" data-measure aria-hidden="true" inert>
      <div
        v-if="$slots.lead"
        class="Lead"
        data-measure-lead
        :style="{ width: `${geometry.width}px` }">
        <slot name="lead"></slot>
      </div>
      <div
        v-for="item of items"
        :key="item.id"
        class="Block"
        :data-measure-id="item.id"
        :style="{
        	width: `${item.screen && geometry.columns > 1 ? geometry.width : columnWidth}px`
        }">
        <slot name="item" :item></slot>
      </div>
      <section
        v-if="notes.length > 0"
        class="Notes"
        :style="{ width: `${columnWidth}px` }">
        <ol data-measure-notes>
          <li v-for="note of notes" :key="note.id" :data-note="note.id">
            <span class="Number">{{ note.number }}</span>
            <span class="NoteBody"><span v-html="note.html"></span> <a
                class="Back"
                href="#"
                aria-label="Back to the text">↩</a></span>
          </li>
        </ol>
      </section>
    </div>

    <div
      v-if="ready && screen"
      class="Screen"
      :class="{ Wide: screen.wide }"
      :data-screen-index="current">
      <div v-if="current === 0 && $slots.lead" class="Lead">
        <slot name="lead"></slot>
      </div>
      <div ref="columnsEl" class="Columns">
        <div
          v-for="(page, index) of screen.pages"
          :key="`${current}-${index}`"
          class="Column"
          :class="{ Wide: page.screen && geometry.columns > 1 }"
          :style="pageStyle(index)">
          <template
            v-for="slice of page.slices"
            :key="`${slice.id}@${slice.from}`">
            <div
              v-if="byId.get(slice.id)"
              class="Slice"
              :class="{ Grow: isWhole(slice) && byId.get(slice.id)?.grow === true }"
              :data-clip="isWhole(slice) ? undefined : true"
              :style="sliceStyle(slice)">
              <div
                class="SliceBody"
                :style="slice.from > 0 ? { marginTop: `${-slice.from}px` } : undefined">
                <slot name="item" :item="byId.get(slice.id) as T"></slot>
              </div>
            </div>
          </template>

          <section
            v-if="page.notes.length > 0"
            class="Notes"
            aria-label="Notes">
            <ol>
              <li v-for="id of page.notes" :key="id" :data-note="id">
                <span class="Number">{{ notesById.get(id)?.number }}</span>
                <span class="NoteBody"><span
                    v-html="notesById.get(id)?.html"></span>
                  <a
                    class="Back"
                    :href="`#ref-${id}`"
                    :data-footnote-back-to="id"
                    aria-label="Back to the text">↩</a></span>
              </li>
            </ol>
          </section>
        </div>
        <div
          v-if="!screen.wide && screen.pages.length < geometry.columns"
          class="Column Blank"
          aria-hidden="true">
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.Pager {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  /* Read by the script: the gutter between columns and the gap between blocks. */
  column-gap: var(--spacing_fluid-column-space-column-s);
  row-gap: var(--block-gap, 0.85rem);
  --lead-gap: var(--spacing_fluid-tight-space-tight-l);
  view-transition-name: reading-pane;
  touch-action: pinch-zoom;
}

/*
 * Laid out, because a height cannot be measured from something that is not, but
 * never painted and out of the flow.
 *
 * `visibility: hidden` alone is not enough: a descendant that sets `visibility:
 * visible` (the front page's current quote does) is painted anyway, and its copy
 * showed through the page. `opacity: 0` hides the whole subtree whatever it says.
 */
.Measure {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  z-index: -1;
  /* Not a layout value: the script reads the lead gap back from here as a length. */
  column-gap: var(--lead-gap);
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
  contain: layout style;
}

.Measure > .Block,
.Measure > .Lead,
.Measure > .Notes {
  display: flow-root;
}

.Screen {
  display: flex;
  flex-direction: column;
  gap: var(--lead-gap);
  height: 100%;
  min-height: 0;
}

.Columns {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  gap: var(--spacing_fluid-column-space-column-s);
  min-height: 0;
}

/* The hairline between the two columns of a spread, set in the gutter as a newspaper sets it. */
.Columns > .Column + .Column::before {
  content: "";
  position: absolute;
  inset-block: 0;
  margin-inline-start: calc(var(--spacing_fluid-column-space-column-s) / -2);
  border-inline-start: var(--spacing-size-hairline) solid var(--rule);
}

.Column {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--block-gap, 0.85rem);
  width: var(--column-width);
  min-width: 0;
  flex: none;
}

.Column.Wide {
  width: 100%;
}

.Column.Blank::before {
  display: none;
}

.Slice {
  display: flow-root;
  flex: none;
}

.Slice[data-clip] {
  overflow: clip;
}

.SliceBody {
  display: flow-root;
}

.Slice.Grow {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
}

.Slice.Grow > .SliceBody {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
}

.Slice.Grow > .SliceBody > :deep(*) {
  flex: 1 1 auto;
}

/*
 * Notes belong to the page that cites them: pushed to the foot of the column by
 * the margin, behind a short rule, in the small face a printed page sets them in.
 */
.Notes {
  margin-top: auto;
  padding-top: var(--spacing_fluid-tight-space-tight-s);
  border-top: var(--spacing-size-hairline) solid var(--rule);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  line-height: 1.5;
}

.Notes ol {
  display: flex;
  flex-direction: column;
  row-gap: var(--spacing_fluid-tight-space-tight-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

/* The number in a column of its own, so a two-digit note lines up with a one-digit one. */
.Notes li {
  display: grid;
  grid-template-columns: 2.2em minmax(0, 1fr);
}

.Notes .Number {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.Notes .Number::after {
  content: ".";
}

.Notes :deep(p) {
  display: inline;
  margin: 0;
}

.Notes :deep(a) {
  color: var(--link);
  text-decoration: underline;
  text-decoration-thickness: var(--spacing-size-hairline);
  text-underline-offset: 0.2em;
}

.Notes .Back {
  margin-left: 0.4em;
  color: var(--faint);
  text-decoration: none;
}

.Notes li[data-flash="true"] {
  animation: note-flash 1.4s ease-out;
}

@keyframes note-flash {
  0%,
  30% {
    background: var(--accent-soft);
    color: var(--ink);
  }
  100% {
    background: transparent;
  }
}
</style>

<style>
/*
 * Page turns.
 *
 * Going forward, the outgoing screen rotates about its left edge like a sheet
 * being turned over, and the next settles up from behind it. Going back, the
 * sheet comes back over from the left. Opacity holds near full until the sheet
 * is most of the way over, because fading the whole time hides the rotation and
 * the turn reads as a plain cross-fade.
 */
::view-transition-group(reading-pane) {
  animation-duration: 440ms;
}

::view-transition-image-pair(reading-pane) {
  perspective: 2400px;
}

::view-transition-old(reading-pane) {
  transform-origin: left center;
  backface-visibility: hidden;
  animation: sheet-turn 440ms cubic-bezier(0.55, 0.06, 0.68, 0.19) both;
}

::view-transition-new(reading-pane) {
  transform-origin: left center;
  backface-visibility: hidden;
  animation: sheet-settle 440ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
}

:root[data-turn="back"]::view-transition-old(reading-pane) {
  transform-origin: right center;
  animation: sheet-recede 440ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
}

:root[data-turn="back"]::view-transition-new(reading-pane) {
  transform-origin: left center;
  animation: sheet-return 440ms cubic-bezier(0.22, 0.61, 0.36, 1) both;
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

@keyframes sheet-return {
  0% {
    opacity: 1;
    transform: rotateY(-92deg) scale(0.96);
    filter: brightness(0.4);
  }
  35% {
    opacity: 1;
  }
  100% {
    opacity: 1;
    transform: rotateY(0deg) scale(1);
    filter: brightness(1);
  }
}

@keyframes sheet-recede {
  0% {
    opacity: 1;
    transform: translateX(0) scale(1);
    filter: brightness(1);
  }
  100% {
    opacity: 0;
    transform: translateX(3%) scale(0.98);
    filter: brightness(0.6);
  }
}
</style>
