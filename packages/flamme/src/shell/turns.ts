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
	page: 400,
	route: 460,
	zoom: 340,
	theme: 560
}
/** A page is pulled over quickly and laid down gently. */
export const TURN_EASE = [0.33, 0.06, 0.18, 1] as const
/**
 * A leaf of a spread turns through half a circle in two halves: it is lifted from
 * the page to upright, picking up speed, and laid from upright onto the other
 * page, losing it. The two curves meet at the same speed, so it is one movement.
 */
export const TURN_LIFT = [0.45, 0, 0.85, 0.7] as const
export const TURN_LAND = [0.15, 0.3, 0.45, 1] as const

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
const lift = bezier(...TURN_LIFT)
const land = bezier(...TURN_LAND)

/** The turn that is running, for whoever draws along with it (the press). */
export interface TurnInfo {
	readonly kind: TurnKind
	readonly direction: Direction | Zoom
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
	"lift-right",
	"lift-left",
	"land-left",
	"land-right",
	"swing-away",
	"swing-over"
])

/**
 * How much of the running turn's time has passed, 0 to 1.
 *
 * The browser starts the leaves a frame or more after it says the transition is
 * ready, so the time is read from
 * the browser's own animation of a leaf when there is one: what the press draws is
 * then on the leaf, not near it.
 */
const turnTime = (turn: TurnInfo, now: number): number => {
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
	if (typeof time === "number") return Math.max(0, Math.min(time / turn.duration, 1))
	// No leaf is moving yet: the turn has not started.
	if (turn.leaf === null && now - turn.at < 250) return 0
	return Math.max(0, Math.min((now - turn.at) / turn.duration, 1))
}

/** How far along the running turn is, 0 to 1, as the stylesheet's easing paces it. */
export const turnProgress = (turn: TurnInfo, now: number): number => pace(turnTime(turn, now))

/**
 * The angle the turning leaf of a spread has come through, in degrees: 0 flat on
 * the page it leaves, 90 upright over the spine, 180 flat on the page it lands on.
 * The same two curves as the keyframes in `styles/turns.css`.
 */
export const leafAngle = (turn: TurnInfo, now: number): number => {
	const time = turnTime(turn, now)
	return time < 0.5 ? 90 * lift(time * 2) : 90 + 90 * land(time * 2 - 1)
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
		style.setProperty("--leaf-lift", `cubic-bezier(${TURN_LIFT.join(", ")})`)
		style.setProperty("--leaf-land", `cubic-bezier(${TURN_LAND.join(", ")})`)
	}
	if (running === null) {
		delete data["turn"]
		delete data["turnKind"]
		return
	}
	data["turn"] = running.direction
	data["turnKind"] = running.kind
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
	kind: TurnKind = "page"
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
		duration: TURN_MS[kind],
		at: null
	}
	info = running
	mark(info)
	turning.send({ type: "START", kind, direction, owner: token })
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
