/**
 * The reading cursor: one highlighted row, moved with the arrows or `h j k l`.
 *
 * A terminal has no pointer, so the way to reach a link is the way a vim user
 * expects: a highlighted row, moved a step at a time, and Enter to follow it.
 * The rows are whatever the current screen shows that can be acted on; nothing off
 * screen can be reached, because the pager only renders the screen being read, and
 * a part of a block clipped off a page is skipped.
 *
 * The pager draws a screen on two leaves, each carrying the whole screen and
 * showing its half (`components/Pager.vue`), so every row exists twice: once in
 * the left leaf and once in the right. The two copies are twins, paired by their
 * order in the leaf. A row is wherever one of its twins shows; the highlight is
 * drawn on both, so it shows whichever half the row is on, and focus goes to the
 * left twin, the one assistive technology reads (the right leaf is hidden from it).
 * A route can also put rows outside the pager (the ledger's progress bar); they
 * are rows like the others, in the order of the page.
 *
 * While a dialog that holds rows is open (a project, `[data-cursor-scope]`), the
 * cursor moves inside it and nowhere else.
 */

/** What the cursor can land on. */
const SELECTABLE = ["[data-row]", ".Prose a[href]", "figure.Plate", ".Notes a[href]"].join(",")

/** Where the rows are: an open dialog that holds some, or the reading pane. */
const scopeOf = (root: ParentNode): HTMLElement | null =>
	root.querySelector<HTMLElement>("[data-cursor-scope]") ?? root.querySelector<HTMLElement>(".Page")

export interface Row {
	/** The copy that takes focus and is followed with Enter. */
	readonly element: HTMLElement
	/** Every copy of the row, the highlight drawn on each. */
	readonly twins: readonly HTMLElement[]
	/** The part of the row on screen. */
	readonly box: DOMRect
}

/**
 * The part of an element left on screen once every clipping box around it (a
 * page cut out of a block, the leaf it is drawn on) has cut it, or `null`.
 */
const shown = (element: HTMLElement): DOMRect | null => {
	if (element.closest("[data-measure], [hidden], [inert]")) return null
	const box = element.getBoundingClientRect()
	if (box.width === 0 || box.height === 0) return null
	let { left, top, right, bottom } = box
	for (
		let clip = element.closest<HTMLElement>("[data-clip]");
		clip !== null;
		clip = clip.parentElement?.closest<HTMLElement>("[data-clip]") ?? null
	) {
		const frame = clip.getBoundingClientRect()
		left = Math.max(left, frame.left)
		top = Math.max(top, frame.top)
		right = Math.min(right, frame.right)
		bottom = Math.min(bottom, frame.bottom)
	}
	// A row is on screen when most of a line of it is: a sliver at a cut does not count.
	const lineHeight = Math.min(box.height, 12) * 0.6
	if (bottom - top < lineHeight || right - left < 4) return null
	return new DOMRect(left, top, right - left, bottom - top)
}

const union = (a: DOMRect, b: DOMRect): DOMRect => {
	const left = Math.min(a.left, b.left)
	const top = Math.min(a.top, b.top)
	return new DOMRect(
		left,
		top,
		Math.max(a.right, b.right) - left,
		Math.max(a.bottom, b.bottom) - top
	)
}

/** The rows of the current screen, in reading order: the left page, then the right. */
export const rows = (root: ParentNode = document): Row[] => {
	const pane = scopeOf(root)
	if (pane === null) return []
	const leaves = Array.from(pane.querySelectorAll<HTMLElement>("[data-leaf]"))
	const copies = leaves.map((leaf) => Array.from(leaf.querySelectorAll<HTMLElement>(SELECTABLE)))
	const groups: HTMLElement[][] = []
	for (const element of pane.querySelectorAll<HTMLElement>(SELECTABLE)) {
		const leaf = element.closest<HTMLElement>("[data-leaf]")
		if (leaf === null) {
			groups.push([element])
			continue
		}
		// A row in a leaf is grouped with its twins once, from the first leaf.
		if (leaf !== leaves[0]) continue
		const index = copies[0]?.indexOf(element) ?? -1
		groups.push([element, ...copies.slice(1).flatMap((copy) => copy[index] ?? [])])
	}

	const seen = new Set<string>()
	const found: Row[] = []
	for (const twins of groups) {
		const boxes = twins.map(shown)
		const visible = boxes.filter((box): box is DOMRect => box !== null)
		const [head, ...rest] = visible
		if (head === undefined) continue
		const element = twins[0] as HTMLElement
		/*
		 * A paragraph split across two columns is rendered in both, so the same link
		 * can show twice on one screen. Only the first copy that shows is a row.
		 */
		const key = element.dataset["rowKey"]
		if (key !== undefined) {
			if (seen.has(key)) continue
			seen.add(key)
		}
		found.push({ element, twins, box: rest.reduce(union, head) })
	}
	// The left leaf lays the screen out in reading order: column by column, top to bottom.
	return found
}

