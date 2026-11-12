/**
 * The pager, as a machine: where the reader is.
 *
 *   measuring  the blocks are being measured; there are no screens yet
 *   resting    a screen is showing
 *
 * There is no "turning" state, and that is the point. Asking for a screen shows
 * it: the state changes in the same step as the ask, whether the ask is a key, a
 * click, a notch of the wheel or the hundredth notch of a spin. What is drawn over
 * the change, a leaf turning, is decoration that `pager-flip.ts` plays on its own;
 * nothing here waits for it and nothing it does can hold a page back.
 *
 * It is a pure reducer: `Pager.vue` holds the state and sends it events.
 */

export type PagerPhase = "measuring" | "resting"

export interface PagerState {
	readonly phase: PagerPhase
	/** The screen showing, counted from zero. */
	readonly current: number
}

export type PagerEvent =
	/** The blocks changed: measure again from the first screen. */
	| { readonly type: "RESET" }
	/** The layout is done (or redone after a resize) and the reader is on `screen`. */
	| { readonly type: "LAID_OUT"; readonly screen: number }
	/** Go to one screen. */
	| { readonly type: "ASK"; readonly screen: number; readonly total: number }
	/** Go `delta` screens on. */
	| { readonly type: "STEP"; readonly delta: number; readonly total: number }

export const PAGER_START: PagerState = { phase: "measuring", current: 0 }

const clamp = (screen: number, total: number): number => Math.max(0, Math.min(screen, total - 1))

export const pagerStep = (state: PagerState, event: PagerEvent): PagerState => {
	switch (event.type) {
		case "RESET":
			return PAGER_START
		case "LAID_OUT":
			return { phase: "resting", current: event.screen }
		case "ASK":
			return state.phase === "measuring"
				? state
				: { ...state, current: clamp(event.screen, event.total) }
		case "STEP":
			return state.phase === "measuring"
				? state
				: { ...state, current: clamp(state.current + event.delta, event.total) }
	}
}
