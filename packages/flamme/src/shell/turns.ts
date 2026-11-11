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
/** What a zoom does: open a card into its dialog, close it back, or swap one project for the next. */
export type Zoom = "open" | "close" | "swap"

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

/** The turn that is running, for whoever draws along with it (the press). */
export interface TurnInfo {
	readonly kind: TurnKind
	readonly direction: Direction | Zoom
	readonly quick: boolean
	/** `performance.now()` when it started. */
	readonly at: number
}
let info: TurnInfo | null = null
export const currentTurn = (): TurnInfo | null => (turning.state === "idle" ? null : info)

/** The root element says what is turning, for `styles/turns.css` to key on. */
const mark = (running: TurnInfo | null): void => {
	const data = document.documentElement.dataset
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
	info = { kind, direction, quick, at: performance.now() }
	mark(info)
	turning.send({ type: "START", kind, direction, quick, owner: token })
	const transition = doc.startViewTransition(update)
	// A transition overtaken by the next one rejects these; the page is updated either way.
	transition.ready.catch(() => undefined)
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