/** The row an element belongs to, if it is a copy of one. */
export const rowOf = (element: Element, list: readonly Row[] = rows()): Row | undefined => {
	const target = element.closest<HTMLElement>(SELECTABLE)
	if (target === null) return undefined
	return list.find((row) => row.twins.includes(target))
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
 * all agree on which row is current. Two exceptions: a reader typing in the prompt
 * keeps the focus there, and the mouse (`focus: false`) only draws the highlight, so
 * hovering does not pull the focus around under the reader.
 */
export const placeCursor = (
	target: HTMLElement | Row,
	options: { focus?: boolean } = {}
): string => {
	const row =
		target instanceof HTMLElement ? (rowOf(target) ?? { element: target, twins: [target] }) : target
	clearCursor()
	for (const twin of row.twins) twin.setAttribute("data-cursor", "true")
	const active = document.activeElement
	const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
	if (!typing && options.focus !== false) {
		const element = row.element
		// A row that is not focusable by nature (a figure, a library entry) is made
		// focusable by script only, so it never becomes a Tab stop.
		if (!element.matches("a[href], button, input, [tabindex]")) element.tabIndex = -1
		element.focus({ preventScroll: true })
	}
	return describe(row.element)
}

/**
 * The copy of a row that is on screen, for a transition that starts from it (a
 * project's card zooming into its dialog): the twin that is clipped away would be
 * captured as nothing.
 */
export const visibleTwin = (element: HTMLElement): HTMLElement => {
	const row = rowOf(element)
	return row?.twins.find((twin) => shown(twin) !== null) ?? element
}

/**
 * Where the cursor starts on a screen: the row the page marks as its way on
 * (`data-cursor-home`: a landing page's call to action, the Library on the front
 * page), or the first row of the reading pane, or the row that marks where the
 * reader is (`aria-current`: the ledger's progress bar), or the first row at all.
 */
export const homeRow = (list: readonly Row[]): Row | undefined =>
	list.find((row) => row.element.hasAttribute("data-cursor-home")) ??
	list.find((row) => row.element.closest("[data-leaf]") !== null) ??
	list.find((row) => row.element.hasAttribute("aria-current")) ??
	list[0]

/** The row the cursor is on, if it is still on screen. */
export const cursorRow = (list: readonly Row[] = rows()): Row | undefined =>
	list.find((row) => row.twins.some((twin) => twin.hasAttribute("data-cursor")))

/* ------------------------------------------------------------- moving it */

export type Heading = "up" | "down" | "left" | "right"

/** The gap between two spans on one axis, zero where they overlap. */
const gap = (a0: number, a1: number, b0: number, b1: number): number =>
	Math.max(0, b0 - a1, a0 - b1)

/**
 * The nearest row in a direction, the way a reader's eye goes: across the page for
 * left and right, preferring a row on the same line; down or up the same column
 * for down and up. `undefined` when there is none that way.
 */
export const nearest = (from: Row, heading: Heading, list: readonly Row[]): Row | undefined => {
	const a = from.box
	let best: Row | undefined
	let score = Number.POSITIVE_INFINITY
	for (const row of list) {
		if (row === from) continue
		const b = row.box
		let along: number
		let across: number
		const ax = a.left + a.width / 2
		const bx = b.left + b.width / 2
		switch (heading) {
			case "right":
				if (bx <= ax + 2 || b.left <= a.left) continue
				along = Math.max(0, b.left - a.right)
				across = gap(a.top, a.bottom, b.top, b.bottom) * 3
				break
			case "left":
				if (bx >= ax - 2 || b.right >= a.right) continue
				along = Math.max(0, a.left - b.right)
				across = gap(a.top, a.bottom, b.top, b.bottom) * 3
				break
			case "down":
				if (b.top < a.bottom - 2) continue
				// Down stays in the column: a row beside it is reached with left and right.
				if (gap(a.left, a.right, b.left, b.right) > 0) continue
				along = b.top - a.bottom
				across = Math.abs(b.left - a.left) / 2
				break
			case "up":
				if (b.bottom > a.top + 2) continue
				if (gap(a.left, a.right, b.left, b.right) > 0) continue
				along = a.top - b.bottom
				across = Math.abs(b.left - a.left) / 2
				break
		}
		// Across the page, a row off the line counts for more than distance along it.
		const candidate = along + across
		if (candidate < score) {
			score = candidate
			best = row
		}
	}
	return best
}

/** The row nearest a height on one side of the screen, for landing after a turn. */
export const nearestOnSide = (
	list: readonly Row[],
	side: "left" | "right",
	y: number
): Row | undefined => {
	if (list.length === 0) return undefined
	const edge =
		side === "left"
			? Math.min(...list.map((row) => row.box.left))
			: Math.max(...list.map((row) => row.box.right))
	const band = list.filter((row) =>
		side === "left" ? row.box.left - edge < 80 : edge - row.box.right < 80
	)
	return band.reduce((best, row) =>
		Math.abs(row.box.top - y) < Math.abs(best.box.top - y) ? row : best
	)
}
