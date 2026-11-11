import { describe, expect, it } from "vitest"
import { WHEEL_REST, type WheelState, wheelStep } from "./wheel.js"

/** Replay events, returning the turns asked for and the phases passed through. */
const replay = (events: readonly (readonly [delta: number, time: number])[]) => {
	let state: WheelState = WHEEL_REST
	const turns: number[] = []
	const phases: string[] = []
	for (const [delta, time] of events) {
		const step = wheelStep(state, { delta, time })
		state = step.state
		turns.push(step.turn)
		phases.push(state.phase)
	}
	return { turns, phases }
}

describe("the wheel", () => {
	it("turns a page for every notch of a mouse wheel", () => {
		const { turns, phases } = replay([
			[100, 0],
			[100, 60],
			[100, 120]
		])
		expect(turns).toEqual([1, 1, 1])
		expect(phases).toEqual(["notching", "notching", "notching"])
	})

	it("turns back for a notch the other way", () => {
		expect(
			replay([
				[100, 0],
				[-100, 60]
			]).turns
		).toEqual([1, -1])
	})

	it("turns once for a trackpad flick and ignores its momentum", () => {
		const flick = [4, 9, 14, 22, 30, 24, 18, 13, 9, 6, 4, 3, 2, 1, 1]
		const { turns, phases } = replay(flick.map((delta, index) => [delta, index * 16]))
		expect(turns.filter((turn) => turn !== 0)).toEqual([1])
		expect(phases[0]).toBe("gathering")
		expect(phases[3]).toBe("flicking")
		expect(phases.at(-1)).toBe("coasting")
	})

	it("turns again for a second flick inside the momentum of the first", () => {
		const stream = [6, 14, 30, 22, 14, 9, 6, 4, 3, 28, 40, 26, 12, 6]
		const { turns } = replay(stream.map((delta, index) => [delta, index * 16]))
		expect(turns.filter((turn) => turn !== 0)).toEqual([1, 1])
	})

	it("starts a new gesture after a pause", () => {
		const { turns, phases } = replay([
			[10, 0],
			[12, 16],
			[3, 32],
			[10, 400],
			[12, 416]
		])
		expect(turns).toEqual([0, 1, 0, 0, 1])
		expect(phases[3]).toBe("gathering")
	})

	it("does nothing for an event that did not move", () => {
		expect(wheelStep(WHEEL_REST, { delta: 0, time: 0 })).toEqual({ state: WHEEL_REST, turn: 0 })
	})
})
