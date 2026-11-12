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
 * How much turns says how far the reader went. One page is one leaf. A step that
 * comes while that leaf is still being lifted joins the turn, and the turn grows
 * with the pages it now covers: between the page lifted and the page laid, blank
 * leaves follow each other across the spine, two for a move of two to four pages,
 * five for a longer one, and one more for as long as the reader keeps scrolling.
 * The page laid at the end is always the one the reader stopped on. A step that
 * comes once that page is on its way down starts a turn of its own behind it.
 *
 * A step the other way, while a single leaf is in the air, turns that leaf back,
 * which is what a hand does. Against a longer turn, the leaves in the air are
 * dropped and the new turn starts clean.
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
const PASS = "cubic-bezier(0.4, 0.1, 0.6, 0.9)"
/** The time between two leaves of a longer turn. */
const STAGGER = 150
/** The blank leaves between the page lifted and the page laid: for two to four pages, and for more. */
const SOME = 2
const MANY = 5
/** The most a turn carries, however long the reader keeps scrolling. */
const MOST = 9

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
		/** How many pages the reader moved. */
		pages: number,
		old: Leaves,
		fresh: Leaves,
		release: (leaf: HTMLElement) => void
	): void
	/** Let every kept leaf go now: the layout changed, a View Transition is starting, the reader went elsewhere. */
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
	/** How many pages it covers, and when the last of them was asked for. */
	pages: number
	lastStepAt: number
	/** Whether it has grown past one leaf: blank leaves pass, and the page is laid when they have. */
	multi: boolean
	/** Whether the page it lays is on its way down. Until then a step can still join it. */
	landingStarted: boolean
	readonly fillers: HTMLElement[]
	readonly fillerMoves: Animation[]
	timer: number
	/** Where its leaves are hinged and how they lean, for the blank ones. */
	readonly shape: {
		readonly single: boolean
		readonly forward: boolean
		readonly eye: number
		readonly left: string
		readonly width: string
		readonly order: number
	}
}

