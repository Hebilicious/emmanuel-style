<script setup lang="ts">
/**
 * The press's canvas, and the part of it that looks at the page.
 *
 * The engine (`press/engine.ts`) draws; this measures. Every frame it reads where
 * the reading cursor is, where the pointer is, where the pane and the portrait's
 * plate are and whether a page is turning, and hands that to the engine. The
 * engine and three.js are a chunk of their own, loaded once the page is up and
 * idle, so the paper is readable before the press starts.
 *
 * It does not start at all for a reader who asked for reduced motion, or where
 * there is no WebGL; the page is complete without it. While it runs the root
 * element carries `data-press`, and `data-relief-shown` while the portrait is drawn
 * in relief, so the flat portrait under it can step aside.
 */
import { onBeforeUnmount, onMounted, ref } from "vue"
import type { Box, Press, PressFrame, Rgb } from "../press/engine.js"
import { deckOf } from "../press/deck.js"
import type { Ink } from "../press/ink.js"
import { cursorBox, shown } from "../shell/cursor.js"
import { useShell } from "../shell/shell.js"
import {
	currentTurn,
	leafAngle,
	reducedMotion,
	turnProgress
} from "../shell/turns.js"

const shell = useShell()
const canvas = ref<HTMLCanvasElement | null>(null)
const inkCanvas = ref<HTMLCanvasElement | null>(null)

/** How long after the reader's last move the press slows down. */
const CALM_AFTER = 2500
/** How long the print head takes to cross the edition when the press starts. */
const INTRO = 1300
let startedAt = Number.NEGATIVE_INFINITY

const touch = window.matchMedia("(hover: none) and (pointer: coarse)")

let press: Press | null = null
let simulation: Ink | null = null
let frame = 0
let stopped = false
const pointer = { x: 0, y: 0, over: false }

/* ------------------------------------------------------------ the theme's colours */

let probe: HTMLElement | null = null
let pixel: CanvasRenderingContext2D | null = null
let coloursFor = ""
let ink: Rgb = [1, 1, 1]
let accent: Rgb = [0.3, 0.8, 0.8]
let paper: Rgb = [0, 0, 0]

/** A CSS colour as sRGB, whatever space the stylesheet wrote it in. */
const rgbOf = (name: string): Rgb => {
	if (probe === null || pixel === null) return [1, 1, 1]
	probe.style.color = `var(${name})`
	pixel.clearRect(0, 0, 1, 1)
	pixel.fillStyle = getComputedStyle(probe).color
	pixel.fillRect(0, 0, 1, 1)
	const [r = 255, g = 255, b = 255] = pixel.getImageData(0, 0, 1, 1).data
	return [r / 255, g / 255, b / 255]
}

const readColours = () => {
	if (coloursFor === shell.theme) return
	coloursFor = shell.theme
	ink = rgbOf("--ink")
	accent = rgbOf("--accent")
	paper = rgbOf("--paper")
}

/* --------------------------------------------------------------- the page */

const boxOf = (rect: DOMRect | null): Box | null =>
	rect === null
		? null
		: { x: rect.left, y: rect.top, w: rect.width, h: rect.height }

/** The portrait's plate: the copy of it that shows, on the leaf it is on. */
const reliefOf = (): PressFrame["relief"] => {
	// A dialog or the prompt over the page covers the plate.
	if (shell.dialog !== null) return null
	for (const element of document.querySelectorAll<HTMLElement>(
		".Page [data-relief]"
	)) {
		const rect = shown(element)
		const whole = element.getBoundingClientRect()
		// A plate cut by the spine or the edge of a page is left flat.
		if (
			rect === null ||
			rect.width < whole.width - 1 ||
			rect.height < whole.height - 1
		)
			continue
		return {
			x: rect.left,
			y: rect.top,
			w: rect.width,
			h: rect.height,
			src: element.dataset["relief"] ?? "",
			model: element.hasAttribute("data-relief-model")
		}
	}
	return null
}

/** The deck's stage on show, with the strip of plates the page drew for it. */
const deckOfPage = (): PressFrame["deck"] => {
	if (shell.dialog !== null) return null
	for (const stage of document.querySelectorAll<HTMLElement>(
		".Page [data-deck]"
	)) {
		const source = deckOf(stage)
		const rect = shown(stage)
		if (source === undefined || rect === null) continue
		if (rect.width < stage.getBoundingClientRect().width - 1) continue
		return {
			box: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
			atlas: source.atlas,
			tiles: source.tiles,
			version: source.version,
			places: (stage.dataset["deckPlaces"] ?? "").split(" ").map(Number)
		}
	}
	return null
}

