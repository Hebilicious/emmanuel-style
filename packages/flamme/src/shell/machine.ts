/**
 * A state machine, small enough to read in one go.
 *
 * The shell has several things that are in exactly one state at a time: a turn is
 * running or it is not, the keyboard is waiting for the second key of `g h` or it
 * is not, a project is closed, opening, open or closing. Kept as a boolean here and
 * a `let` there, those states were implicit: nothing said which combinations could
 * happen, and a flag left set was a bug that showed up somewhere else.
 *
 * A machine names the states and lists, per state, the events it answers and the
 * state each leads to. An event a state does not list is ignored, which is the
 * point: "a wheel notch while a dialog is open" does nothing because the table
 * says nothing, not because a guard somewhere remembered to check.
 *
 * The table is data, so a test can walk it, and `subscribe` lets one part of the
 * shell (the press, the dock) follow another without the two sharing variables.
 */

export interface MachineEvent {
	readonly type: string
}

/** What an event leads to: a state, or a function that picks one (or `undefined` to stay). */
type Target<S extends string, E extends MachineEvent> = S | ((event: E) => S | undefined)

export type Transitions<S extends string, E extends MachineEvent> = {
	readonly [State in S]: {
		readonly [Type in E["type"]]?: Target<S, Extract<E, { type: Type }>>
	}
}

export interface Machine<S extends string, E extends MachineEvent> {
	/** The state it is in. */
	readonly state: S
	/** Deliver an event; returns the state after it. */
	send(event: E): S
	/** Whether the current state answers an event of this type. */
	can(type: E["type"]): boolean
	/** Whether it is in one of these states. */
	is(...states: readonly S[]): boolean
	/** Called after every change of state. Returns the function that stops it. */
	subscribe(listener: Listener<S, E>): () => void
}

export type Listener<S extends string, E extends MachineEvent> = (
	state: S,
	previous: S,
	event: E
) => void

export const createMachine = <S extends string, E extends MachineEvent>(
	initial: S,
	transitions: Transitions<S, E>
): Machine<S, E> => {
	let state = initial
	const listeners = new Set<Listener<S, E>>()

	const targetOf = (event: E): Target<S, E> | undefined =>
		(transitions[state] as Record<string, Target<S, E> | undefined>)[event.type]

	return {
		get state() {
			return state
		},
		send(event) {
			const target = targetOf(event)
			if (target === undefined) return state
			const next = typeof target === "function" ? target(event) : target
			if (next === undefined || next === state) return state
			const previous = state
			state = next
			for (const listener of listeners) listener(state, previous, event)
			return state
		},
		can: (type) => type in transitions[state],
		is: (...states) => states.includes(state),
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		}
	}
}
