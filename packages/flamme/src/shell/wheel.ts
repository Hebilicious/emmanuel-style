/**
 * The wheel: how far it has been turned, in pages.
 *
 * A wheel moves the reader through the pages the way it moves a reader down an
 * ordinary page: by how far it is turned, at once, however fast. Nothing here
 * knows about animation, and nothing here waits.
 *
 * Wheels do not agree on what one event is. A mouse wheel with detents sends one
 * event per notch, a hundred a second when it is spun (recorded from a Logitech
 * G502 X: bursts of five to fourteen notches, 8 to 25 ms apart). A high-resolution
 * or free-spinning wheel sends fractions of a notch. A trackpad sends pixels, then
 * a second of momentum. So every event is first turned into the same unit, the
 * notch, and the notches are added up:
 *
 *   a notch of a mouse wheel   one page
 *   a fraction of a notch      that fraction of a page
 *   a trackpad                 a page for every `TRACKPAD_PAGE` pixels travelled
 *
 * The sum is rounded to whole pages and the remainder carried to the next event,
 * so half a notch already turns the first page and every full notch after it
 * turns one more. Turning the wheel the other way, or leaving it alone for
 * `WHEEL_IDLE`, drops what was carried: a change of direction is answered at once
 * and is never spent undoing a remainder.
 *
 * It is a pure function of the state and one event, so the recorded shapes of
 * real wheels can be replayed in a test.
 */

/** A wheel left alone this long starts a new gesture, in milliseconds. */
export const WHEEL_IDLE = 220
/** The pixels a trackpad travels for one page. */
export const TRACKPAD_PAGE = 160
/** What a browser reports as `wheelDelta` for one notch. */
const WHEEL_DELTA_NOTCH = 120
/** Lines a browser scrolls per notch, where it reports lines (`deltaMode` 1). */
const LINES_PER_NOTCH = 3
/** Pixels per notch where the browser reports nothing else to go by. */
const PIXELS_PER_NOTCH = 100

/** The fields of a `WheelEvent` that say how far the wheel was turned. */
export interface WheelSample {
	readonly deltaX: number
	readonly deltaY: number
	/** 0 pixels, 1 lines, 2 pages. */
	readonly deltaMode: number
	/** The legacy `wheelDeltaX` and `wheelDeltaY`: 120 per notch, positive is up. Absent in some browsers. */
	readonly wheelDeltaX?: number | undefined
	readonly wheelDeltaY?: number | undefined
	/** When the event happened, in milliseconds. */
	readonly time: number
}

export interface WheelState {
	/** The time of the last event. */
	readonly at: number
	/** Which way it was last turned: 1 forward, -1 back, 0 before the first event. */
	readonly direction: number
	/**
	 * The part of a page turned and not yet shown, signed like the pages. It is
	 * negative after a page shown early: half a notch shows the first page, and the
	 * other half is owed.
	 */
	readonly carry: number
}

export const WHEEL_REST: WheelState = { at: Number.NEGATIVE_INFINITY, direction: 0, carry: 0 }

/** How far one event turned the wheel, in notches, signed: positive is forward. */
export const notchesOf = (sample: WheelSample): number => {
	const vertical = Math.abs(sample.deltaY) >= Math.abs(sample.deltaX)
	const delta = vertical ? sample.deltaY : sample.deltaX
	if (delta === 0) return 0
	if (sample.deltaMode === 2) return delta
	if (sample.deltaMode === 1) return delta / LINES_PER_NOTCH
	const legacy = vertical ? sample.wheelDeltaY : sample.wheelDeltaX
	if (legacy === undefined || legacy === 0) return delta / PIXELS_PER_NOTCH
	// A trackpad's pixels are reported as three legacy units each: that is how it is told.
	if (Math.abs(legacy + delta * 3) < 0.5) return delta / TRACKPAD_PAGE
	return -legacy / WHEEL_DELTA_NOTCH
}

export interface WheelStep {
	readonly state: WheelState
	/** The pages this event moves the reader by: positive is forward. */
	readonly pages: number
}

export const wheelStep = (previous: WheelState, sample: WheelSample): WheelStep => {
	const notches = notchesOf(sample)
	if (notches === 0) return { state: previous, pages: 0 }
	const direction = Math.sign(notches)
	const fresh = sample.time - previous.at > WHEEL_IDLE || previous.direction !== direction
	const carry = (fresh ? 0 : previous.carry) + notches
	// Rounded half away from zero, with a hair of slack for fractions that do not add up exactly.
	const pages = Math.sign(carry) * Math.floor(Math.abs(carry) + 0.5 + 1e-9)
	return { state: { at: sample.time, direction, carry: carry - pages }, pages }
}
