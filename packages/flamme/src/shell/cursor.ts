/**
 * The reading cursor: one highlighted row, moved with `j` and `k`.
 *
 * A terminal has no pointer, so the way to reach a link is the way a vim user
 * expects: a highlighted row, moved a step at a time, and Enter to follow it.
 * The rows are whatever the current screen shows that can be acted on, in reading
 * order; nothing off screen can be reached, because the pager only renders the
 * screen being read, and a part of a block clipped off a page is skipped.
 */

/** What the cursor can land on, in document order. */
const SELECTABLE = [
	"[data-row]",
	".Page .Prose a[href]",
	".Page figure.Plate",
	".Page .Notes a[href]"
].join(",")

/** The element's box, unless the page it is on clips it out of sight. */
const visible = (element: HTMLElement): boolean => {
	if (element.closest("[data-measure], [hidden], [inert]")) return false
	const box = element.getBoundingClientRect()
	if (box.width === 0 || box.height === 0) return false
	const clip = element.closest<HTMLElement>("[data-clip]")
	if (clip === null) return true
	const frame = clip.getBoundingClientRect()
	const overlap = Math.min(box.bottom, frame.bottom) - Math.max(box.top, frame.top)
	return overlap >= Math.min(box.height, 12) * 0.6
}

export const cursorTargets = (root: ParentNode = document): HTMLElement[] => {
	const pane = root.querySelector<HTMLElement>(".Page")
	if (pane === null) return []
	const seen = new Set<string>()
	return Array.from(pane.querySelectorAll<HTMLElement>(SELECTABLE)).filter((element) => {
		if (!visible(element)) return false
		/*
		 * A paragraph split across two columns is rendered in both, so the same link
		 * can appear twice on one screen. Only the first copy that shows is a row.
		 */
		const key = element.dataset["rowKey"]
		if (key !== undefined) {
			if (seen.has(key)) return false
			seen.add(key)
		}
		return true
	})
}

/** A short name for a row, for the status line. */
export const describe = (element: HTMLElement): string => {
	const named =
		element.dataset["label"] ??
		element.querySelector("[data-label-text]")?.textContent ??
		element.getAttribute("aria-label") ??
		element.querySelector("figcaption")?.textContent ??
		element.textContent ??
		""
	return named.replace(/\s+/g, " ").trim().slice(0, 48)
}

export const clearCursor = (): void => {
	for (const element of document.querySelectorAll<HTMLElement>("[data-cursor]")) {
		element.removeAttribute("data-cursor")
	}
}

/**
 * Put the cursor on one row and return its name.
 *
 * Real focus moves with it, so Enter, assistive technology and the drawn highlight
 * all agree on which row is current. The one exception is a reader typing in the
 * prompt: the row is marked, and the focus stays in the prompt.
 */
export const placeCursor = (element: HTMLElement): string => {
	clearCursor()
	element.setAttribute("data-cursor", "true")
	const active = document.activeElement
	const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
	if (!typing) {
		// A row that is not focusable by nature (a figure, a library entry) is made
		// focusable by script only, so it never becomes a Tab stop.
		if (!element.matches("a[href], button, input, [tabindex]")) element.tabIndex = -1
		element.focus({ preventScroll: true })
	}
	return describe(element)
}
