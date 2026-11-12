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
 * page, each its own element, clipped at the spine. Both carry the whole screen
 * and each shows its half, so a headline across the spread, or a page as wide as
 * the spread, folds at the spine like a broadsheet. That is what lets a turn lift
 * one leaf over the other (`shell/turns.ts`, `styles/turns.css`). On a phone there
 * is one leaf.
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
import { reducedMotion, skipTurn, turn } from "../shell/turns.js"
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
import {
	scrolling,
	nextTurn,
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
const fitScale = shallowRef<ReadonlyMap<string, number>>(new Map())
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
 * Where the reader is and what the pager is doing about it: measuring, resting on
 * a screen, or turning to the one asked for (`pager-machine.ts`).
 */
const state = shallowRef<PagerState>(PAGER_START)
const send = (event: PagerEvent) => {
	state.value = pagerStep(state.value, event)
}
const ready = computed(() => state.value.phase !== "measuring")
/** The screen showing, counted from zero. */
const current = computed(() => state.value.current)

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
 * otherwise a first guess from how much too tall it is, then up to three halvings
 * around it, which find the scale to within a few percent.
 */
const zoomOf = (target: HTMLElement): number => Number(target.style.zoom || "1")
const setZoom = (target: HTMLElement, scale: number) => {
	// Writing the value it already has would still make the browser lay it out again.
	if (zoomOf(target) !== scale)
		target.style.zoom = scale === 1 ? "" : String(scale)
}

const fitBlock = (element: HTMLElement, room: number): number => {
	const target = element.querySelector<HTMLElement>(":scope > .Fit")
	if (target === null) return 1
	setZoom(target, 1)
	const whole = element.getBoundingClientRect().height
	if (whole <= room) return 1
	const fits = (scale: number): boolean => {
		setZoom(target, scale)
		return element.getBoundingClientRect().height <= room
	}
	// Text set smaller is both shorter and wraps less, so its height goes with the square.
	const guess = Math.max(MIN_FIT, Math.min(1, Math.sqrt(room / whole) * 0.99))
	let [low, high] = fits(guess)
		? [guess, Math.min(1, guess * 1.08)]
		: [MIN_FIT, guess]
	for (let step = 0; step < 3 && high - low > 0.025; step += 1) {
		const middle = (low + high) / 2
		if (fits(middle)) low = middle
		else high = middle
	}
	setZoom(target, low)
	return low
}

let generation = 0

/**
 * Measure every block at the width it will be shown at.
 *
 * Fonts are awaited first: a block measured in the fallback face is shorter than
 * the same block in Monaspace, and a page packed to the shorter height overflows
 * once the real face arrives.
 */
const measureAll = async () => {
	const run = (generation += 1)
	/*
	 * Where the reader is, taken before anything moves: once the new geometry is
	 * read, the screens are recomputed from the old heights at the new size, and the
	 * block at the top of the "current" screen is not the one the reader was on.
	 */
	const fresh = !ready.value
	const anchor = fresh ? null : anchorOf()
	readGeometry()
	await nextTick()
	/*
	 * Lay the measuring pass out before waiting: a face is only requested once text
	 * set in it is laid out, and `fonts.ready` does not wait for a face nobody has
	 * asked for yet. Without this the first layout was taken in the fallback face and
	 * redone when Nabla arrived, moving the cuts under the page the reader was on.
	 */
	void measure.value?.offsetHeight
	await document.fonts.ready
	if (run !== generation) return
	const host = measure.value
	if (host === null) return

	const lead = host.querySelector<HTMLElement>("[data-measure-lead]")
	leadHeight.value = lead === null ? 0 : lead.getBoundingClientRect().height
	leadExtra.value = 0

	const scales = new Map<string, number>()
	const next: Measured[] = []
	const blocks = Array.from(
		host.querySelectorAll<HTMLElement>(":scope > [data-measure-id]")
	)
	// First every `fit` block is set to fit its page.
	const roomOf = (first: boolean) =>
		first && slots.lead !== undefined
			? geometry.value.height - leadHeight.value - geometry.value.leadGap
			: geometry.value.height
	blocks.forEach((element, at) => {
		const id = element.dataset["measureId"] ?? ""
		if (byId.value.get(id)?.fit === true)
			scales.set(id, fitBlock(element, roomOf(at === 0)))
	})
	/*
	 * Then the blocks that are read together (`fitWith`, the two pages of a skill)
	 * are all set at the smallest scale among them: the same text at two sizes on
	 * facing pages reads as a mistake.
	 */
	const smallest = new Map<string, number>()
	for (const [id, scale] of scales) {
		const group = byId.value.get(id)?.fitWith
		if (group !== undefined)
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
	fitScale.value = scales
	measured.value = next
	send({
		type: "LAID_OUT",
		// The first layout opens on the page the URL names; a later one keeps the reader's place.
		screen:
			anchor === null
				? Math.min(pageFromUrl(), total.value - 1)
				: restore(anchor)
	})
	if (fresh) {
		// A route turn waits for this, so it captures the new page laid out.
		await nextTick()
		shell.layouts += 1
	}
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

watch(current, (value) => {
	if (!ready.value) return
	const page = value === 0 ? undefined : String(value + 1)
	if ((route.query["page"] ?? undefined) === page) return
	echoes.push(page ?? "")
	void router.replace({ query: { ...route.query, page } })
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
		const wanted = Math.min(pageFromUrl(), total.value - 1)
		if (wanted !== state.value.target) go(wanted)
	}
)

/* -------------------------------------------------------------------- turning */

/**
 * Turn until the screen asked for is showing: one leaf, to that screen.
 *
 * One View Transition at a time, each to the end unless the reader scrolls on
 * (`step`), which cuts it short.
 */
const pump = async () => {
	if (state.value.phase !== "resting") return
	send({ type: "BEGIN" })
	try {
		for (
			let next = nextTurn(state.value);
			next !== null;
			next = nextTurn(state.value)
		) {
			const { to } = next
			await turn(next.direction, async () => {
				// Scrolling may have moved the page on while this turn was being set up.
				if (nextTurn(state.value)?.to === to)
					send({ type: "LANDED", screen: to })
				await nextTick()
			})
		}
	} finally {
		send({ type: "SETTLE" })
	}
}

const go = (index: number) => {
	send({ type: "ASK", screen: index, total: total.value })
	void pump()
}

/*
 * The riffle: the leaves that flip over the spread while the reader scrolls.
 *
 * Scrolling does not wait for a turn. The page asked for is shown at once, and
 * over it blank leaves flip in the direction of travel, one per page passed (no
 * closer together than `RIFFLE_EVERY`, and no more than `RIFFLE_MOST` in the air),
 * so a slow scroll is a leaf now and then and a spin of the wheel is a flutter of
 * them. Each leaf removes itself when it has landed.
 */
const RIFFLE_EVERY = 55
const RIFFLE_MOST = 7
/** How long a leaf of the riffle is in the air; the stylesheet is given it. */
const RIFFLE_MS = 220
const riffle = ref<{ id: number; direction: "forward" | "back" }[]>([])
let riffleId = 0
let riffledAt = Number.NEGATIVE_INFINITY

const flip = (direction: "forward" | "back", now: number) => {
	if (reducedMotion() || now - riffledAt < RIFFLE_EVERY) return
	if (riffle.value.length >= RIFFLE_MOST) return
	riffledAt = now
	riffleId += 1
	const id = riffleId
	riffle.value = [...riffle.value, { id, direction }]
	// The leaf takes itself away when it lands; this is for the one whose landing is not reported.
	window.setTimeout(() => landed(id), RIFFLE_MS + 120)
}
const landed = (id: number) => {
	riffle.value = riffle.value.filter((leaf) => leaf.id !== id)
}

/** When the last step was asked for, to tell scrolling from a turn. */
let askedAt = Number.NEGATIVE_INFINITY

/**
 * Move by `delta` screens, counted from the screen already asked for.
 *
 * Where the reader is going is settled first, here; what is animated follows. A
 * step on its own is one turn. A step that comes while a leaf is in the air, or
 * hard on the last one, is scrolling: the leaf in the air is dropped, the screen
 * asked for is shown at once, and a riffle plays over it.
 */
const step = (delta: number) => {
	const now = performance.now()
	const since = now - askedAt
	askedAt = now
	const before = state.value
	send({ type: "STEP", delta, total: total.value })
	if (state.value.target === before.target) return
	if (scrolling(before, since)) {
		skipTurn()
		send({ type: "JUMP" })
		flip(delta > 0 ? "forward" : "back", now)
		return
	}
	void pump()
}

const turner = {
	turn: step,
	go,
	turning: () => state.value.phase === "turning"
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
const over = (event: MouseEvent): boolean => {
	if (shell.dialog !== null) return false
	const box = root.value?.getBoundingClientRect()
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
 * The wheel turns pages: a turn per notch of a mouse wheel, a turn per flick of a
 * trackpad. Which events count is `shell/wheel.ts`; here they are scaled to pixels
 * and the turn asked for is run, while the queue has room for it.
 */
let wheel = WHEEL_REST

const onWheel = (event: WheelEvent) => {
	if (!shell.mouse || !over(event)) return
	const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
	const delta =
		(Math.abs(event.deltaY) >= Math.abs(event.deltaX)
			? event.deltaY
			: event.deltaX) * scale
	const asked = wheelStep(wheel, { delta, time: event.timeStamp })
	wheel = asked.state
	if (asked.turn !== 0) step(asked.turn)
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
	const scale = fitScale.value.get(id)
	return scale === undefined || scale === 1
		? undefined
		: { zoom: String(scale) }
}

/** Each leaf shows its half of the spread: the right-hand one is drawn shifted by a half. */
const leafStyle = (leaf: string) => {
	const { width, columns } = geometry.value
	const half = columns > 1 ? width / 2 : width
	return {
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
        v-for="item of items"
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
      <div
        v-for="leaf of leaves"
        :key="leaf"
        class="Leaf"
        :class="leaf"
        :data-leaf="leaf"
        data-clip
        :style="leafStyle(leaf)"
        :aria-hidden='leaf === "right" ? "true" : undefined'>
        <div class="LeafInner" :style="leafInnerStyle(leaf)">
          <div class="Screen" :class="{ Wide: screen.wide }">
            <div v-if="current === 0 && $slots.lead" class="Lead">
              <slot name="lead"></slot>
            </div>
            <div :ref="(element) => setColumns(element, leaf)" class="Columns">
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
                      <div class="Fit" :style="fitStyle(slice.id)">
                        <slot
                          name="item"
                          :item="byId.get(slice.id) as T"></slot>
                      </div>
                    </div>
                  </div>
                </template>

                <section
                  v-if="page.notes.length > 0"
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
      <div
        v-if="riffle.length > 0"
        class="Riffle"
        :class="{ Single: geometry.columns === 1 }"
        aria-hidden="true">
        <span
          v-for="leaf of riffle"
          :key="leaf.id"
          class="Flip"
          :class="leaf.direction"
          :style="{ animationDuration: `${RIFFLE_MS}ms` }"
          @animationend="landed(leaf.id)"></span>
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
  display: flex;
  height: 100%;
}

/*
 * A leaf is a page of the paper: opaque, so that a leaf turning over another hides
 * what is under it, and clipped at the spine.
 */
.Leaf {
  position: relative;
  flex: none;
  height: 100%;
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

/*
 * The riffle: blank leaves flipping over the spread while the reader scrolls. On
 * a spread a leaf goes from one page over the spine onto the other; on a phone it
 * swings off its left edge. It is over the pages and never in the way of a click.
 */
.Riffle {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  perspective: 190vw;
}

.Riffle.Single {
  perspective: 520vw;
}

.Flip {
  position: absolute;
  inset-block: 0;
  width: 50%;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background:
    repeating-linear-gradient(
      to bottom,
      transparent 0 0.9rem,
      color-mix(in oklab, var(--ink) 9%, transparent) 0.9rem 1rem
    ),
    var(--paper);
  background-clip: content-box, border-box;
  padding: 8% 9%;
  box-shadow: 0 0 2.5rem color-mix(in oklab, #000 35%, transparent);
  opacity: 0.86;
  backface-visibility: visible;
  animation: 300ms cubic-bezier(0.4, 0.1, 0.6, 0.95) both;
}

.Flip.forward {
  left: 50%;
  transform-origin: left center;
  animation-name: flip-forward;
}

.Flip.back {
  left: 0;
  transform-origin: right center;
  animation-name: flip-back;
}

.Riffle.Single .Flip {
  left: 0;
  width: 100%;
  transform-origin: left center;
}

.Riffle.Single .Flip.forward {
  animation-name: swing-off;
}

.Riffle.Single .Flip.back {
  animation-name: swing-on;
}

@keyframes flip-forward {
  from {
    transform: rotateY(0deg);
  }
  50% {
    filter: brightness(var(--turn-dim));
  }
  to {
    transform: rotateY(-180deg);
  }
}

@keyframes flip-back {
  from {
    transform: rotateY(0deg);
  }
  50% {
    filter: brightness(var(--turn-dim));
  }
  to {
    transform: rotateY(180deg);
  }
}

@keyframes swing-off {
  from {
    transform: rotateY(0deg);
  }
  to {
    transform: rotateY(-92deg);
    filter: brightness(var(--turn-dim));
  }
}

@keyframes swing-on {
  from {
    transform: rotateY(-92deg);
    filter: brightness(var(--turn-dim));
  }
  to {
    transform: rotateY(0deg);
  }
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
