/**
 * Route changes as page turns.
 *
 * Going to another section, or opening an article or a project, turns the paper
 * the way the pager turns a spread: the same View Transition over the same leaves,
 * with the nameplate changed in the masthead (`plate` in `styles/turns.css`). The
 * direction is the order of the paper: the front page, the library, the blog, the
 * ledger, and a page inside a section after the section's own front.
 *
 * The guard runs after the data loaders (it is registered after `DataLoaderPlugin`'s,
 * and guards run in order), so the new route has its data when the turn starts.
 * The old screen is captured first; then the navigation commits, and the new
 * screen is captured once its pager has laid out (`shell.layouts` moves), so the
 * turn never lands on an empty page.
 *
 * A change of query alone (`?page=3`, `?figure=2`) is not a route turn: the pager
 * turns its own pages, and a figure opens over the page. A project opening or
 * closing over the page (`?open=`) is a zoom instead (`shell/project.ts`).
 */
import { nextTick, onBeforeUnmount, watch } from "vue"
import type { Router } from "vue-router"
import { cardOf, nameCard, openOf, shown } from "./project.js"
import type { Shell } from "./shell.js"
import { directionOf, turn, zoom } from "./turns.js"

/** How long a turn waits for the new page to lay out before it lands anyway. */
const LAYOUT_TIMEOUT = 1200

const laidOut = (shell: Shell, since: number): Promise<void> =>
	new Promise((resolve) => {
		let stop: (() => void) | null = null
		const timer = window.setTimeout(() => {
			stop?.()
			resolve()
		}, LAYOUT_TIMEOUT)
		stop = watch(
			() => shell.layouts,
			(count) => {
				if (count === since) return
				window.clearTimeout(timer)
				stop?.()
				resolve()
			}
		)
	})

export const useRouteTurns = (shell: Shell, router: Router): void => {
	const remove = router.beforeResolve((to, from) => {
		// The first navigation renders the page; there is nothing to turn from.
		if (from.matched.length === 0) return
		if (to.path === from.path) return zoomFor(openOf(from.query), openOf(to.query))
		return new Promise<void>((captured) => {
			const since = shell.layouts
			void turn(
				directionOf(from.path, to.path),
				async () => {
					captured()
					await laidOut(shell, since)
					await nextTick()
				},
				"route"
			)
		})
	})
	onBeforeUnmount(remove)

	/**
	 * A project opening, closing, or giving way to the next, as a zoom. The old
	 * screen is captured with the card named, the new one with the dialog named; on
	 * the way back, the dialog first and the card it returns to after.
	 */
	const zoomFor = (before: string | null, after: string | null): Promise<void> | undefined => {
		if (before === after) return undefined
		const mode = before === null ? "open" : after === null ? "close" : "swap"
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
}
