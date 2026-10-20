/**
 * Opening a project: the card lifted off the page into a dialog.
 *
 * A project opens over whatever page it is on, and the address says so:
 * `/library?page=3&open=agris`. Turning pages stays what it is, a turn of the
 * paper; a project is looked at, not turned to. The open is pushed, so the back
 * button closes it, and a link with `?open=` opens the page with the project on it.
 *
 * The transition itself is run by the router (`shell/route-turns.ts`), so a click,
 * the back button and a link all get it: the card of the project is named for the
 * zoom, then the dialog is, and one grows into the other. Only the copy of the card
 * that shows is named: the pager draws every row twice, once per leaf, and two
 * elements with one name abort the transition.
 */
import { watch } from "vue"
import type { LocationQuery, Router } from "vue-router"
import { visibleTwin } from "./cursor.js"
import type { Shell } from "./shell.js"

/** The project a location has open, or `null`. */
export const openOf = (query: LocationQuery): string | null => {
	const value = query["open"]
	return typeof value === "string" && value !== "" ? value : null
}

/** Whether this visit pushed the open project, so closing it steps back rather than adds an entry. */
let pushed = false

const queryWith = (router: Router, open: string | undefined) => ({
	query: { ...router.currentRoute.value.query, open }
})

/** The address that opens a project over the current page. */
export const projectHref = (router: Router, name: string): string =>
	router.resolve(queryWith(router, name)).href

export const openProject = async (router: Router, name: string): Promise<void> => {
	pushed = true
	await router.push(queryWith(router, name))
}

export const closeProject = async (router: Router): Promise<void> => {
	if (pushed) {
		pushed = false
		router.back()
	} else {
		await router.replace(queryWith(router, undefined))
	}
}

/** Another project in the same dialog (`n`, `p`): replaced, so back still closes the dialog. */
export const swapProject = async (router: Router, name: string): Promise<void> => {
	await router.replace(queryWith(router, name))
}

/* ------------------------------------------------------- for the transition */

/** How long a zoom waits for the dialog (or the page under it) before it lands anyway. */
const WAIT = 700

/** Resolves once the dialog shows `name` (or has gone, for `null`), or after `WAIT`. */
export const shown = (shell: Shell, name: string | null): Promise<void> =>
	new Promise((resolve) => {
		if (shell.projectShown === name) {
			resolve()
			return
		}
		let stop: (() => void) | null = null
		const timer = window.setTimeout(() => {
			stop?.()
			resolve()
		}, WAIT)
		stop = watch(
			() => shell.projectShown,
			(value) => {
				if (value !== name) return
				window.clearTimeout(timer)
				stop?.()
				resolve()
			}
		)
	})

/** The card of a project on the screen being read, the copy of it that shows, if there is one. */
export const cardOf = (name: string): HTMLElement | null => {
	const card = document.querySelector<HTMLElement>(`.Page [data-project="${CSS.escape(name)}"]`)
	return card === null ? null : visibleTwin(card)
}

/** Name a card (and its plate) for the zoom, or take the names off again. */
export const nameCard = (card: HTMLElement | null, on: boolean): void => {
	if (card === null) return
	card.style.viewTransitionName = on ? "project" : ""
	const plate = card.querySelector<HTMLElement>("[data-project-plate]")
	if (plate) plate.style.viewTransitionName = on ? "project-plate" : ""
}
