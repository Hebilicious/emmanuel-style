<script setup lang="ts" generic="T extends PagerItem">
/**
 * The pager: a list of blocks as a series of spreads.
 *
 * Every route reads as pages. The blocks are rendered once, off screen, at the
 * width each will be shown at, and measured: their heights, the gaps between their
 * lines where they may be cut, and the lines their footnote citations sit on.
 * `utils/paginate.ts` turns those numbers into pages, and pages into screens: two
 * pages side by side on a wide screen, one on a phone. Only the current screen is
 * rendered for real.
 *
 * A screen is drawn as the leaves of a newspaper: the left-hand and the right-hand
 * page, each its own element, clipped at the spine. Both are laid out as the whole
 * screen and each shows its half, so a headline across the spread, or a page as
 * wide as the spread, folds at the spine like a broadsheet; a column that is
 * wholly on the other leaf is left empty, so a page is not drawn twice. That is
 * what lets a turn lift one leaf over the other (`pager-flip.ts` inside a
 * section, `shell/turns.ts` between sections). On a phone there is one leaf.
 *
 * Where the reader is lives in the URL: `?page=3` is the third screen, so a reload,
 * a shared link or the back button returns to the same page.
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
import { useRoute, useRouter } from "vue-router"
import { useShell } from "../shell/shell.js"
import { turning } from "../shell/turns.js"
import { WHEEL_REST, wheelStep } from "../shell/wheel.js"
import { SPREAD_QUERY } from "../shell/wide.js"
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
import { MIN_FIT, type PagerItem, type PagerNote } from "./pager.js"
import { createFlipper } from "./pager-flip.js"
import {
	PAGER_START,
	type PagerEvent,
	type PagerState,
	pagerStep
} from "./pager-machine.js"

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
const route = useRoute()
const router = useRouter()

const root = ref<HTMLElement | null>(null)
const measure = ref<HTMLElement | null>(null)
let columnsEl: HTMLElement | null = null
const setColumns = (element: unknown, leaf: string) => {
	if (leaf !== "right")
		columnsEl = element instanceof HTMLElement ? element : null
}

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

/** The leaves a screen is drawn on: a left and a right page, or one on a phone. */
const leaves = computed(() =>
	geometry.value.columns > 1
		? (["left", "right"] as const)
		: (["single"] as const)
)

/** The measured blocks, the height of the lead, and the scale each `fit` block is set at. */
const measured = shallowRef<Measured[]>([])
const noteHeights = shallowRef<ReadonlyMap<string, number>>(new Map())
/**
 * The scale each `fit` block is set at. Not reactive on purpose: it fills up while
 * the rest of a section is measured behind the page, and the page showing must not
 * be drawn again each time a block it does not show gets its scale. A page reads it
 * when it is drawn, by which time its own blocks are in it.
 */
let fitScale = new Map<string, number>()
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

/**
 * Where the reader is (`pager-machine.ts`). It changes in the same step as the
 * ask, so a spun wheel is never behind: `state.current` is the screen asked for.
 *
 * `current` is the screen drawn. It follows `state.current` once a frame at most
 * (`show`), because a wheel sends a hundred notches a second and each would
 * otherwise render a page nobody sees: the pages a spin passes between two frames
 * are skipped, and the one the reader is on by then is drawn.
 */
const state = shallowRef<PagerState>(PAGER_START)
const ready = computed(() => state.value.phase !== "measuring")
/** The screen drawn, counted from zero. */
const current = ref(0)

const byId = computed(() => new Map(props.items.map((item) => [item.id, item])))
const notesById = computed(
	() => new Map(props.notes.map((note) => [note.id, note]))
)

/** The pages a list of measured blocks packs into, at the geometry as it is. */
const pagesOf = (blocks: readonly Measured[]): Page[] => {
	if (blocks.length === 0) return []
	const { height, columns, leadGap } = geometry.value
	const lead =
		slots.lead === undefined ? 0 : leadHeight.value + leadGap + leadExtra.value
	return paginate(blocks, {
		height: (page) => (page < columns ? height - lead : height),
		gap: geometry.value.gap,
		noteHeights: noteHeights.value,
		// The notes are a flex item of the column, so the block gap sits above them too.
		notesChrome: notesChrome.value + geometry.value.gap,
		noteGap: noteGap.value,
		minLines: props.minLines
	})
}
const pages = computed<Page[]>(() => pagesOf(measured.value))

const opensAScreen = (page: Page) =>
	props.opensScreen &&
	byId.value.get(page.slices[0]?.id ?? "")?.opens === true &&
	(page.slices[0]?.from ?? 0) === 0

const screensOf = (blocks: readonly Measured[]): Screen[] =>
	screens(pagesOf(blocks), geometry.value.columns, opensAScreen)
const spread = computed<Screen[]>(() =>
	screens(pages.value, geometry.value.columns, opensAScreen)
)
const total = computed(() => Math.max(1, spread.value.length))
/**
 * The screen drawn. When more of the section is measured the screens are worked
 * out again, and the one showing comes out the same: the object it was is kept,
 * so nothing that draws from it is drawn again.
 */
