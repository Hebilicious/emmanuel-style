/**
 * The leaves that turn when the page changes.
 *
 * The page changes first, at once: the pager draws the screen asked for in the
 * same frame as the ask. What turns is the page that was there. Its own elements
 * are kept on screen a moment longer (the pager hands them over as they leave,
 * with the function that lets them go) and they are turned over the new page,
 * which is already drawn under them. Nothing is copied, photographed or waited
 * for, so a turn costs what drawing the new page costs and no more, and it can
 * never hold a page back or be in the way of a click: the pages that are leaving
 * are `inert`.
 *
 * Going forward on a spread, the old right-hand page is lifted on the spine until
 * it stands edge-on, and then the new left-hand page is laid from upright onto
 * the old left-hand page, which stays under it until it lands. Going back is the
 * mirror of it. On a phone there is one page, hinged on its left edge: going
 * forward the old page swings up and away, going back the new one swings down
 * over the old.
 *
 * Scrolling makes a riffle of it. A step that comes while a leaf is still being
 * lifted joins that turn: the page it brings is the one that will be laid. A step
 * that comes later starts a leaf of its own behind it. So leaves follow each other
 * half a turn apart however fast the wheel is spun, and the last one down is
 * always the page the reader stopped on.
 *
 * A step the other way, while one leaf is in the air, turns that leaf back, which
 * is what a hand does. With more than one in the air they are dropped and the new
 * turn starts clean.
 */

import { reducedMotion } from "../shell/turns.js"

export type FlipDirection = "forward" | "back"

/** How long a single turn takes, and a turn in a riffle, in milliseconds. */
export const FLIP_MS = 420
export const RIFFLE_MS = 280
/** A turn that starts this soon after the last is part of a riffle. */
const RIFFLE_WITHIN = 320
/** A leaf is lifted picking up speed and laid losing it: two curves that meet at the same speed. */
const LIFT = "cubic-bezier(0.45, 0, 0.85, 0.7)"
const LAND = "cubic-bezier(0.15, 0.3, 0.45, 1)"
const SWING = "cubic-bezier(0.33, 0.06, 0.18, 1)"

/** The leaves of one screen. A spread has a left and a right, a phone a single one. */
export interface Leaves {
	readonly left?: HTMLElement | undefined
	readonly right?: HTMLElement | undefined
	readonly single?: HTMLElement | undefined
}

export interface Flipper {
	/**
	 * The screen has changed. `old` are the leaves that were showing, still in the
	 * DOM, and `release` lets one of them go; `fresh` are the leaves showing now.
	 */
	step(
		direction: FlipDirection,
		old: Leaves,
		fresh: Leaves,
		release: (leaf: HTMLElement) => void
	): void
	/** Let every kept leaf go now: the layout changed, a View Transition is starting, the pager is leaving. */
	snap(): void
	/** How many turns are in the air. */
	readonly flying: number
}

/** One turn: the leaf lifted, the leaf laid, and what is kept under them meanwhile. */
interface Flight {
	/** The way it was started. */
	readonly type: FlipDirection
	/** The way it is going now: the way it was started, until it is turned back. */
	heading: FlipDirection
	readonly ms: number
	readonly startedAt: number
	/** The old page being lifted, and its animation. */
	lifting: HTMLElement | null
	lift: Animation | null
	/** The new page being laid, and its animation. It is the live page until a later step retires it. */
	landing: HTMLElement | null
	land: Animation | null
	/** Old leaves kept until this turn is over: what the laid page lands on, and what a turned-back leaf returns to. */
	readonly kept: HTMLElement[]
	turnedBack: boolean
	done: boolean
}

