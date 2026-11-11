/**
 * A figure opening over the page: the plate lifted into the viewer, and set back.
 *
 * Like a project (`shell/project.ts`), a figure is looked at, not turned to, so it
 * opens as a zoom: the plate on the page and the picture in the viewer carry the
 * same transition name (`figure`), and one grows into the other. The address says
 * which figure is open (`?figure=2`), so the router runs the opening
 * (`shell/route-turns.ts`); closing with a key or a click is run here, before the
 * address is put back.
 */
import { nextTick } from "vue"
import type { LocationQuery } from "vue-router"
import { visibleTwin } from "./cursor.js"
import type { Shell } from "./shell.js"
import { zoom } from "./turns.js"

/** The figure a location has open, counted from one, or `null`. */
export const figureOf = (query: LocationQuery): string | null => {
	const value = query["figure"]
	return typeof value === "string" && value !== "" ? value : null
}

/** The picture of a figure on the screen being read: the copy of it that shows. */
export const plateOf = (figure: string): HTMLElement | null => {
	const selector = `.Page [data-figure="${CSS.escape(figure)}"] figure.Plate`
	for (const plate of document.querySelectorAll<HTMLElement>(selector)) {
		if (plate.closest("[data-measure]") !== null) continue
		return visibleTwin(plate).querySelector<HTMLElement>("img")
	}
	return null
}

/** Name a plate's picture for the zoom, or take the name off again. */
export const namePlate = (picture: HTMLElement | null, on: boolean): void => {
	if (picture !== null) picture.style.viewTransitionName = on ? "figure" : ""
}

/** The figure whose picture the viewer is showing, by its address in the page. */
const openPlate = (): HTMLElement | null => {
	const figure = new URLSearchParams(window.location.search).get("figure")
	return figure === null ? null : plateOf(figure)
}

/** Close the viewer, setting the picture back on its plate. */
export const closeFigure = (shell: Shell): void => {
	if (shell.dialog?.kind !== "zoom") return
	const plate = openPlate()
	void zoom("close", async () => {
		shell.dialog = null
		await nextTick()
		namePlate(plate, true)
	}).then(() => namePlate(plate, false))
}