let drawnScreen: Screen | null = null
const sameScreen = (a: Screen | null, b: Screen | null): boolean =>
	a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b)
const screen = computed<Screen | null>(() => {
	const next = spread.value[current.value] ?? null
	if (!sameScreen(next, drawnScreen)) drawnScreen = next
	return drawnScreen
})

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

/** The pane size last measured, so a resize that changes nothing does not re-measure. */
let lastSize = ""

/** Read the pane: its size, how many columns it holds, and the gaps. */
const readGeometry = () => {
	const element = root.value
	if (element === null) return
	const style = getComputedStyle(element)
	lastSize = `${element.clientWidth}x${element.clientHeight}`
	geometry.value = {
		width: element.clientWidth,
		height: element.clientHeight,
		columns: window.matchMedia(SPREAD_QUERY).matches ? 2 : 1,
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

/**
 * Set a `fit` block as large as it can be while it still fits one page.
 *
 * `zoom` scales the block's layout, so its text rewraps at the smaller size and
 * the height read back is the height it will have. Every probe lays the block out
 * again, so there are as few as will do: none for a block that fits as it is, and
 * otherwise a guess from how much too tall it is, which is usually the answer.
 */
const zoomOf = (target: HTMLElement): number => Number(target.style.zoom || "1")
const setZoom = (target: HTMLElement, scale: number) => {
	// Writing the value it already has would still make the browser lay it out again.
	if (zoomOf(target) !== scale)
		target.style.zoom = scale === 1 ? "" : String(scale)
}

/** Find the largest scale at which `heightOf()` is no more than `room`, setting `target` to it. */
const fitTo = (
	target: HTMLElement,
	heightOf: () => number,
	room: number
): number => {
	setZoom(target, 1)
	const whole = heightOf()
	if (whole <= room + 0.5) return 1
	const fits = (scale: number): boolean => {
		setZoom(target, scale)
		return heightOf() <= room + 0.5
	}
	/*
	 * Text set smaller is both shorter and wraps less, so its height goes with the
	 * square: that guess is usually right, and is taken when it fits. When it does
	 * not, the scale comes down a step at a time. Every try lays the block out, so
	 * the first that fits is kept rather than looking for a slightly larger one.
	 */
	let scale = Math.max(MIN_FIT, Math.min(1, Math.sqrt(room / whole) * 0.985))
	while (!fits(scale) && scale > MIN_FIT)
		scale = Math.max(MIN_FIT, scale * 0.95)
	return scale
}

const fitBlock = (element: HTMLElement, room: number): number => {
	const target = element.querySelector<HTMLElement>(":scope > .Fit")
	if (target === null) return 1
	return fitTo(target, () => element.getBoundingClientRect().height, room)
}

/**
 * A block that fills a page by itself: set to fit (`fit`), and either as wide as
 * the spread (`screen`) or stretched to the foot of its page (`grow`). Where it
 * goes is known without measuring it: it is one page. Only the scale it is set at
 * has to be found, and that is found on the page itself, when it is drawn
 * (`fitDrawn`). The front of every section is one of these, so a section's first
 * page is drawn without a measuring pass at all.
 */
const fillsPage = (item: PagerItem | undefined): boolean =>
	item?.fit === true && (item.grow === true || item.screen === true)

/** What the paginator is told about a block that fills a page: it is as tall as one. */
const fullPage = (item: PagerItem): Measured => ({
	id: item.id,
	height:
		geometry.value.height -
		(slots.lead === undefined
			? 0
			: leadHeight.value + geometry.value.leadGap + leadExtra.value) -
		1,
	cuts: [],
	refs: [],
	atomic: true,
	...(item.opens === true ? { opens: true } : {}),
	...(item.screen === true ? { screen: true } : {}),
	...(item.keep === true ? { keep: true } : {})
})

/**
 * Set the page-filling blocks that are drawn, and have no scale yet, to fit their
 * page. It is done on the page, before it is painted: the block is asked how tall
 * it is at a few scales, and left at the largest that fits its column. Blocks read
 * together (`fitWith`) are set alike.
 */
const fitDrawn = () => {
	const host = root.value
	if (host === null) return
	const drawnNow = Array.from(
		host.querySelectorAll<HTMLElement>("[data-leaf] [data-fit]")
	)
	const found = new Map<string, number>()
	for (const slice of drawnNow) {
		const id = slice.dataset["fit"] ?? ""
		if (fitScale.has(id) || found.has(id)) continue
		const target = slice.querySelector<HTMLElement>(".Fit")
		const content = target?.firstElementChild
		const column = slice.closest<HTMLElement>(".Column")
		if (target == null || content == null || column === null) continue
		found.set(
			id,
			fitTo(
				target,
				() => content.getBoundingClientRect().height,
				column.getBoundingClientRect().height
			)
		)
	}
	if (found.size === 0) return
	const smallest = new Map<string, number>()
	for (const [id, scale] of found) {
		const group = byId.value.get(id)?.fitWith
		if (group !== undefined)
			smallest.set(group, Math.min(smallest.get(group) ?? 1, scale))
	}
	for (const [id, scale] of found) {
		const group = byId.value.get(id)?.fitWith
		fitScale.set(
			id,
			group === undefined ? scale : (smallest.get(group) ?? scale)
		)
	}
	for (const slice of drawnNow) {
		const scale = fitScale.get(slice.dataset["fit"] ?? "")
		const target = slice.querySelector<HTMLElement>(".Fit")
		if (scale !== undefined && target !== null) setZoom(target, scale)
	}
}

let generation = 0

/*
 * Measuring is done a few blocks at a time. Only the blocks being measured are in
 * the measuring pass (`measuring`), and it is empty the rest of the time.
 *
 * A section used to be measured whole before its first page was shown: every card
 * of the Library, every role of the ledger, drawn off screen and laid out, to show
 * one spread. That was most of what changing section cost. Now the first page is
 * shown as soon as the blocks on it, and on the page after it, have been measured,
 * and the rest are measured behind it when the browser has nothing else to do.
 * Until they all are (`complete`), the count of pages grows; a reader who asks for
 * a page that is not known yet gets it the moment it is (`owed`, `wantsLast`).
 */
const CHUNK = 6
/** Behind the page, fewer at a time: a chunk is one task, and a long one is a dropped frame. */
const IDLE_CHUNK = 2
/** When the reader is waiting for pages that are not known yet, a little more at a time. */
const WAITED_CHUNK = 3
/** Nothing is measured behind the page while the reader is moving through it, or just has. */
const QUIET_FOR = 350
const measuring = shallowRef<readonly T[]>([])
const complete = ref(false)
let idle = 0

const whenIdle = (run: () => void): number =>
	typeof window.requestIdleCallback === "function"
		? window.requestIdleCallback(run, { timeout: 120 })
		: window.setTimeout(run, 16)
const cancelIdle = (handle: number) => {
	if (typeof window.cancelIdleCallback === "function")
		window.cancelIdleCallback(handle)
	window.clearTimeout(handle)
}

/** Where a chunk that starts at `from` ends: `CHUNK` blocks on, and never inside a `fitWith` group. */
const chunkEnd = (from: number, size: number): number => {
	let end = Math.min(from + size, props.items.length)
	while (
		end < props.items.length &&
		props.items[end]?.fitWith !== undefined &&
		props.items[end]?.fitWith === props.items[end - 1]?.fitWith
	)
		end += 1
	return end
}

/** Measure the blocks that are in the measuring pass now, and set the `fit` ones to their page. */
const measureChunk = (
	host: HTMLElement,
	first: boolean,
	scales: Map<string, number>
): Measured[] => {
	const blocks = Array.from(
		host.querySelectorAll<HTMLElement>(":scope > [data-measure-id]")
	)
	const roomOf = (opening: boolean) =>
		opening && slots.lead !== undefined
			? geometry.value.height - leadHeight.value - geometry.value.leadGap
			: geometry.value.height
	blocks.forEach((element, at) => {
		const id = element.dataset["measureId"] ?? ""
		if (byId.value.get(id)?.fit === true)
			scales.set(id, fitBlock(element, roomOf(first && at === 0)))
	})
	/*
	 * The blocks that are read together (`fitWith`, the two pages of a skill) are
	 * all set at the smallest scale among them: the same text at two sizes on facing
	 * pages reads as a mistake. A chunk never ends inside such a group.
	 */
	const smallest = new Map<string, number>()
	for (const element of blocks) {
		const id = element.dataset["measureId"] ?? ""
		const group = byId.value.get(id)?.fitWith
		const scale = scales.get(id)
		if (group !== undefined && scale !== undefined)
			smallest.set(group, Math.min(smallest.get(group) ?? 1, scale))
	}
	for (const element of blocks) {
		const id = element.dataset["measureId"] ?? ""
		const group = byId.value.get(id)?.fitWith
		const scale = group === undefined ? undefined : smallest.get(group)
		if (scale === undefined || scale === scales.get(id)) continue
		scales.set(id, scale)
		const target = element.querySelector<HTMLElement>(":scope > .Fit")
		if (target !== null) setZoom(target, scale)
	}
	const next: Measured[] = []
	for (const element of blocks) {
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
			...(item.atomic === true || item.fit === true ? { atomic: true } : {})
		})
	}
	return next
}

