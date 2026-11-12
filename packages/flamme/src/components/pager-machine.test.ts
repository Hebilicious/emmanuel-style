import { describe, expect, it } from "vitest"
import { PAGER_START, type PagerEvent, type PagerState, pagerStep } from "./pager-machine.js"

const run = (events: readonly PagerEvent[], from: PagerState = PAGER_START): PagerState =>
	events.reduce(pagerStep, from)

const resting = (screen: number): PagerState => run([{ type: "LAID_OUT", screen }])

describe("the pager", () => {
	it("ignores a move asked for before the layout", () => {
		expect(run([{ type: "STEP", delta: 1, total: 9 }])).toEqual(PAGER_START)
		expect(run([{ type: "ASK", screen: 4, total: 9 }])).toEqual(PAGER_START)
	})

	it("opens on the screen the layout names", () => {
		expect(resting(2)).toEqual({ phase: "resting", current: 2 })
	})

	it("shows the screen asked for in the same step as the ask", () => {
		expect(run([{ type: "STEP", delta: 1, total: 9 }], resting(0)).current).toBe(1)
		expect(run([{ type: "ASK", screen: 8, total: 9 }], resting(0)).current).toBe(8)
	})

	it("follows a spin of the wheel step for step, with nothing queued", () => {
		const spin = Array.from({ length: 30 }, () => ({ type: "STEP", delta: 1, total: 40 }) as const)
		expect(run(spin, resting(3))).toEqual({ phase: "resting", current: 33 })
	})

	it("goes back and forth without drifting", () => {
		const events = Array.from(
			{ length: 21 },
			(_, index) => ({ type: "STEP", delta: index % 2 === 0 ? 1 : -1, total: 9 }) as const
		)
		expect(run(events, resting(4)).current).toBe(5)
	})

	it("stops at the first and the last screen", () => {
		expect(run([{ type: "STEP", delta: -3, total: 9 }], resting(1)).current).toBe(0)
		expect(run([{ type: "STEP", delta: 30, total: 9 }], resting(1)).current).toBe(8)
		expect(run([{ type: "ASK", screen: 99, total: 9 }], resting(0)).current).toBe(8)
	})

	it("keeps the reader's place when the layout is redone, and starts over when the blocks change", () => {
		expect(run([{ type: "LAID_OUT", screen: 5 }], resting(2)).current).toBe(5)
		expect(run([{ type: "RESET" }], resting(2))).toEqual(PAGER_START)
	})
})
