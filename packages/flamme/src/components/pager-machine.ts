/**
 * The pager, as a machine: where the reader is, where they asked to be, and what
 * the pager is doing about it.
 *
 *   measuring  the blocks are being measured; there are no screens to turn yet
 *   resting    a screen is showing and nothing is asked for
 *   turning    turns are running, one at a time, until the screen asked for shows
 *
 * `current` is the screen showing and `target` the one asked for. A reader can ask
 * while a turn runs (a second notch of the wheel, `n` twice): the target moves and
 * the turns carry on until they reach it. Asks are counted from the target while
 * turning, so two quick presses are two pages, and a target further away than
 * `QUEUE` is reached in one turn rather than by riffling through every page.
 *
 * It is a pure reducer: `Pager.vue` holds the state, sends it events, and runs the
 * View Transitions that `nextTurn` asks for.
 */

/** How far ahead of the page showing the reader can ask, a turn per step. */
export const QUEUE = 6

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
	/** How many more turns wait behind this one: the more, the quicker it is. */
	readonly behind: number
}

/** The turn to run next, or `null` when the screen asked for is showing. */
export const nextTurn = (state: PagerState): NextTurn | null => {
	const distance = state.target - state.current
	if (distance === 0) return null
	const to = Math.abs(distance) > QUEUE ? state.target : state.current + Math.sign(distance)
	return {
		to,
		direction: to > state.current ? "forward" : "back",
		behind: Math.abs(state.target - to)
	}
}

/** Whether the queue has room for one more turn: a spin of the wheel is not stored up. */
export const hasRoom = (state: PagerState): boolean =>
	Math.abs(state.target - state.current) < QUEUE