/** The notes of the article, measured once: they are few, and a page needs them to be packed. */
const measureNotes = (host: HTMLElement) => {
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
	noteHeights.value = heights
}

/** The screen a block is on, among these screens, or -1. */
const screenWith = (
	list: readonly Screen[],
	id: string,
	from: number
): number =>
	list.findIndex((candidate) =>
		candidate.pages.some((page) =>
			page.slices.some(
				(slice) => slice.id === id && slice.from <= from + 1 && slice.to > from
			)
		)
	)

/**
 * Measure the blocks at the width they will be shown at: enough of them to show
 * the page the reader is on, then the rest when the browser is idle.
 *
 * Fonts are awaited first: a block measured in the fallback face is shorter than
 * the same block in Monaspace, and a page packed to the shorter height overflows
 * once the real face arrives.
 */
const measureAll = async () => {
	const run = (generation += 1)
	cancelIdle(idle)
	/*
	 * Where the reader is, taken before anything moves: once the new geometry is
	 * read, the screens are recomputed from the old heights at the new size, and the
	 * block at the top of the "current" screen is not the one the reader was on.
	 */
	const fresh = !ready.value
	const anchor = fresh ? null : anchorOf()
	// The reader may move on while this runs: where they were then, to carry the move over.
	const startedOn = state.value.current
	readGeometry()
	complete.value = false

	const scales = new Map<string, number>()
	const blocks: Measured[] = []
	let at = 0
	/** Put the next blocks in the measuring pass, lay them out, and measure them. `false` when overtaken. */
	const more = async (size = CHUNK): Promise<boolean> => {
		// A block that fills a page is not drawn to be measured: it is one page.
		const next = props.items[at]
		if (next !== undefined && fillsPage(next) && at > 0) {
			blocks.push(fullPage(next))
			at += 1
			return true
		}
		// The blocks to measure: up to the next one that fills a page.
		let end = chunkEnd(at, size)
		const stop = props.items.findIndex(
			(item, index) => index > at && fillsPage(item)
		)
		if (stop !== -1 && stop < end) end = stop
		const first = at === 0
		const leading = first && fillsPage(next)
		measuring.value = leading ? [] : props.items.slice(at, end)
		await nextTick()
		if (first && document.fonts.status !== "loaded") {
			/*
			 * A page set in the fallback face is the wrong height. A face is only
			 * requested once text set in it is laid out, so the pass is laid out first.
			 */
			void measure.value?.offsetHeight
			await document.fonts.ready
		}
		const host = measure.value
		if (run !== generation || host === null) return false
		if (first) {
			const lead = host.querySelector<HTMLElement>("[data-measure-lead]")
			leadHeight.value = lead === null ? 0 : lead.getBoundingClientRect().height
			leadExtra.value = 0
			measureNotes(host)
		}
		if (leading && next !== undefined) {
			blocks.push(fullPage(next))
			at += 1
			return true
		}
		blocks.push(...measureChunk(host, first, scales))
		at = end
		return true
	}
	const all = () => at >= props.items.length

	/** Whether the page the reader is to be shown is known, with the page after it. */
	const wanted = fresh ? pageFromUrl() : null
	/*
	 * The page is known once nothing that follows could still land on it. That is
	 * tried with a stand-in for what follows, one pixel tall: if even that goes to a
	 * later screen, so will the real thing.
	 */
	const REST = "\u0000rest"
	const enough = (): boolean => {
		const following = props.items[at]
		const known = screensOf([
			...blocks,
			{
				id: REST,
				height: 1,
				cuts: [],
				refs: [],
				...(following?.opens === true ? { opens: true } : {}),
				...(following?.screen === true ? { screen: true } : {})
			}
		])
		const on =
			wanted ??
			(anchor === null ? 0 : screenWith(known, anchor.id, anchor.from))
		const there = known[on]
		return (
			there !== undefined &&
			!there.pages.some((page) =>
				page.slices.some((slice) => slice.id === REST)
			)
		)
	}
	/*
	 * A link deep into a section needs a lot of it measured before its page is
	 * known. Each chunk is then a task of its own: the browser gets to draw and to
	 * answer the reader between them, rather than stop for the whole of it.
	 */
	let since = performance.now()
	do {
		if (!(await more())) return
		if (performance.now() - since > 24 && !all() && !enough()) {
			await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
			if (run !== generation) return
			since = performance.now()
		}
	} while (!all() && !enough())

	fitScale = scales
	measured.value = [...blocks]
	if (all()) complete.value = true
	send({
		type: "LAID_OUT",
		// The first layout opens on the page the URL names; a later one keeps the reader's place.
		screen:
			anchor === null
				? Math.min(pageFromUrl(), total.value - 1)
				: Math.max(
						0,
						Math.min(
							restore(anchor) + (state.value.current - startedOn),
							total.value - 1
						)
					)
	})
	shell.laidOut += 1
	await nextTick()
	if (run !== generation) return
	fitDrawn()
	// A route turn waits for this, so it captures the new page laid out.
	if (fresh) shell.layouts += 1

	/*
	 * The page-filling blocks the reader has not been shown yet still need their
	 * scale. Finding it on the page when it is first drawn costs that turn a few
	 * layouts of the whole page, so it is found here first, off screen, one block
	 * (or one `fitWith` group) at a time; the page then only has to be drawn.
	 */
	const unfitted = (): T[] => {
		const from = props.items.findIndex(
			(item, index) => index < at && fillsPage(item) && !scales.has(item.id)
		)
		const first = props.items[from]
		if (first === undefined) return []
		const group = [first]
		if (first.fitWith !== undefined)
			for (
				let next = from + 1;
				props.items[next]?.fitWith === first.fitWith;
				next += 1
			)
				group.push(props.items[next] as T)
		return group
	}
	const prefit = async (group: readonly T[]): Promise<boolean> => {
		measuring.value = group
		await nextTick()
		const host = measure.value
		if (run !== generation || host === null) return false
		const found = new Map<string, number>()
		for (const element of host.querySelectorAll<HTMLElement>(
			":scope > [data-measure-id]"
		)) {
			const id = element.dataset["measureId"] ?? ""
			const opening = props.items[0]?.id === id && slots.lead !== undefined
			found.set(
				id,
				fitBlock(
					element,
					geometry.value.height -
						(opening ? leadHeight.value + geometry.value.leadGap : 0)
				)
			)
		}
		const smallest = Math.min(1, ...found.values())
		for (const item of group) {
			// The page may have been drawn, and fitted there, while this was laid out.
			if (scales.has(item.id)) continue
			scales.set(
				item.id,
				item.fitWith === undefined ? (found.get(item.id) ?? 1) : smallest
			)
		}
		return true
	}

	/* The rest, a little whenever the browser is idle and the reader is still. */
	const rest = () => {
		if (run !== generation) return
		const group = unfitted()
		if (all() && group.length === 0) {
			measuring.value = []
			return
		}
		// The reader comes first: unless they are waiting for these very pages, wait until they are still.
		const waitingNow = (owed > 0 || wantsLast) && !all()
		if (!waitingNow && performance.now() - movedAt < QUIET_FOR) {
			idle = whenIdle(rest)
			return
		}
		if (!waitingNow && group.length > 0) {
			void prefit(group).then((went) => {
				if (went) idle = whenIdle(rest)
			})
			return
		}
		void more(waitingNow ? WAITED_CHUNK : IDLE_CHUNK).then((went) => {
			if (!went) return
			/*
			 * What has been measured is made known when it is all there, or sooner if the
			 * reader is waiting for it: at the last page known, or owed pages past it.
			 * Each time it is made known the count of pages changes and everything that
			 * shows the count is drawn again, so it is not done for every chunk.
			 */
			const waiting =
				owed > 0 || wantsLast || state.value.current >= total.value - 2
			if (all() || waiting) measured.value = [...blocks]
			if (all()) complete.value = true
			settleOwed()
			idle = whenIdle(rest)
		})
	}
	idle = whenIdle(rest)
}

