import { describe, expect, it } from "vitest"
import { TRACKPAD_PAGE, WHEEL_REST, type WheelSample, type WheelState, wheelStep } from "./wheel.js"

/** Replay events and return the pages each one moved. */
const replay = (events: readonly WheelSample[]): number[] => {
	let state: WheelState = WHEEL_REST
	return events.map((event) => {
		const step = wheelStep(state, event)
		state = step.state
		return step.pages
	})
}
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

/** A notch of a detented mouse wheel, as Chromium reports it on Linux. */
const notch = (time: number, direction: 1 | -1 = 1): WheelSample => ({
	deltaX: 0,
	deltaY: 53 * direction,
	deltaMode: 0,
	wheelDeltaY: -120 * direction,
	time
})

describe("the wheel", () => {
	it("moves a page for every notch of a mouse wheel, at once", () => {
		expect(replay([notch(0), notch(400), notch(800)])).toEqual([1, 1, 1])
	})

	it("moves a page for every notch however fast the wheel is spun", () => {
		// A burst recorded from a Logitech G502 X: fourteen notches in 90 ms.
		const times = [0, 8, 16, 23, 30, 39, 50, 64, 81, 300, 308, 316, 323, 330]
		expect(replay(times.map((time) => notch(time)))).toEqual(times.map(() => 1))
	})

	it("answers a change of direction with the first notch the other way", () => {
		expect(replay([notch(0), notch(10), notch(20, -1), notch(30, -1), notch(40)])).toEqual([
			1, 1, -1, -1, 1
		])
	})

	it("moves one notch back and forth, every time", () => {
		const events = Array.from({ length: 12 }, (_, index) =>
			notch(index * 180, index % 2 === 0 ? 1 : -1)
		)
		expect(replay(events)).toEqual([1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1])
	})

	it("adds up the fractions of a high-resolution wheel: a page per notch travelled", () => {
		// Eight events to the notch, as a free-spinning wheel sends them.
		const events = Array.from({ length: 80 }, (_, index) => ({
			deltaX: 0,
			deltaY: 53 / 8,
			deltaMode: 0,
			wheelDeltaY: -15,
			time: index * 4
		}))
		const pages = replay(events)
		expect(sum(pages)).toBe(10)
		// The first page comes at half a notch, not after a whole one.
		expect(pages.indexOf(1)).toBe(3)
	})

	it("counts lines, where the browser reports lines", () => {
		const line = (time: number): WheelSample => ({ deltaX: 0, deltaY: 3, deltaMode: 1, time })
		expect(replay([line(0), line(20), line(40)])).toEqual([1, 1, 1])
	})

	it("moves a trackpad by distance, momentum included, like a page that scrolls", () => {
		const flick = [4, 9, 14, 22, 30, 24, 18, 13, 9, 6, 4, 3, 2, 1, 1, 30, 60, 80, 70, 50, 30, 20]
		const events = flick.map((delta, index) => ({
			deltaX: 0,
			deltaY: delta,
			deltaMode: 0,
			wheelDeltaY: -delta * 3,
			time: index * 16
		}))
		expect(sum(replay(events))).toBe(Math.round(sum(flick) / TRACKPAD_PAGE))
	})

	it("forgets a part-turned page once the wheel has been left alone", () => {
		const part = (time: number): WheelSample => ({
			deltaX: 0,
			deltaY: 20,
			deltaMode: 0,
			wheelDeltaY: -45,
			time
		})
		// 0.375 of a notch, twice, a second apart: neither is half a page.
		expect(replay([part(0), part(1000)])).toEqual([0, 0])
		// The same two together are three quarters of one.
		expect(replay([part(0), part(10)])).toEqual([0, 1])
	})

	it("follows the wheel sideways when that is the way it is turned", () => {
		expect(
			replay([{ deltaX: 53, deltaY: 2, deltaMode: 0, wheelDeltaX: -120, wheelDeltaY: -4, time: 0 }])
		).toEqual([1])
	})
})