/** How far the eye is from the page, for the perspective of a turning leaf: a spread's, and a phone's. */
export const leafDepth = (): { spread: number; single: number } => ({
	spread: window.innerWidth * 1.9,
	single: window.innerWidth * 5.2
})

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
		leaf.style.transform = ""
	}

	const end = (flight: Flight) => {
		flight.done = true
		window.clearTimeout(flight.timer)
		flight.lift?.cancel()
		flight.land?.cancel()
		for (const move of flight.fillerMoves) move.cancel()
		for (const filler of flight.fillers) filler.remove()
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
		// A longer turn is over when its page has been laid, not when its first leaf is up.
		if (flight.done || (flight.multi && !flight.landingStarted)) return
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

	/** Keep the page that will be laid out of sight, edge-on at its hinge, until its turn comes. */
	const hide = (flight: Flight, leaf: HTMLElement) => {
		const { single, forward, eye, order: at } = flight.shape
		leaf.style.transformOrigin = single || !forward ? "left center" : "right center"
		leaf.style.zIndex = String(300 + at)
		leaf.style.transform = single
			? `perspective(${eye}px) rotateY(-96deg)`
			: `perspective(${eye}px) rotateY(${forward ? 90 : -90}deg)`
	}

	/** A blank leaf, following the ones before it across the spine (or, on a phone, off or onto the page). */
	const pass = (flight: Flight) => {
		const { single, forward, eye, left, width } = flight.shape
		const parent = (flight.lifting ?? flight.landing ?? flight.kept[0])?.parentElement
		if (parent == null) return
		const at = flight.fillers.length + 1
		const filler = document.createElement("div")
		filler.className = "TurnFiller"
		filler.style.left = left
		filler.style.width = width
		filler.style.transformOrigin = single || forward ? "left center" : "right center"
		parent.append(filler)
		flight.fillers.push(filler)
		const timing = { duration: flight.ms, fill: "both" as const }
		const turn = (degrees: number) => `perspective(${eye}px) rotateY(${degrees}deg)`
		const lit = { filter: "brightness(1)" }
		const dimmed = { filter: `brightness(${brightness()})` }
		if (single) {
			// Off the page going forward, down onto it going back.
			const frames = forward
				? [
						{ transform: turn(0), ...lit, easing: SWING },
						{ transform: turn(-96), ...dimmed }
					]
				: [
						{ transform: turn(-96), ...dimmed, easing: SWING },
						{ transform: turn(0), ...lit }
					]
			filler.style.zIndex = String(forward ? 800 - at : 100 + at)
			flight.fillerMoves.push(filler.animate(frames, timing))
			return
		}
		const lean = forward ? -1 : 1
		flight.fillerMoves.push(
			filler.animate(
				[
					{ transform: turn(0), ...lit, easing: PASS },
					{ transform: turn(lean * 90), ...dimmed, offset: 0.5, easing: PASS },
					{ transform: turn(lean * 180), ...lit }
				],
				timing
			),
			// Under the leaves before it where it lifts, over them where it lands: it changes sides edge-on.
			filler.animate(
				[
					{ zIndex: 800 - at },
					{ zIndex: 800 - at, offset: 0.5 },
					{ zIndex: 100 + at, offset: 0.5 },
					{ zIndex: 100 + at }
				],
				timing
			)
		)
	}

	/** Lay the page: the blank leaves have passed, and the reader has stopped. */
	const lay = (flight: Flight) => {
		flight.landingStarted = true
		const { single, forward, eye, order: at } = flight.shape
		const landing = flight.landing
		if (landing === null) {
			// A phone going forward lays nothing: the turn is over when the last leaf is off the page.
			flight.timer = window.setTimeout(() => end(flight), flight.ms)
			return
		}
		landing.style.transform = ""
		if (single) {
			flight.land = animate(flight, landing, swung(eye, false), "left", 300 + at)
			return
		}
		flight.land = animate(
			flight,
			landing,
			laid(forward ? 1 : -1, eye),
			forward ? "right" : "left",
			300 + at
		)
		// The first half of those frames is the wait while the other page lifts: that is done.
		flight.land.currentTime = flight.ms / 2
	}

	/** Every `STAGGER`: one more blank leaf while the turn is short of its length or the reader scrolls on, then the page. */
	const tick = (flight: Flight) => {
		if (flight.done || flight.landingStarted) return
		const wanted = flight.pages > 4 ? MANY : flight.pages > 1 ? SOME : 0
		const scrolling = performance.now() - flight.lastStepAt < STAGGER
		if (flight.fillers.length < MOST && (flight.fillers.length < wanted || scrolling)) {
			pass(flight)
			flight.timer = window.setTimeout(() => tick(flight), STAGGER)
			return
		}
		lay(flight)
	}

	/** A turn that now covers more than one page: its page waits, out of sight, for the leaves between. */
	const grow = (flight: Flight) => {
		if (flight.landing !== null) hide(flight, flight.landing)
		if (flight.multi) return
		flight.multi = true
		flight.land?.cancel()
		flight.land = null
		const elapsed = performance.now() - flight.startedAt
		flight.timer = window.setTimeout(() => tick(flight), Math.max(0, flight.ms / 4 - elapsed))
	}

	const step: Flipper["step"] = (direction, pages, old, fresh, release) => {
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
			if (flying.length === 1 && !last.multi) {
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
		// Leaves are stacked by the order they left in; with none in the air it starts again.
		if (current === undefined) order = 0
		order += 1
		const { spread, single } = depth()
		const fresh0 = {
			turnedBack: false,
			done: false,
			pages,
			lastStepAt: now,
			multi: false,
			landingStarted: false,
			fillers: [],
			fillerMoves: [],
			timer: 0
		}

		/* ------------------------------------------------------------- a phone */

		if (fresh.single !== undefined && old.single !== undefined) {
			if (forward) {
				// A leaf is still on its way up: this page goes without one, under it, and the turn grows.
				if (
					current !== undefined &&
					!current.landingStarted &&
					(current.multi || now - current.startedAt < current.ms / 2)
				) {
					letGo(old.single)
					current.pages += pages
					current.lastStepAt = now
					grow(current)
					return
				}
				const flight: Flight = {
					...fresh0,
					type: direction,
					heading: direction,
					ms,
					startedAt: now,
					lifting: old.single,
					lift: null,
					landing: null,
					land: null,
					kept: [],
					shape: {
						single: true,
						forward,
						eye: single,
						left: old.single.style.left,
						width: old.single.style.width,
						order
					}
				}
				flights.push(flight)
				flight.lift = animate(flight, old.single, swung(single, true), "left", 990 - order)
				if (pages > 1) grow(flight)
				return
			}
			if (
				current !== undefined &&
				current.landing === old.single &&
				!current.landingStarted &&
				(current.multi || now - current.startedAt < current.ms / 3)
			) {
				// The page coming down has barely started: this one will come down in its place, after more leaves.
				current.land?.cancel()
				current.land = null
				letGo(old.single)
				current.landing = fresh.single
				current.pages += pages
				current.lastStepAt = now
				grow(current)
				return
			}
			const flight: Flight = {
				...fresh0,
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
				shape: {
					single: true,
					forward,
					eye: single,
					left: fresh.single.style.left,
					width: fresh.single.style.width,
					order
				}
			}
			flights.push(flight)
			if (!flights.some((other) => other.landing === old.single)) old.single.style.zIndex = "1"
			if (pages > 1) grow(flight)
			else flight.land = animate(flight, fresh.single, swung(single, false), "left", 300 + order)
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
			!current.landingStarted &&
			(current.multi || now - current.startedAt < current.ms / 2)
		) {
			/*
			 * The page the last turn was going to lay has not shown yet: this step joins
			 * that turn. The page it brings is the one that will be laid, and the turn
			 * grows to the length of the move it now covers.
			 */
			current.land?.cancel()
			current.land = null
			letGo(under)
			letGo(lifting)
			current.landing = landing
			current.pages += pages
			current.lastStepAt = now
			grow(current)
			return
		}

		const flight: Flight = {
			...fresh0,
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
			shape: {
				single: false,
				forward,
				eye: spread,
				left: lifting.style.left,
				width: lifting.style.width,
				order
			}
		}
		flights.push(flight)
		if (!flights.some((other) => other.landing === under)) under.style.zIndex = "1"
		// On the side leaves lift from, the older is on top; on the side they land, the newer.
		flight.lift = animate(flight, lifting, lifted(sign, spread), hinge, 990 - order)
		if (pages > 1) grow(flight)
		else flight.land = animate(flight, landing, laid(-sign, spread), lands, 300 + order)
	}

	return {
		step,
		snap,
		get flying() {
			return flights.filter((flight) => !flight.done).length
		}
	}
}