/** The block and offset at the top of the current screen, to keep the place on a re-layout. */
const anchorOf = (): { id: string; from: number } | null => {
	// The first page of a screen can be empty (a lead with no room under it).
	const first = screen.value?.pages.flatMap((page) => page.slices)[0]
	return first === undefined ? null : { id: first.id, from: first.from }
}

const restore = (anchor: { id: string; from: number }): number => {
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
	return index === -1 ? Math.min(current.value, total.value - 1) : index
}

/* --------------------------------------------------------------- the address */

/** The screen the URL names, counted from zero. */
const pageFromUrl = (): number => {
	const value = Number(route.query["page"])
	return Number.isInteger(value) && value >= 1 ? value - 1 : 0
}

/**
 * The URL follows the page. It is replaced rather than pushed: turning a page is
 * reading, not navigating, so the back button leaves the article instead of
 * stepping back through every spread of it.
 *
 * Each write is remembered until the router reports it back. A replace lands a
 * moment after it is asked for, and quick turns ask for several: read as a move
 * from elsewhere, the echo of an older one turned the pager back to it.
 */
const echoes: string[] = []
const queryPage = (value: unknown): string =>
	typeof value === "string" ? value : ""

/*
 * The address is written once the reader has stopped moving, not on every page a
 * spin of the wheel passes: a write is a navigation, and a hundred a second were
 * work that slowed the scroll they recorded.
 */
