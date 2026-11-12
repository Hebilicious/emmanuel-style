/**
 * Route changes as page turns.
 *
 * Going to another section, or opening an article or a project, turns the paper
 * the way the pager turns a spread, and with the same leaves (`pager-flip.ts`):
 * the new page is drawn at once, and the old one is kept on the desk a moment
 * longer, pinned where it was, while its leaf turns over the new page. Nothing is
 * photographed or waited for, so going elsewhere costs what drawing the new page
 * costs: the reader can read, click and turn the new page while the old leaf is
 * still in the air. The nameplate in the masthead rises with the new section on
 * its own (`Bar.vue`). The direction is the order of the paper: the front page,
 * the library, the blog, the ledger, and a page inside a section after the
 * section's own front.
 *
 * The leaving page is moved out of the reading pane (`.Page`) onto the desk, so
 * whatever looks for the page being read (the cursor, footnotes, project cards)
 * never finds it, and it is inert.
 *
 * A change of query alone (`?page=3`, `?figure=2`) is not a route turn: the pager
 * turns its own pages, and a figure opens over the page. A project opening or
 * closing over the page (`?open=`) is a zoom instead (`shell/project.ts`).
 */
import { nextTick, onBeforeUnmount, watch } from "vue"
import type { Router } from "vue-router"
import { figureOf, namePlate, plateOf } from "./figure.js"
import { cardOf, nameCard, openOf, shown, swapDirection } from "./project.js"
import type { Shell } from "./shell.js"
import {
	createFlipper,
	type FlipDirection,
	type Leaves,
	leafDepth
} from "../components/pager-flip.js"
import { type Direction, directionOf, reducedMotion, zoom } from "./turns.js"

/** How long the old page waits for the new one to lay out before it turns anyway. */
const LAYOUT_TIMEOUT = 600
/** However the turn goes, the old page is gone after this long. */
const GONE_AFTER = 2000

/** The leaves of a screen, drawn: not the measuring pass, not a leaf already leaving. */
const leavesIn = (root: ParentNode): Leaves => {
	const found: Record<string, HTMLElement> = {}
	for (const leaf of root.querySelectorAll<HTMLElement>(".Spread > [data-leaf]")) {
		const name = leaf.dataset["leaf"]
		if (name !== undefined && found[name] === undefined) found[name] = leaf
	}
	return { left: found["left"], right: found["right"], single: found["single"] }
}

/** Resolve once a pager has laid out for the first time since `since`, or after `timeout`. */
const laidOut = (shell: Shell, since: number, timeout: number): Promise<void> =>
	new Promise((resolve) => {
		if (shell.layouts !== since) return resolve()
		let stop: (() => void) | null = null
		const timer = window.setTimeout(() => {
			stop?.()
			resolve()
		}, timeout)
		stop = watch(
			() => shell.layouts,
			() => {
				window.clearTimeout(timer)
				stop?.()
				resolve()
			}
		)
	})

/**
 * The turn between two routes, for the `<Transition>` around the route's page:
 * `leave` is handed the old page as it goes, and lets it go once its leaf has
 * turned over the new one.
 */
export interface RouteTurn {
	leave(element: Element, done: () => void): void
}