/**
 * The turn in progress, and where its leaf is.
 *
 * A turning leaf is hinged on the spine of a spread, or on the left edge of a
 * phone's page, and turns in depth (`styles/turns.css`). The press draws the
 * shadow it throws and the light on its edge, so the hinge, the free edge as the
 * reader sees it and how far the leaf stands off the page are worked out here,
 * from the same clock and the same perspective the stylesheet uses.
 */
const TURN_DEPTH = { spread: 1.9, single: 5.2 }

const turnOf = (now: number, pane: Box | null): PressFrame["turn"] => {
	const turn = currentTurn()
	// The first thing the press does is run the print head across the edition once.
	if (now - startedAt < INTRO) {
		return { forward: false, progress: (now - startedAt) / INTRO, fold: null }
	}
	if (turn === null || turn.kind === "zoom" || turn.kind === "theme")
		return null
	const forward = turn.direction !== "back"
	const progress = turnProgress(turn, now)
	if (pane === null) return { forward, progress, fold: null }
	const spread =
		document.querySelector(".Page .Pager")?.getAttribute("data-columns") !== "1"
	const page = spread ? pane.w / 2 : pane.w
	const depth =
		window.innerWidth * (spread ? TURN_DEPTH.spread : TURN_DEPTH.single)
	/** How far from its hinge the free edge of a leaf is seen, `degrees` off the page. */
	const seen = (degrees: number): number => {
		const angle = (degrees * Math.PI) / 180
		return (page * Math.cos(angle)) / (1 - (page * Math.sin(angle)) / depth)
	}
	if (!spread) {
		// One page, hinged on its left edge: it swings away going forward, down going back.
		const degrees = 90 * (forward ? progress : 1 - progress)
		return {
			forward,
			progress,
			fold: {
				x: pane.x,
				edge: pane.x + seen(degrees),
				lift: Math.sin((degrees * Math.PI) / 180)
			}
		}
	}
	const spine = pane.x + pane.w / 2
	const degrees = leafAngle(turn, now)
	// Before upright the leaf is on the side it leaves, after it on the side it lands on.
	const leaving = degrees < 90
	const off = leaving ? degrees : 180 - degrees
	const right = forward === leaving
	return {
		forward,
		progress,
		fold: {
			x: spine,
			edge: right ? spine + seen(off) : spine - seen(off),
			lift: Math.sin((off * Math.PI) / 180)
		}
	}
}

/*
 * Where the pager is. Asking an element for its box makes the browser bring the
 * whole page's style and layout up to date there and then, and this is asked on
 * every frame; while anything on the page was changing, that was several
 * milliseconds a frame. The pager only moves when the window is resized or the
 * route changes, so its box is read a few times a second at most, and at once
 * after a resize.
 */
const PANE_EVERY = 400
let paneCache: Box | null = null
let paneAt = Number.NEGATIVE_INFINITY
const paneBox = (now: number): Box | null => {
	if (now - paneAt < PANE_EVERY) return paneCache
	paneAt = now
	const pager = document.querySelector<HTMLElement>(".Page .Pager")
	paneCache = pager === null ? null : boxOf(pager.getBoundingClientRect())
	return paneCache
}

/*
 * The same goes for the reading cursor, the portrait and the deck: they move when
 * the reader does something, not sixty times a second, and the press eases toward
 * where they are, so they are looked for ten times a second.
 */
const BOXES_EVERY = 100
let boxes: Pick<PressFrame, "lamp" | "relief" | "deck"> = {
	lamp: null,
	relief: null,
	deck: null
}
let boxesAt = Number.NEGATIVE_INFINITY
const pageBoxes = (now: number) => {
	if (now - boxesAt < BOXES_EVERY) return boxes
	boxesAt = now
	boxes = {
		// A touch screen has no reading cursor to light.
		lamp: touch.matches ? null : boxOf(cursorBox()),
		relief: reliefOf(),
		deck: deckOfPage()
	}
	return boxes
}
const onResize = () => {
	paneAt = Number.NEGATIVE_INFINITY
	boxesAt = Number.NEGATIVE_INFINITY
}

const measure = (now: number): PressFrame => {
	readColours()
	const pane = paneBox(now)
	const page = pageBoxes(now)
	return {
		width: window.innerWidth,
		height: window.innerHeight,
		dark: shell.theme === "dark",
		ink,
		accent,
		pointer:
			pointer.over && shell.mouse ? { x: pointer.x, y: pointer.y } : null,
		// A touch screen has no reading cursor to light.
		lamp: page.lamp,
		pane,
		paper,
		relief: page.relief,
		deck: page.deck,
		turn: turnOf(now, pane)
	}
}