const ADDRESS_AFTER = 160
let addressTimer = 0
const writeAddress = () => {
	if (!ready.value) return
	const page = current.value === 0 ? undefined : String(current.value + 1)
	if ((route.query["page"] ?? undefined) === page) return
	echoes.push(page ?? "")
	void router.replace({ query: { ...route.query, page } })
}
watch(current, () => {
	window.clearTimeout(addressTimer)
	addressTimer = window.setTimeout(writeAddress, ADDRESS_AFTER)
})

/**
 * And the page follows the URL, when something else moves it: the back button, a
 * link to `?page=3`. A change of route is not one: that is a route turn, and this
 * pager is leaving.
 */
watch(
	() => [route.path, route.query["page"]] as const,
	([path, page], [previous]) => {
		if (!ready.value || path !== previous) return
		const echo = echoes.indexOf(queryPage(page))
		if (echo !== -1) {
			// Ours, and every write before it has landed or been overtaken.
			echoes.splice(0, echo + 1)
			return
		}
		// A write of our own that has not left yet is newer than whatever the URL says.
		window.clearTimeout(addressTimer)
		const wanted = Math.min(pageFromUrl(), total.value - 1)
		if (wanted !== state.value.current) go(wanted)
	}
)

/* --------------------------------------------------------------------- moving */

/*
 * The leaves that turn when the page changes (`pager-flip.ts`). A page that
 * leaves is not removed at once: each leaf is drawn inside a `<Transition>`, which
 * hands the old element over as it leaves and keeps it in the DOM until it is let
 * go, and those are the leaves that turn. The new page is drawn under them in the
 * same frame.
 *
 * `drawn` is the key of the leaves: it changes with every page shown, so the
 * leaves of one page are never reused for the next and both exist during a turn.
 */
const drawn = ref(0)
type LeafName = "left" | "right" | "single"
const flipper = createFlipper(() => ({
	spread: window.innerWidth * 1.9,
	single: window.innerWidth * 5.2
}))

