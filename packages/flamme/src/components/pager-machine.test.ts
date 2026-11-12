import { describe, expect, it } from "vitest"
import {
	blitzing,
	nextTurn,
	PAGER_START,
	type PagerEvent,
	type PagerState,
	pagerStep
} from "./pager-machine.js"

const run = (events: readonly PagerEvent[], from: PagerState = PAGER_START): PagerState =>
	events.reduce(pagerStep, from)

const resting = (screen: number): PagerState => run([{ type: "LAID_OUT", screen }])

describe("the pager", () => {
	it("ignores a turn asked for before the layout", () => {
		expect(run([{ type: "STEP", delta: 1, total: 9 }])).toEqual(PAGER_START)
	})

	it("opens on the screen the layout names", () => {
		expect(resting(2)).toEqual({ phase: "resting", current: 2, target: 2 })
	})

	it("runs one turn for one step, then rests", () => {
		let state = run([{ type: "STEP", delta: 1, total: 9 }, { type: "BEGIN" }], resting(0))
		expect(nextTurn(state)).toEqual({ to: 1, direction: "forward", behind: 0 })
		state = run([{ type: "LANDED", screen: 1 }], state)
		expect(nextTurn(state)).toBeNull()
		expect(run([{ type: "SETTLE" }], state)).toEqual({ phase: "resting", current: 1, target: 1 })
	})

	it("counts steps asked during a turn from the screen already asked for", () => {
		const state = run(
			[
				{ type: "STEP", delta: 1, total: 9 },
				{ type: "BEGIN" },
				{ type: "STEP", delta: 1, total: 9 },
				{ type: "STEP", delta: 1, total: 9 }
			],
			resting(0)
		)
		expect(state.target).toBe(3)
		expect(nextTurn(state)).toEqual({ to: 1, direction: "forward", behind: 2 })
	})

	it("reaches a far screen in one turn rather than riffling to it", () => {
		const state = run([{ type: "ASK", screen: 8, total: 9 }], resting(0))
		expect(nextTurn(state)).toEqual({ to: 8, direction: "forward", behind: 0 })
	})

	it("never asks for a screen that is not there", () => {
		expect(run([{ type: "STEP", delta: -1, total: 9 }], resting(0)).target).toBe(0)
		expect(run([{ type: "ASK", screen: 99, total: 9 }], resting(0)).target).toBe(8)
	})

	it("jumps rather than turns when asks come as fast as a spun wheel", () => {
		const one = run([{ type: "STEP", delta: 1, total: 20 }], resting(0))
		expect(blitzing(one, 400)).toBe(false)
		expect(blitzing(one, 40)).toBe(true)
		// Turns piling up are a blitz too, however far apart the asks were.
		const piled = run([{ type: "STEP", delta: 3, total: 20 }], resting(0))
		expect(blitzing(piled, 400)).toBe(true)
	})

	it("a jump shows the screen asked for at once", () => {
		const state = run([{ type: "STEP", delta: 5, total: 20 }, { type: "JUMP" }], resting(2))
		expect(state.current).toBe(7)
		expect(nextTurn(state)).toBeNull()
	})

	it("keeps turning through a layout redone under it, and ends on target", () => {
		const state = run(
			[{ type: "STEP", delta: 2, total: 9 }, { type: "BEGIN" }, { type: "LAID_OUT", screen: 4 }],
			resting(0)
		)
		expect(state).toEqual({ phase: "turning", current: 4, target: 4 })
		expect(nextTurn(state)).toBeNull()
	})

	it("starts over when the blocks change", () => {
		expect(run([{ type: "RESET" }], resting(5))).toEqual(PAGER_START)
	})
})
