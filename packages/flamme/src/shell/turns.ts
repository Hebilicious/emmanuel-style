/**
 * The turns that are View Transitions.
 *
 * Opening a project or a figure is a zoom: the pages stay where they are and the
 * card is lifted off the page into a dialog. The card and the dialog carry the
 * same transition name, so the one grows into the other. Changing the theme floods
 * the screen with the other paper from the switch (`theme`). The keyframes are in
 * `styles/turns.css`, keyed on `data-turn` and `data-turn-kind` on the root element.
 *
 * Turning pages is not here: inside a section and between sections the leaves
 * themselves are turned (`components/pager-flip.ts`, `shell/route-turns.ts`),
 * which never holds the new page back. This file keeps what those share with the
 * View Transitions: whether the reader asked for less motion, the direction of
 * a move through the paper, and the machine that says a transition is running,
 * for the pager to put its leaves down before one photographs the page.
 *
 * One transition runs at a time. Starting a second one skips the first.
 */

import { createMachine, type Machine } from "./machine.js"

export type Direction = "forward" | "back"
export type TurnKind = "zoom" | "theme"
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

/**
 * What the paper is doing: lying still, or in one of the transitions.
 *
 * One transition runs at a time, so this is one machine for the whole shell. A
 * `START` while another is running overtakes it (the theme changed while a project
 * opens); the overtaken transition's `END` then belongs to nobody and is ignored,
 * which is what `owner` is for.
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
	zoom: { START: start, END: end },
	theme: { START: start, END: end }
})

/** How long each kind of transition takes, handed to the stylesheet as `--turn-duration`. */
export const TURN_MS: Readonly<Record<TurnKind, number>> = {
	zoom: 280,
	theme: 460
}

/** The root element says what is running, for `styles/turns.css` to key on. */
const mark = (kind: TurnKind | null, direction?: Direction | Zoom): void => {
	const data = document.documentElement.dataset
	if (kind === null) {
		delete data["turn"]
		delete data["turnKind"]
		return
	}
	document.documentElement.style.setProperty("--turn-duration", `${TURN_MS[kind]}ms`)
	data["turn"] = direction
	data["turnKind"] = kind
}

/**
 * Run `update` as a View Transition of `kind` and resolve once it has finished.
 *
 * Without the API, or with reduced motion asked for, the update runs at once: the
 * reader still gets the change, only without the animation.
 */
export const turn = async (
	direction: Direction | Zoom,
	update: () => Promise<void> | void,
	kind: TurnKind
): Promise<void> => {
	const doc = document as ViewTransitionDocument
	if (doc.startViewTransition === undefined || reducedMotion()) {
		await update()
		return
	}
	const token = {}
	mark(kind, direction)
	turning.send({ type: "START", kind, direction, owner: token })
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

/** Where a path sits in the paper, for the direction of a turn between two routes (`route-turns.ts`). */
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