/** The change of page being drawn: its direction, and the leaves that left and came. */
let change: {
	direction: "forward" | "back"
	pages: number
	old: Partial<Record<LeafName, HTMLElement>>
	fresh: Partial<Record<LeafName, HTMLElement>>
} | null = null
const releases = new Map<HTMLElement, () => void>()

const onLeafLeave = (element: Element, done: () => void) => {
	const leaf = element as HTMLElement
	const name = leaf.dataset["leaf"] as LeafName | undefined
	// Not a change of page (the pager is going, or its columns changed): nothing turns.
	if (change === null || name === undefined) return done()
	change.old[name] = leaf
	releases.set(leaf, done)
}
const onLeafEnter = (element: Element, done: () => void) => {
	const leaf = element as HTMLElement
	const name = leaf.dataset["leaf"] as LeafName | undefined
	if (change !== null && name !== undefined) change.fresh[name] = leaf
	done()
}
const release = (leaf: HTMLElement) => {
	const done = releases.get(leaf)
	releases.delete(leaf)
	done?.()
}

/* Whenever a page is drawn, its page-filling blocks are set to fit it, before it is painted. */
watch([screen, drawn], fitDrawn, { flush: "post" })

/**
 * Draw the screen the reader is on, if it is not the one drawn. Once it is in the
 * DOM, the leaves that left are handed to the flipper with the ones that came.
 */
let frame = 0
const show = () => {
	frame = 0
	const to = state.value.current
	if (to === current.value || !ready.value) return
	const drawing = {
		direction: to > current.value ? ("forward" as const) : ("back" as const),
		pages: Math.abs(to - current.value),
		old: {},
		fresh: {}
	}
	change = drawing
	drawn.value += 1
	current.value = to
	void nextTick(() => {
		if (change === drawing) change = null
		flipper.step(
			drawing.direction,
			drawing.pages,
			drawing.old,
			drawing.fresh,
			release
		)
	})
}

/** When the reader last moved, for whatever should wait until they are still. */
let movedAt = Number.NEGATIVE_INFINITY

/** Deliver an event. A move is drawn on the next frame; a layout, at once. */
const send = (event: PagerEvent) => {
	const before = state.value
	state.value = pagerStep(before, event)
	if (event.type === "STEP" || event.type === "ASK") movedAt = performance.now()
	if (event.type === "RESET" || event.type === "LAID_OUT") {
		flipper.snap()
		current.value = state.value.current
		return
	}
	if (state.value.current !== before.current && frame === 0)
		frame = requestAnimationFrame(show)
}

/** A View Transition photographs the page: the copies must be gone before it does. */
const stopFollowing = turning.subscribe((now) => {
	if (now !== "idle") flipper.snap()
})

/*
 * A reader can ask for a page before it is known: a spin of the wheel past the
 * last page measured so far, or `End`. What cannot be given yet is owed, and is
 * given as the pages come in.
 */
let owed = 0
let wantsLast = false
const settleOwed = () => {
	if (wantsLast) {
		send({ type: "ASK", screen: total.value - 1, total: total.value })
		if (complete.value) wantsLast = false
		return
	}
	if (owed === 0) return
	const room = total.value - 1 - state.value.current
	const given = Math.min(owed, room)
	owed = complete.value ? 0 : owed - given
	if (given > 0) send({ type: "STEP", delta: given, total: total.value })
}

const go = (index: number) => {
	owed = 0
	wantsLast = !complete.value && index >= total.value
	send({ type: "ASK", screen: index, total: total.value })
}

/** Move by `delta` screens from the one the reader is on. */
const step = (delta: number) => {
	wantsLast = false
	const past = state.value.current + delta - (total.value - 1)
	owed = delta > 0 && past > 0 && !complete.value ? owed + past : 0
	send({ type: "STEP", delta, total: total.value })
}

const turner = {
	turn: step,
	go
}

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
	const element = columnsEl
	if (element === null) return
	const planned = Number.parseFloat(pageStyle(0).height)
	const shortfall = planned - element.clientHeight
	if (shortfall > 0.5 && leadExtra.value < 400)
		leadExtra.value += Math.ceil(shortfall)
})

/* ------------------------------------------------------------- touch, wheel */

let touch: { x: number; y: number; id: number } | null = null

/*
 * The wheel and the swipe are listened for on the window, not on the pager. While a
 * turn runs, what is under the pointer is the View Transition's overlay, so the
 * events go to the root element and never reach the pager: every notch of the
 * wheel during a turn was lost, which is what made the wheel feel spotty. Only
 * events over the pager count, and none while a dialog is open over it.
 */
let pane: DOMRect | null = null
const over = (event: MouseEvent): boolean => {
	if (shell.dialog !== null) return false
	// Read once and kept until the pane is resized: asking on every notch laid the page out on every notch.
	pane ??= root.value?.getBoundingClientRect() ?? null
	const box = pane ?? undefined
	return (
		box !== undefined &&
		event.clientX >= box.left &&
		event.clientX <= box.right &&
		event.clientY >= box.top &&
		event.clientY <= box.bottom
	)
}