/** When the reader last did something the press answers: moved the pointer, the cursor, a page. */
let stirredAt = 0
let lastLamp = ""
let odd = false

const tick = (now: number) => {
	if (stopped || press === null) return
	frame = requestAnimationFrame(tick)
	if (document.hidden) return
	const page = measure(now)
	const lamp = page.lamp === null ? "" : `${page.lamp.x},${page.lamp.y}`
	if (lamp !== lastLamp || page.turn !== null) stirredAt = now
	lastLamp = lamp
	// A sheet nobody is touching is drawn at half the rate: the drift reads the same.
	odd = !odd
	if (
		now - stirredAt > CALM_AFTER &&
		odd &&
		press.reliefShown === false &&
		!press.deckShown
	)
		return
	simulation?.draw(page, now / 1000)
	press.draw(page, now / 1000)
	flag("reliefShown", press.reliefShown)
	flag("deckGpu", press.deckShown)
}

/**
 * Say on the root element whether something is so, and only when it changes:
 * writing an attribute, even to the value it has, makes the browser work out the
 * style of the whole page again, and this is asked every frame.
 */
const flags = new Map<string, boolean>()
const flag = (name: string, on: boolean) => {
	if (flags.get(name) === on) return
	flags.set(name, on)
	if (on) document.documentElement.dataset[name] = ""
	else delete document.documentElement.dataset[name]
}

const onPointerMove = (event: PointerEvent) => {
	stirredAt = performance.now()
	if (event.pointerType === "touch") return
	pointer.x = event.clientX
	pointer.y = event.clientY
	pointer.over = true
}
const onPointerLeave = () => {
	pointer.over = false
}

const start = async () => {
	if (stopped || canvas.value === null || reducedMotion()) return
	// Asked on a scratch canvas first, so a browser without WebGL never fetches the engine.
	if (document.createElement("canvas").getContext("webgl2") === null) return
	const { createPress } = await import("../press/engine.js")
	if (stopped || canvas.value === null) return
	press = createPress(canvas.value)
	if (press === null) return
	probe = document.createElement("span")
	probe.style.display = "none"
	document.body.append(probe)
	pixel = document
		.createElement("canvas")
		.getContext("2d", { willReadFrequently: true })
	document.documentElement.dataset["press"] = ""
	window.addEventListener("pointermove", onPointerMove, { passive: true })
	window.addEventListener("resize", onResize, { passive: true })
	document.documentElement.addEventListener("pointerleave", onPointerLeave)
	startedAt = performance.now()
	frame = requestAnimationFrame(tick)

	// Where there is WebGPU the ink is a simulation of its own, and the press's motes rest.
	if (inkCanvas.value === null) return
	const { createInk } = await import("../press/ink.js")
	const made = await createInk(inkCanvas.value)
	if (stopped) {
		made?.dispose()
		return
	}
	simulation = made
	if (simulation !== null) {
		press.setMotes(false)
		document.documentElement.dataset["ink"] = "webgpu"
	}
}

onMounted(() => {
	// After the first paint and the first layout of the pager: the page comes first.
	const idle =
		window.requestIdleCallback ??
		((run: () => void) => window.setTimeout(run, 200))
	idle(() => void start())
})

onBeforeUnmount(() => {
	stopped = true
	cancelAnimationFrame(frame)
	window.removeEventListener("pointermove", onPointerMove)
	window.removeEventListener("resize", onResize)
	document.documentElement.removeEventListener("pointerleave", onPointerLeave)
	delete document.documentElement.dataset["press"]
	delete document.documentElement.dataset["reliefShown"]
	delete document.documentElement.dataset["ink"]
	delete document.documentElement.dataset["deckGpu"]
	probe?.remove()
	simulation?.dispose()
	simulation = null
	press?.dispose()
	press = null
})
</script>

<template>
  <canvas ref="inkCanvas" class="Press Ink" aria-hidden="true"></canvas>
  <canvas ref="canvas" class="Press" aria-hidden="true"></canvas>
</template>

<style scoped>
/*
 * Over everything, and never in the way: it takes no pointer events, and it is
 * named for the View Transitions so that it stays on top of a turning leaf and
 * keeps drawing while the leaf turns.
 */
.Press {
  position: fixed;
  inset: 0;
  z-index: 90;
  width: 100vw;
  height: 100dvh;
  pointer-events: none;
  view-transition-name: press;
}

/* The ink's own canvas, under the press's: a canvas has one context, and this one is WebGPU. */
.Ink {
  z-index: 89;
  view-transition-name: press-ink;
}
</style>
