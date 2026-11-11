/**
 * The wheel, as a machine: which of its events turn a page.
 *
 * A mouse wheel sends one event per notch, each the same large step; every notch
 * turns a page. A trackpad sends a stream: the flick itself, then its momentum,
 * small deltas that die away for a second or more. The stream is one gesture while
 * it has no pause longer than `GESTURE_GAP` and keeps its direction.
 *
 *   rest       nothing is happening; the next event starts a gesture
 *   notching   a mouse wheel: each notch turns a page
 *   gathering  a trackpad stream that has not travelled `WHEEL_START` pixels yet
 *   flicking   the stream has turned its page and the flick behind it is still
 *              speeding up or at its peak. Speeding up here is the same flick, not
 *              a second one, so nothing more turns
 *   coasting   the flick has slowed (below `DECAY` of its peak): what follows is
 *              momentum, which must not turn a page. A new flick inside the stream
 *              is told from momentum by its shape: momentum only slows down, a
 *              flick speeds up, so a delta well above the recent ones
 *              (`ACCELERATION`) turns again, and the stream is flicking once more.
 *
 * The step is a pure function of the state and one event, so the shapes of real
 * wheels and trackpads can be replayed in a test.
 */

export const GESTURE_GAP = 180
export const WHEEL_START = 18
export const ACCELERATION = 1.8
/** A flick has passed its peak once an event is this share of it or less. */
export const DECAY = 0.6
/** The smallest step a mouse wheel's notch sends. */
const NOTCH = 50

export type WheelPhase = "rest" | "notching" | "gathering" | "flicking" | "coasting"

export interface WheelState {
	readonly phase: WheelPhase
	/** The time of the last event. */
	readonly at: number
	/** The distance travelled in this gesture, signed. */
	readonly sum: number
	/** The sizes of the last few events. */
	readonly recent: readonly number[]
	/** The largest event of the flick in progress. */
	readonly peak: number
}

export interface WheelSample {
	/** The distance of this event in pixels, signed: positive is forward. */
	readonly delta: number
	readonly time: number
}

export const WHEEL_REST: WheelState = {
	phase: "rest",
	at: Number.NEGATIVE_INFINITY,
	sum: 0,
	recent: [],
	peak: 0
}

export interface WheelStep {
	readonly state: WheelState
	/** The page turn this event asks for: forward, back, or none. */
	readonly turn: -1 | 0 | 1
}

export const wheelStep = (previous: WheelState, sample: WheelSample): WheelStep => {
	if (sample.delta === 0) return { state: previous, turn: 0 }
	const size = Math.abs(sample.delta)
	const direction = sample.delta > 0 ? 1 : -1
	const fresh =
		previous.phase === "rest" ||
		sample.time - previous.at > GESTURE_GAP ||
		direction !== Math.sign(previous.sum || sample.delta)
	const from = fresh ? WHEEL_REST : previous

	const sameAsBefore =
		from.recent.length > 0 && from.recent.every((value) => Math.abs(value - size) < 1)
	const notch = size >= NOTCH && (fresh || sameAsBefore)
	const average =
		from.recent.length === 0
			? 0
			: from.recent.reduce((sum, value) => sum + value, 0) / from.recent.length
	const accelerating = from.recent.length >= 3 && size > average * ACCELERATION && size > 6

	const sum = from.sum + sample.delta
	const moved = { at: sample.time, sum, recent: [...from.recent.slice(-4), size] }
	const flick = { ...moved, phase: "flicking" as const, peak: size }

	if (notch) return { state: { ...moved, phase: "notching", peak: size }, turn: direction }
	switch (from.phase) {
		case "rest":
		case "gathering":
			return Math.abs(sum) >= WHEEL_START
				? { state: flick, turn: direction }
				: { state: { ...moved, phase: "gathering", peak: 0 }, turn: 0 }
		case "flicking": {
			const peak = Math.max(from.peak, size)
			return {
				state: { ...moved, phase: size <= peak * DECAY ? "coasting" : "flicking", peak },
				turn: 0
			}
		}
		case "notching":
		case "coasting":
			return accelerating
				? { state: flick, turn: direction }
				: { state: { ...moved, phase: "coasting", peak: from.peak }, turn: 0 }
	}
}