const onPointerDown = (event: PointerEvent) => {
	if (event.pointerType !== "touch" || !over(event)) return
	touch = { x: event.clientX, y: event.clientY, id: event.pointerId }
}

/** A horizontal swipe turns the page, the way a phone reader does. */
const onPointerUp = (event: PointerEvent) => {
	if (touch === null || event.pointerId !== touch.id) return
	const dx = event.clientX - touch.x
	const dy = event.clientY - touch.y
	touch = null
	if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.4) return
	step(dx < 0 ? 1 : -1)
}

/*
 * The wheel moves through the pages by how far it is turned (`shell/wheel.ts`):
 * every event is worth some part of a page, and the reader is moved by the whole
 * pages that adds up to, at once.
 */
let wheel = WHEEL_REST

const onWheel = (event: WheelEvent) => {
	if (!shell.mouse || !over(event)) return
	const legacy = event as WheelEvent & {
		wheelDeltaX?: number
		wheelDeltaY?: number
	}
	const moved = wheelStep(wheel, {
		deltaX: event.deltaX,
		deltaY: event.deltaY,
		deltaMode: event.deltaMode,
		wheelDeltaX: legacy.wheelDeltaX,
		wheelDeltaY: legacy.wheelDeltaY,
		time: event.timeStamp
	})
	wheel = moved.state
	if (moved.pages !== 0) step(moved.pages)
}

/* ------------------------------------------------------------------ lifecycle */

let observer: ResizeObserver | null = null
let resizeTimer = 0

const onFonts = () => void measureAll()
const onPointerCancel = () => {
	touch = null
}

