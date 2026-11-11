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
import { cursorBox, shown } from "../shell/cursor.js"
import { useShell } from "../shell/shell.js"
import { currentTurn, reducedMotion } from "../shell/turns.js"

const shell = useShell()
const canvas = ref<HTMLCanvasElement | null>(null)

/** How long each kind of turn lasts, as `styles/turns.css` sets them. */
const DURATION = { page: 720, route: 820 } as const
const QUICK = 380
/** How long the print head takes to cross the edition when the press starts. */
const INTRO = 1300
let startedAt = Number.NEGATIVE_INFINITY

const touch = window.matchMedia("(hover: none) and (pointer: coarse)")

let press: Press | null = null
let frame = 0
let stopped = false
const pointer = { x: 0, y: 0, over: false }

/* ------------------------------------------------------------ the theme's colours */

let probe: HTMLElement | null = null
let pixel: CanvasRenderingContext2D | null = null
let coloursFor = ""
let ink: Rgb = [1, 1, 1]
let accent: Rgb = [0.3, 0.8, 0.8]

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
			src: element.dataset["relief"] ?? ""
		}
	}
	return null
}

const turnOf = (now: number): PressFrame["turn"] => {
	const turn = currentTurn()
	// The first thing the press does is run the print head across the edition once.
	if (now - startedAt < INTRO) {
		return { forward: false, progress: (now - startedAt) / INTRO }
	}
	if (turn === null || turn.kind === "zoom" || turn.kind === "theme")
		return null
	const length = turn.quick ? QUICK : DURATION[turn.kind]
	// The free edge of a leaf turning about the spine crosses the page as a cosine does.
	const along = Math.min(1, (now - turn.at) / length)
	return {
		forward: turn.direction !== "back",
		progress: 0.5 - 0.5 * Math.cos(Math.PI * along)
	}
}

const measure = (now: number): PressFrame => {
	readColours()
	const pane = document.querySelector<HTMLElement>(".Page .Pager")
	return {
		width: window.innerWidth,
		height: window.innerHeight,
		dark: shell.theme === "dark",
		ink,
		accent,
		pointer:
			pointer.over && shell.mouse ? { x: pointer.x, y: pointer.y } : null,
		// A touch screen has no reading cursor to light.
		lamp: touch.matches ? null : boxOf(cursorBox()),
		pane: pane === null ? null : boxOf(pane.getBoundingClientRect()),
		relief: reliefOf(),
		turn: turnOf(now)
	}
}

const tick = (now: number) => {
	if (stopped || press === null) return
	frame = requestAnimationFrame(tick)
	if (document.hidden) return
	press.draw(measure(now), now / 1000)
	const root = document.documentElement
	if (press.reliefShown) root.dataset["reliefShown"] = ""
	else delete root.dataset["reliefShown"]
}

const onPointerMove = (event: PointerEvent) => {
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
	document.documentElement.addEventListener("pointerleave", onPointerLeave)
	startedAt = performance.now()
	frame = requestAnimationFrame(tick)
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
	document.documentElement.removeEventListener("pointerleave", onPointerLeave)
	delete document.documentElement.dataset["press"]
	delete document.documentElement.dataset["reliefShown"]
	probe?.remove()
	press?.dispose()
	press = null
})
</script>

<template>
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
</style>