export const createFlipper = (depth: () => { spread: number; single: number }): Flipper => {
	let flights: Flight[] = []
	/** Every leaf that has left the page and is still in the DOM, with what lets it go. */
	const held = new Map<HTMLElement, () => void>()
	let order = 0
	/** How bright a leaf is when it stands edge-on, and the theme that was read for. */
	let dim = ""
	let dimFor = ""

	const hold = (leaf: HTMLElement, release: (leaf: HTMLElement) => void) => {
		held.set(leaf, () => release(leaf))
		// A page that is leaving is not the page: nothing reads it, focuses it or clicks it.
		leaf.inert = true
		leaf.removeAttribute("data-leaf")
		leaf.style.viewTransitionName = "none"
	}
	const letGo = (leaf: HTMLElement | null) => {
		if (leaf === null) return
		const release = held.get(leaf)
		if (release === undefined) return
		held.delete(leaf)
		release()
	}
	/** Put a page that is staying back the way the pager drew it. */
	const rest = (leaf: HTMLElement | null) => {
		if (leaf === null || held.has(leaf)) return
		leaf.style.zIndex = ""
		leaf.style.transformOrigin = ""
	}

	const end = (flight: Flight) => {
		flight.done = true
		flight.lift?.cancel()
		flight.land?.cancel()
		letGo(flight.lifting)
		for (const leaf of flight.kept) letGo(leaf)
		// A leaf that was turned back was laid by nothing: the page under it is the one showing.
		if (flight.turnedBack) letGo(flight.landing)
		rest(flight.landing)
		flights = flights.filter((other) => other !== flight)
	}

	const snap = () => {
		for (const flight of [...flights]) end(flight)
		for (const leaf of [...held.keys()]) letGo(leaf)
	}

	/** A turn is over when neither of its leaves is still moving. */
	const settle = (flight: Flight) => {
		if (flight.done) return
		const moving = [flight.lift, flight.land].some(
			(animation) => animation !== null && animation.playState === "running"
		)
		if (!moving) end(flight)
	}

	const brightness = (): string => {
		const theme = document.documentElement.className
		if (dimFor !== theme) {
			dimFor = theme
			dim =
				getComputedStyle(document.documentElement).getPropertyValue("--turn-dim").trim() || "0.7"
		}
		return dim
	}

	const animate = (
		flight: Flight,
		leaf: HTMLElement,
		frames: Keyframe[],
		origin: "left" | "right",
		zIndex: number
	): Animation => {
		leaf.style.transformOrigin = `${origin} center`
		leaf.style.zIndex = String(zIndex)
		const animation = leaf.animate(frames, { duration: flight.ms, fill: "both" })
		animation.onfinish = () => settle(flight)
		return animation
	}

	/** The frames of a leaf lifted off a spread, and of one laid on it. `sign` is the way it leans. */
	const lifted = (sign: number, eye: number): Keyframe[] => [
		{ transform: `perspective(${eye}px) rotateY(0deg)`, filter: "brightness(1)", easing: LIFT },
		{
			transform: `perspective(${eye}px) rotateY(${sign * 90}deg)`,
			filter: `brightness(${brightness()})`,
			offset: 0.5
		},
		{
			transform: `perspective(${eye}px) rotateY(${sign * 90}deg)`,
			filter: `brightness(${brightness()})`
		}
	]
	const laid = (sign: number, eye: number): Keyframe[] => [
		{
			transform: `perspective(${eye}px) rotateY(${sign * 90}deg)`,
			filter: `brightness(${brightness()})`
		},
		{
			transform: `perspective(${eye}px) rotateY(${sign * 90}deg)`,
			filter: `brightness(${brightness()})`,
			offset: 0.5,
			easing: LAND
		},
		{ transform: `perspective(${eye}px) rotateY(0deg)`, filter: "brightness(1)" }
	]
	/** A phone's page swinging on its left edge: away, or back down. */
	const swung = (eye: number, away: boolean): Keyframe[] => {
		const flat = { transform: `perspective(${eye}px) rotateY(0deg)`, filter: "brightness(1)" }
		const up = {
			transform: `perspective(${eye}px) rotateY(-96deg)`,
			filter: `brightness(${brightness()})`
		}
		return away ? [{ ...flat, easing: SWING }, up] : [{ ...up, easing: SWING }, flat]
	}

	const step: Flipper["step"] = (direction, old, fresh, release) => {
		const leaving = [old.left, old.right, old.single].filter(
			(leaf): leaf is HTMLElement => leaf !== undefined
		)
		for (const leaf of leaving) hold(leaf, release)
		if (reducedMotion()) return snap()

		const now = performance.now()
		const forward = direction === "forward"
		const flying = flights.filter((flight) => !flight.done)
		const last = flying.at(-1)

		if (last !== undefined && last.heading !== direction) {
			if (flying.length === 1) {
				/*
				 * One leaf in the air, and the reader has changed their mind: it is turned
				 * back. The first time, the page that was showing is kept under it until it
				 * is home. After that the page that was showing was already under what is
				 * kept, and goes at once.
				 */
				for (const leaf of leaving) {
					if (leaf === last.landing) continue
					if (last.turnedBack) {
						letGo(leaf)
						continue
					}
					last.kept.push(leaf)
					leaf.style.zIndex = "1"
				}
				last.turnedBack = true
				last.heading = direction
				last.lift?.reverse()
				last.land?.reverse()
				return
			}
			// A riffle, and a step against it: the leaves in the air are dropped and this turn starts clean.
			for (const flight of [...flights]) end(flight)
			for (const leaf of [...held.keys()]) if (!leaving.includes(leaf)) letGo(leaf)
		} else if (last !== undefined && last.turnedBack) {
			// Going on the way a turned-back leaf is going: it is let down, and this turn starts clean.
			for (const flight of [...flights]) end(flight)
			for (const leaf of [...held.keys()]) if (!leaving.includes(leaf)) letGo(leaf)
		}

		const current = flights.filter((flight) => !flight.done).at(-1)
		const ms =
			now - (current?.startedAt ?? Number.NEGATIVE_INFINITY) < RIFFLE_WITHIN ? RIFFLE_MS : FLIP_MS
		order += 1
		const { spread, single } = depth()

		/* ------------------------------------------------------------- a phone */

		if (fresh.single !== undefined && old.single !== undefined) {
			if (forward) {
				// A leaf is still on its way up: this page goes without one, under it.
				if (current !== undefined && now - current.startedAt < current.ms / 3)
					return letGo(old.single)
				const flight: Flight = {
					type: direction,
					heading: direction,
					ms,
					startedAt: now,
					lifting: old.single,
					lift: null,
					landing: null,
					land: null,
					kept: [],
					turnedBack: false,
					done: false
				}
				flights.push(flight)
				flight.lift = animate(flight, old.single, swung(single, true), "left", 1000 - order)
				return
			}
			if (current !== undefined && current.landing === old.single && current.land !== null) {
				if (now - current.startedAt < current.ms / 3) {
					// The page coming down has barely started: this one comes down in its place.
					const at = current.land.currentTime
					current.land.cancel()
					letGo(old.single)
					current.landing = fresh.single
					current.land = animate(current, fresh.single, swung(single, false), "left", order)
					current.land.currentTime = at
					return
				}
			}
			const flight: Flight = {
				type: direction,
				heading: direction,
				ms,
				startedAt: now,
				lifting: null,
				lift: null,
				landing: fresh.single,
				land: null,
				// The page it comes down on: the old one, which may itself still be coming down.
				kept: [old.single],
				turnedBack: false,
				done: false
			}
			flights.push(flight)
			if (!flights.some((other) => other.landing === old.single)) old.single.style.zIndex = "1"
			flight.land = animate(flight, fresh.single, swung(single, false), "left", order)
			return
		}

		/* ------------------------------------------------------------ a spread */

		const lifting = forward ? old.right : old.left
		const under = forward ? old.left : old.right
		const landing = forward ? fresh.left : fresh.right
		if (lifting === undefined || under === undefined || landing === undefined) return snap()
		const sign = forward ? -1 : 1
		const hinge = forward ? "left" : "right"
		const lands = forward ? "right" : "left"

		if (
			current !== undefined &&
			current.landing === under &&
			current.land !== null &&
			now - current.startedAt < current.ms / 2
		) {
			/*
			 * The last leaf is still being lifted, and the page it was going to lay has not
			 * shown yet: this step joins that turn, and the page it brings is laid instead.
			 */
			const at = current.land.currentTime
			current.land.cancel()
			letGo(under)
			letGo(lifting)
			current.landing = landing
			current.land = animate(current, landing, laid(-sign, spread), lands, order)
			current.land.currentTime = at
			return
		}

		const flight: Flight = {
			type: direction,
			heading: direction,
			ms,
			startedAt: now,
			lifting,
			lift: null,
			landing,
			land: null,
			// What the laid page lands on: the old page, which may itself still be on its way down.
			kept: [under],
			turnedBack: false,
			done: false
		}
		flights.push(flight)
		if (!flights.some((other) => other.landing === under)) under.style.zIndex = "1"
		// On the side leaves lift from, the older is on top; on the side they land, the newer.
		flight.lift = animate(flight, lifting, lifted(sign, spread), hinge, 1000 - order)
		flight.land = animate(flight, landing, laid(-sign, spread), lands, order + 1)
	}

	return {
		step,
		snap,
		get flying() {
			return flights.filter((flight) => !flight.done).length
		}
	}
}