onMounted(() => {
	if (props.turns) shell.turner = turner
	window.addEventListener("wheel", onWheel, { passive: true })
	window.addEventListener("pointerdown", onPointerDown, { passive: true })
	window.addEventListener("pointerup", onPointerUp, { passive: true })
	window.addEventListener("pointercancel", onPointerCancel, { passive: true })
	void measureAll()
	observer = new ResizeObserver(() => {
		const element = root.value
		if (element === null) return
		pane = null
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
	window.removeEventListener("wheel", onWheel)
	window.removeEventListener("pointerdown", onPointerDown)
	window.removeEventListener("pointerup", onPointerUp)
	window.removeEventListener("pointercancel", onPointerCancel)
	observer?.disconnect()
	window.clearTimeout(resizeTimer)
	document.fonts.removeEventListener("loadingdone", onFonts)
	if (shell.turner === turner) shell.turner = null
	shell.position = null
	stopFollowing()
	flipper.snap()
	generation += 1
	cancelIdle(idle)
	cancelAnimationFrame(frame)
	window.clearTimeout(addressTimer)
})

watch(
	() => [props.items, props.notes],
	() => {
		send({ type: "RESET" })
		void measureAll()
	}
)

/** The screen a block starts on, counted from zero, or -1 before the layout. */
const screenOf = (id: string): number =>
	spread.value.findIndex((candidate) =>
		candidate.pages.some((page) =>
			page.slices.some((slice) => slice.id === id && slice.from === 0)
		)
	)

defineExpose({ turn: step, go, total, current, screenOf })

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

const fitStyle = (id: string) => {
	const scale = fitScale.get(id)
	return scale === undefined || scale === 1
		? undefined
		: { zoom: String(scale) }
}

/** A page as wide as the spread: it is on both leaves, folded at the spine. */
const isWide = (page: Page) =>
	page.screen === true && geometry.value.columns > 1

/**
 * Whether a column is drawn on a leaf. Each leaf is laid out as the whole screen
 * and shows its half, but a column wholly on the other leaf is left empty: it
 * keeps its place and costs nothing. Only a page as wide as the spread is drawn
 * on both.
 */
const onLeaf = (leaf: string, index: number, page: Page) =>
	leaf === "single" ||
	isWide(page) ||
	(leaf === "left" ? index === 0 : index > 0)

/** Each leaf shows its half of the spread: the right-hand one is drawn shifted by a half. */
const leafStyle = (leaf: string) => {
	const { width, columns } = geometry.value
	const half = columns > 1 ? width / 2 : width
	return {
		left: leaf === "right" ? `${half}px` : "0px",
		width: `${half}px`,
		viewTransitionName: `leaf-${leaf}`
	}
}

const leafInnerStyle = (leaf: string) => ({
	width: `${geometry.value.width}px`,
	left: leaf === "right" ? `${-geometry.value.width / 2}px` : "0px"
})

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
    aria-roledescription="paginated">
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
        v-for="item of measuring"
        :key="item.id"
        class="Block"
        :data-measure-id="item.id"
        :style="{
        	width: `${item.screen && geometry.columns > 1 ? geometry.width : columnWidth}px`
        }">
        <div class="Fit">
          <slot name="item" :item></slot>
        </div>
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

    <!--
      The spread. Each leaf carries the whole screen and shows its half: the right
      leaf is a copy for the eye, hidden from assistive technology, which reads the
      screen once from the left one.
    -->
    <div
      v-if="ready && screen"
      class="Spread"
      :class="{ Single: geometry.columns === 1 }"
      :data-screen-index="current">
      <Transition
        v-for="leaf of leaves"
        :key="leaf"
        :css="false"
        @leave="onLeafLeave"
        @enter="onLeafEnter">
        <div
          :key="`${leaf}-${drawn}`"
          class="Leaf"
          :class="leaf"
          :data-leaf="leaf"
          data-clip
          :style="leafStyle(leaf)">
          <div class="LeafInner" :style="leafInnerStyle(leaf)">
            <div class="Screen" :class="{ Wide: screen.wide }">
              <div
                v-if="current === 0 && $slots.lead"
                class="Lead"
                data-part="lead"
                :aria-hidden='leaf === "right" ? "true" : undefined'>
                <slot name="lead"></slot>
              </div>
              <div
                :ref="(element) => setColumns(element, leaf)"
                class="Columns">
                <div
                  v-for="(page, index) of screen.pages"
                  :key="`${current}-${index}`"
                  class="Column"
                  :class="{ Wide: page.screen && geometry.columns > 1 }"
                  :data-part="`column-${index}`"
                  :style="pageStyle(index)"
                  :aria-hidden='leaf === "right" && isWide(page) ? "true" : undefined'>
                  <template
                    v-for="slice of onLeaf(leaf, index, page) ? page.slices : []"
                    :key="`${slice.id}@${slice.from}`">
                    <div
                      v-if="byId.get(slice.id)"
                      class="Slice"
                      :class="{ Grow: isWhole(slice) && byId.get(slice.id)?.grow === true }"
                      :data-fit="fillsPage(byId.get(slice.id)) ? slice.id : undefined"
                      :data-clip="isWhole(slice) ? undefined : true"
                      :style="sliceStyle(slice)">
                      <div
                        class="SliceBody"
                        :style="slice.from > 0 ? { marginTop: `${-slice.from}px` } : undefined">
                        <div class="Fit" :style="fitStyle(slice.id)">
                          <slot
                            name="item"
                            :item="byId.get(slice.id) as T"></slot>
                        </div>
                      </div>
                    </div>
                  </template>

                  <section
                    v-if="page.notes.length > 0 && onLeaf(leaf, index, page)"
                    class="Notes"
                    aria-label="Notes">
                    <ol>
                      <li v-for="id of page.notes" :key="id" :data-note="id">
                        <span class="Number">{{
                          notesById.get(id)?.number
                        }}</span>
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
              </div>
            </div>
          </div>
        </div>
      </Transition>
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
  /*
   * Cut to the pane, with some room around it: a leaf that is turning comes
   * toward the reader, so its free edge is taller than the page for a moment.
   */
  overflow: clip;
  overflow-clip-margin: 16vh;
  /* Read by the script: the gutter between columns and the gap between blocks. */
  column-gap: var(--spacing_fluid-column-space-column-s);
  row-gap: var(--block-gap, 0.85rem);
  --lead-gap: var(--spacing_fluid-tight-space-tight-l);
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

/*
 * Each block is measured on its own: out of the flow, so that setting one smaller
 * (`fit`) does not move, and lay out again, every block after it.
 */
.Measure > .Block {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  contain: layout style;
}

/* Nothing moves in a copy nobody sees: its animations would only cost. */
.Measure :deep(*),
.Measure :deep(*)::before,
.Measure :deep(*)::after {
  animation: none !important;
  transition: none !important;
}

.Fit {
  display: flow-root;
}

/* The spread: two leaves meeting at the spine, or one on a phone. */
.Spread {
  position: relative;
  height: 100%;
}

/*
 * A leaf is a page of the paper: opaque, so that a leaf turning over another hides
 * what is under it, and clipped at the spine.
 */
.Leaf {
  /*
   * Placed, not flowed: during a turn the leaves of the page that is leaving are
   * still here, over the ones of the page that came, and neither may push the other.
   */
  position: absolute;
  inset-block: 0;
  overflow: clip;
  background: var(--paper);
}

.LeafInner {
  position: absolute;
  inset-block: 0;
}

/*
 * The fold. Each leaf carries its half of the crease at its spine edge, so the
 * shading turns with the page as it lifts, the way the curve of a real fold does.
 */
.Leaf.left::after,
.Leaf.right::after {
  content: "";
  position: absolute;
  inset-block: 0;
  width: calc(var(--spacing_fluid-column-space-column-s) / 2);
  pointer-events: none;
}

.Leaf.left::after {
  right: 0;
  background: linear-gradient(
    to left,
    color-mix(in oklab, var(--ink) 9%, transparent),
    transparent 85%
  );
  border-right: var(--spacing-size-hairline) solid var(--rule);
}

.Leaf.right::after {
  left: 0;
  background: linear-gradient(
    to right,
    color-mix(in oklab, var(--ink) 7%, transparent),
    transparent 85%
  );
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

/*
 * A block that asks to grow takes the rest of its page: the slice, its body, the
 * scaled box and the block itself are each a column that stretches.
 */
.Slice.Grow {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
}

.Slice.Grow > .SliceBody,
.Slice.Grow > .SliceBody > .Fit {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
}

.Slice.Grow > .SliceBody > .Fit > :deep(*) {
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
