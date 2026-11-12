import { describe, expect, it } from "vitest"
import {
	hasRoom,
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

	it("has room for a few turns and no more", () => {
		const ask = (delta: number) => run([{ type: "STEP", delta, total: 20 }], resting(0))
		expect(hasRoom(ask(5))).toBe(true)
		expect(hasRoom(ask(6))).toBe(false)
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
