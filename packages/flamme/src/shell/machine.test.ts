import { describe, expect, it } from "vitest"
import { createMachine } from "./machine.js"
import { createProjectMachine } from "./project.js"

type Light = "red" | "green"
type LightEvent = { type: "GO" } | { type: "STOP" } | { type: "SET"; to: Light | undefined }

const light = () =>
	createMachine<Light, LightEvent>("red", {
		red: { GO: "green", SET: (event) => event.to },
		green: { STOP: "red" }
	})

describe("a machine", () => {
	it("moves on an event its state lists", () => {
		const machine = light()
		expect(machine.send({ type: "GO" })).toBe("green")
		expect(machine.is("green")).toBe(true)
	})

	it("ignores an event its state does not list", () => {
		const machine = light()
		expect(machine.can("STOP")).toBe(false)
		expect(machine.send({ type: "STOP" })).toBe("red")
	})

	it("lets a function pick the state, or stay", () => {
		const machine = light()
		expect(machine.send({ type: "SET", to: undefined })).toBe("red")
		expect(machine.send({ type: "SET", to: "green" })).toBe("green")
	})

	it("tells its subscribers about a change, and only a change", () => {
		const machine = light()
		const seen: string[] = []
		const stop = machine.subscribe((state, previous, event) =>
			seen.push(`${previous}>${state}:${event.type}`)
		)
		machine.send({ type: "STOP" })
		machine.send({ type: "GO" })
		stop()
		machine.send({ type: "STOP" })
		expect(seen).toEqual(["red>green:GO"])
	})
})

describe("an open project", () => {
	it("steps back when this visit pushed it", () => {
		const machine = createProjectMachine()
		machine.send({ type: "OPEN" })
		machine.send({ type: "ARRIVE" })
		expect(machine.state).toBe("pushed")
	})

	it("is linked when the address already named it", () => {
		const machine = createProjectMachine()
		machine.send({ type: "ARRIVE" })
		expect(machine.state).toBe("linked")
	})

	it("forgets a push once the back button has closed it", () => {
		const machine = createProjectMachine()
		machine.send({ type: "OPEN" })
		machine.send({ type: "LEAVE" })
		machine.send({ type: "ARRIVE" })
		expect(machine.state).toBe("linked")
	})
})