export const useRouteTurns = (shell: Shell, router: Router): RouteTurn => {
	/** The way the navigation being made goes, set before its page changes. */
	let heading: Direction | null = null
	/** The number of first layouts when it was made, to know the new page is drawn. */
	let since = 0
	/** The turn in the air, if any: a new one ends it before it starts. */
	let flying: { flipper: ReturnType<typeof createFlipper>; finish: () => void } | null = null

	const remove = router.beforeResolve((to, from) => {
		// The first navigation renders the page; there is nothing to turn from.
		if (from.matched.length === 0) return
		if (to.path === from.path) {
			return (
				figureFor(figureOf(from.query), figureOf(to.query)) ??
				zoomFor(openOf(from.query), openOf(to.query))
			)
		}
		heading = directionOf(from.path, to.path)
		since = shell.layouts
		return undefined
	})
	onBeforeUnmount(() => {
		remove()
		flying?.finish()
	})

	const leave = (element: Element, done: () => void): void => {
		const page = element as HTMLElement
		const direction: FlipDirection | null = heading
		heading = null
		flying?.finish()
		const pane = page.parentElement
		const desk = pane?.parentElement
		const old = leavesIn(page)
		if (
			direction === null ||
			reducedMotion() ||
			pane == null ||
			desk == null ||
			(old.left ?? old.right ?? old.single) === undefined
		) {
			done()
			return
		}

		/*
		 * Pinned on the desk where it was, out of the pane, seen only through its
		 * leaves. It covers the pane's box, padded back to where it sat, and is cut
		 * to that box as the pane cut it: a leaf coming toward the reader stays
		 * under the masthead. `overflow: clip` does that without making the page a
		 * stacking context of its own, which would put all of its leaves over or
		 * under all of the new page's, when they take turns.
		 */
		const { offsetTop: y, offsetLeft: x, offsetWidth: width, offsetHeight: height } = page
		const own = getComputedStyle(page)
		const px = (value: number) => `${value}px`
		Object.assign(page.style, {
			position: "absolute",
			top: px(pane.offsetTop + pane.clientTop),
			left: px(pane.offsetLeft + pane.clientLeft),
			width: px(pane.clientWidth),
			height: px(pane.clientHeight),
			boxSizing: "border-box",
			margin: "0",
			paddingTop: px(y + parseFloat(own.paddingTop)),
			paddingLeft: px(x + parseFloat(own.paddingLeft)),
			paddingRight: px(pane.clientWidth - x - width + parseFloat(own.paddingRight)),
			paddingBottom: px(pane.clientHeight - y - height + parseFloat(own.paddingBottom)),
			overflow: "clip",
			overflowClipMargin: "0px",
			visibility: "hidden",
			pointerEvents: "none"
		})
		page.inert = true
		page.dataset["leaving"] = ""
		for (const leaf of [old.left, old.right, old.single]) {
			if (leaf !== undefined) leaf.style.visibility = "visible"
		}
		desk.append(page)

		const flipper = createFlipper(leafDepth)
		let finished = false
		const finish = () => {
			if (finished) return
			finished = true
			window.clearTimeout(timer)
			if (flying?.flipper === flipper) flying = null
			flipper.snap()
			done()
		}
		const timer = window.setTimeout(finish, GONE_AFTER)
		flying = { flipper, finish }

		const waiting = [old.left, old.right, old.single].filter(
			(leaf): leaf is HTMLElement => leaf !== undefined
		)
		void laidOut(shell, since, LAYOUT_TIMEOUT)
			.then(() => nextTick())
			.then(() => {
				if (finished) return
				const fresh = leavesIn(pane)
				flipper.step(direction, 1, old, fresh, (leaf) => {
					const at = waiting.indexOf(leaf)
					if (at !== -1) waiting.splice(at, 1)
					if (waiting.length === 0) finish()
				})
			})
	}

	/**
	 * A figure opening, or closing with the back button (a key or a click closes it
	 * through `closeFigure`, and by the time the address follows it is already shut).
	 */
	const figureFor = (before: string | null, after: string | null): Promise<void> | undefined => {
		if (before === after) return undefined
		if (after === null && shell.dialog?.kind !== "zoom") return undefined
		const plate = plateOf(after ?? before ?? "")
		return new Promise<void>((captured) => {
			if (after !== null) namePlate(plate, true)
			void zoom(after === null ? "close" : "open", async () => {
				namePlate(plate, false)
				captured()
				// The article opens or shuts the viewer when it sees the address change.
				await nextTick()
				await nextTick()
				if (after === null) namePlate(plate, true)
			}).then(() => namePlate(plate, false))
		})
	}

	/**
	 * A project opening, closing, or giving way to the next, as a zoom. The old
	 * screen is captured with the card named, the new one with the dialog named; on
	 * the way back, the dialog first and the card it returns to after.
	 */
	const zoomFor = (before: string | null, after: string | null): Promise<void> | undefined => {
		if (before === after) return undefined
		const mode =
			before === null
				? "open"
				: after === null
					? "close"
					: swapDirection() === "next"
						? "swap"
						: "swap-back"
		return new Promise<void>((captured) => {
			const card = mode === "open" && after !== null ? cardOf(after) : null
			nameCard(card, true)
			let back: HTMLElement | null = null
			void zoom(mode, async () => {
				nameCard(card, false)
				captured()
				await shown(shell, after)
				await nextTick()
				if (mode === "close" && before !== null) {
					back = cardOf(before)
					nameCard(back, true)
				}
			}).then(() => nameCard(back, false))
		})
	}

	return { leave }
}
