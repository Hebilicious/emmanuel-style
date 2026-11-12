/**
 * The pager, as a machine: where the reader is, where they asked to be, and what
 * the pager is doing about it.
 *
 *   measuring  the blocks are being measured; there are no screens to turn yet
 *   resting    a screen is showing and nothing is asked for
 *   turning    a turn is running, to the screen asked for
 *
 * `current` is the screen showing and `target` the one asked for. Where the reader
 * is going is always worked out first, and the animation follows from it, never
 * the other way round: an animation does not hold a page back.
 *
 *   one ask at rest      one turn, of one leaf, to the screen asked for, however
 *                        far it is
 *   an ask while a leaf  the reader is scrolling: a spun wheel, a held key. The
 *   is in the air, or    screen asked for is shown at once (`JUMP`), and what
 *   hard on the last     plays over it is a riffle of leaves in that direction,
 *                        for as long as the asks keep coming
 *
 * It is a pure reducer: `Pager.vue` holds the state, sends it events, and runs the
 * View Transition that `nextTurn` asks for.
 */

export type PagerPhase = "measuring" | "resting" | "turning"

export interface PagerState {
	readonly phase: PagerPhase
	/** The screen showing, counted from zero. */
	readonly current: number
	/** The screen asked for. */
	readonly target: number
}

export type PagerEvent =
	/** The blocks changed: measure again from the first screen. */
	| { readonly type: "RESET" }
	/** The layout is done (or redone after a resize) and the reader is on `screen`. */
	| { readonly type: "LAID_OUT"; readonly screen: number }
	/** Go to one screen. */
	| { readonly type: "ASK"; readonly screen: number; readonly total: number }
	/** Go `delta` screens on from the one already asked for. */
	| { readonly type: "STEP"; readonly delta: number; readonly total: number }
	/** Show the screen asked for at once, without a turn: the reader is scrolling. */
	| { readonly type: "JUMP" }
	/** The first turn of a run is starting. */
	| { readonly type: "BEGIN" }
	/** A turn has put `screen` on show. */
	| { readonly type: "LANDED"; readonly screen: number }
	/** The screen asked for is showing: no turn is left to run. */
	| { readonly type: "SETTLE" }

export const PAGER_START: PagerState = { phase: "measuring", current: 0, target: 0 }

const clamp = (screen: number, total: number): number => Math.max(0, Math.min(screen, total - 1))

export const pagerStep = (state: PagerState, event: PagerEvent): PagerState => {
	switch (event.type) {
		case "RESET":
			return PAGER_START
		case "LAID_OUT":
			// A layout redone under a running turn keeps it running; it ends at once, on target.
			return {
				phase: state.phase === "turning" ? "turning" : "resting",
				current: event.screen,
				target: event.screen
			}
		case "ASK":
			if (state.phase === "measuring") return state
			return { ...state, target: clamp(event.screen, event.total) }
		case "STEP": {
			if (state.phase === "measuring") return state
			const from = state.phase === "turning" ? state.target : state.current
			return { ...state, target: clamp(from + event.delta, event.total) }
		}
		case "JUMP":
			return state.phase === "measuring" ? state : { ...state, current: state.target }
		case "BEGIN":
			return state.phase === "resting" ? { ...state, phase: "turning" } : state
		case "LANDED":
			return state.phase === "turning" ? { ...state, current: event.screen } : state
		case "SETTLE":
			return state.phase === "turning" ? { ...state, phase: "resting" } : state
	}
}

export interface NextTurn {
	/** The screen this turn puts on show. */
	readonly to: number
	readonly direction: "forward" | "back"
}

/** The turn to run next, or `null` when the screen asked for is showing. */
export const nextTurn = (state: PagerState): NextTurn | null =>
	state.target === state.current
		? null
		: { to: state.target, direction: state.target > state.current ? "forward" : "back" }

/** Asks closer together than this, in milliseconds, are a spin of the wheel or a held key. */
export const BLITZ_GAP = 150

/**
 * Whether an ask is scrolling rather than a turn: a leaf was already in the air
 * when it came (`before` is the state it found), or it came hard on the last one.
 */
export const scrolling = (before: PagerState, sinceLastAsk: number): boolean =>
	before.phase === "turning" || sinceLastAsk < BLITZ_GAP
