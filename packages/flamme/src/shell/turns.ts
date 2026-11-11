/**
 * Page turns, as View Transitions.
 *
 * Everything that moves the reader through the paper is a page turn: the next
 * spread of an article, another section, an article opened from the index. The
 * turn is one View Transition over the leaves of the spread (`leaf-left` and
 * `leaf-right`, or `leaf-single` on a phone, named by the pager), and its direction
 * decides which leaf lifts: going forward the right-hand page lifts and folds over
 * the spine, going back the left-hand page does. The keyframes are in
 * `styles/turns.css`, keyed on `data-turn` on the root element.
 *
 * One transition runs at a time. Starting a second one skips the first, which is
 * what made quick turns look broken, so a caller that turns often (the pager)
 * waits for `finished` before it starts the next.
 *
 * Opening a project is not a turn: the pages stay where they are and the card is
 * lifted off the page into a dialog (`zoom`). The card and the dialog carry the
 * same transition name, so the one grows into the other.
 *
 * Changing the theme is not a turn either: the other paper floods the screen from
 * the switch (`theme`).
 */

import { createMachine, type Machine } from "./machine.js"

export type Direction = "forward" | "back"
export type TurnKind = "page" | "route" | "zoom" | "theme"
/** What a zoom does: open a card into its dialog, close it back, or swap one project for the next or the one before. */
export type Zoom = "open" | "close" | "swap" | "swap-back"

interface ViewTransitionLike {
	readonly finished: Promise<void>
	readonly ready: Promise<void>
	readonly updateCallbackDone: Promise<void>
	skipTransition(): void
}

type ViewTransitionDocument = Document & {
	startViewTransition?: (update: () => Promise<void> | void) => ViewTransitionLike
}

export const reducedMotion = (): boolean =>
	window.matchMedia("(prefers-reduced-motion: reduce)").matches

export const canTurn = (): boolean =>
	typeof (document as ViewTransitionDocument).startViewTransition === "function"

/**
 * What the paper is doing: lying still, or in one of the three transitions.
 *
 * One transition runs at a time, so this is one machine for the whole shell. A
 * `START` while another kind is running overtakes it (a section chosen while a page
 * is still turning); the overtaken transition's `END` then belongs to nobody and is
 * ignored, which is what `owner` is for.
 */
export type TurnState = "idle" | TurnKind

export type TurnEvent =
	| {
			readonly type: "START"
			readonly kind: TurnKind
			readonly direction: Direction | Zoom
			readonly quick: boolean
			readonly owner: object
	  }
	| { readonly type: "END"; readonly owner: object }

let owner: object | null = null
const start = (event: Extract<TurnEvent, { type: "START" }>): TurnState => {
	owner = event.owner
	return event.kind
}
const end = (event: Extract<TurnEvent, { type: "END" }>): TurnState | undefined => {
	if (event.owner !== owner) return undefined
	owner = null
	return "idle"
}

export const turning: Machine<TurnState, TurnEvent> = createMachine<TurnState, TurnEvent>("idle", {
	idle: { START: start },
	page: { START: start, END: end },
	route: { START: start, END: end },
	zoom: { START: start, END: end },
	theme: { START: start, END: end }
})

/**
 * How long each kind of turn takes, and how it is paced. Kept here, and handed to
 * the stylesheet as custom properties when a turn starts, so that the press, which
 * draws the fold's shading on its canvas, runs on exactly the same clock as the
 * leaves the browser is moving.
 */
export const TURN_MS: Readonly<Record<TurnKind, number>> = {
	page: 640,
	route: 780,
	zoom: 560,
	theme: 900
}
/** A turn with more waiting behind it. */
export const QUICK_MS = 300
/** A page is pulled over quickly and laid down gently. */
export const TURN_EASE = [0.33, 0.06, 0.18, 1] as const

/**
 * A CSS `cubic-bezier(x1, y1, x2, y2)` as a function of time, 0 to 1: the same
 * curve the stylesheet is given, solved the way a browser solves it.
 */
export const bezier = (x1: number, y1: number, x2: number, y2: number) => {
	const curve = (a: number, b: number, t: number) =>
		3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t
	return (x: number): number => {
		if (x <= 0) return 0
		if (x >= 1) return 1
		let low = 0
		let high = 1
		for (let step = 0; step < 24; step += 1) {
			const middle = (low + high) / 2
			if (curve(x1, x2, middle) < x) low = middle
			else high = middle
		}
		return curve(y1, y2, (low + high) / 2)
	}
}
const pace = bezier(...TURN_EASE)

/** The turn that is running, for whoever draws along with it (the press). */
export interface TurnInfo {
	readonly kind: TurnKind
	readonly direction: Direction | Zoom
	readonly quick: boolean
	/** How long it lasts, in milliseconds. */
	readonly duration: number
	/**
	 * `performance.now()` when the leaves started to move, or `null` while the new
	 * page is still being laid out and nothing moves yet.
	 */
	at: number | null
	/** The browser's own animation of a leaf, once it has one: the clock to follow. */
	leaf?: Animation | null
}

/** The keyframes that move a leaf (`styles/turns.css`): any of them tells the time. */
const LEAF_KEYFRAMES = new Set([
	"fold-away-left",
	"fold-away-right",
	"back-from-right",
	"back-from-left",
	"lay-from-left"
])

/**
 * How far along the running turn is, 0 to 1, as the stylesheet's easing paces it.
 *
 * The browser starts the leaves a frame or more after it says the transition is
 * ready, so the time is read from its own animation of a leaf when there is one:
 * the shading the press draws is then on the fold, not near it.
 */
export const turnProgress = (turn: TurnInfo, now: number): number => {
	if (turn.at === null) return 0
	if (turn.leaf === undefined || turn.leaf === null) {
		turn.leaf =
			document
				.getAnimations()
				.find(
					(animation) =>
						animation instanceof CSSAnimation && LEAF_KEYFRAMES.has(animation.animationName)
				) ?? null
	}
	const time = turn.leaf?.currentTime
	if (typeof time === "number") return pace(time / turn.duration)
	// No leaf is moving yet: the fold has not started.
	return turn.leaf === null && now - turn.at < 250 ? 0 : pace((now - turn.at) / turn.duration)
}
let info: TurnInfo | null = null
export const currentTurn = (): TurnInfo | null => (turning.state === "idle" ? null : info)

/** The root element says what is turning, for `styles/turns.css` to key on. */
const mark = (running: TurnInfo | null): void => {
	const data = document.documentElement.dataset
	const style = document.documentElement.style
	if (running !== null) {
		style.setProperty("--turn-duration", `${running.duration}ms`)
		style.setProperty("--turn-ease", `cubic-bezier(${TURN_EASE.join(", ")})`)
	}
	if (running === null) {
		delete data["turn"]
		delete data["turnKind"]
		delete data["turnQuick"]
		return
	}
	data["turn"] = running.direction
	data["turnKind"] = running.kind
	if (running.quick) data["turnQuick"] = ""
	else delete data["turnQuick"]
}

/**
 * Run `update` as a page turn and resolve once the turn has finished.
 *
 * Without the API, or with reduced motion asked for, the update runs at once: the
 * reader still gets the page, only without the animation.
 */
export const turn = async (
	direction: Direction | Zoom,
	update: () => Promise<void> | void,
	kind: TurnKind = "page",
	/** Riffled: more turns are waiting behind this one, so it is quicker. */
	quick = false
): Promise<void> => {
	const doc = document as ViewTransitionDocument
	if (doc.startViewTransition === undefined || reducedMotion()) {
		await update()
		return
	}
	const token = {}
	const running: TurnInfo = {
		kind,
		direction,
		quick,
		duration: quick ? QUICK_MS : TURN_MS[kind],
		at: null
	}
	info = running
	mark(info)
	turning.send({ type: "START", kind, direction, quick, owner: token })
	const transition = doc.startViewTransition(update)
	// The leaves start to move when the new page has been captured, not before.
	// A transition overtaken by the next one rejects these; the page is updated either way.
	transition.ready
		.then(() => {
			running.at = performance.now()
		})
		.catch(() => undefined)
	transition.updateCallbackDone.catch(() => undefined)
	try {
		await transition.finished
	} catch {
		// A transition that cannot start (the update threw, or it was skipped) still
		// leaves the page updated; nothing else to do.
	} finally {
		if (turning.send({ type: "END", owner: token }) === "idle") mark(null)
	}
}

/** Run `update` as a zoom: a card lifted into its dialog, or set back down. */
export const zoom = (mode: Zoom, update: () => Promise<void> | void): Promise<void> =>
	turn(mode, update, "zoom")

/** Where a path sits in the paper, for the direction of a turn between two routes. */
const SECTION_ORDER = ["/", "/library", "/blog", "/experience", "/skills"]

export const rankOf = (path: string): number => {
	const clean = path.replace(/\/+$/, "") || "/"
	const section = SECTION_ORDER.reduce(
		(best, prefix, index) => (prefix !== "/" && clean.startsWith(prefix) ? index : best),
		0
	)
	const base = SECTION_ORDER[section] ?? "/"
	// A page inside a section (an article, a project) comes after the section's front.
	return clean === base ? section : section + 0.5
}

export const directionOf = (from: string, to: string): Direction =>
	rankOf(to) < rankOf(from) ? "back" : "forward"
