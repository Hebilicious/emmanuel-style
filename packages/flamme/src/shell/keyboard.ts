/**
 * The keyboard layer: every shortcut the site answers, in one handler.
 *
 * The site is read with the keyboard, the way a pager is driven in a terminal.
 * One listener owns every key, because splitting them across modules is what
 * once left a `g` armed in one closure and its second key delivered to another.
 *
 *   g h · g l · g b · g e    home, library, blog, experience (marked in the bar)
 *   g t · t                  switch the theme
 *   ← ↓ ↑ → · h j k l        move the cursor across the screen; past its edge, turn
 *   n · p                    next and previous page (also PageDown PageUp, Space)
 *   g g · G                  first and last row
 *   Home · End               first and last page
 *   Enter                    follow the row: open a link, a project, a figure
 *   / · : · ?                open the prompt (? prints the help)
 *   Ctrl+`                   open or close the prompt
 *   Esc                      close whatever is open
 *
 * The arrows move the way the eye does. Left and right go to the row beside the
 * cursor, so a row of cards or a line of links is crossed without leaving the
 * page; only from the last row on that side do they turn the page, and the cursor
 * lands on the facing side of the next spread at the height it left. Down and up
 * keep to the column, then carry on in reading order, and turn at the end.
 *
 * Every shortcut is a plain key with no modifier, so none of them collides with a
 * browser binding, and a key with Ctrl, Alt or Meta held is left to the browser.
 * While a dialog is open it owns the keyboard; while the prompt has focus, typing
 * goes to the prompt.
 */
import { nextTick, onBeforeUnmount, onMounted } from "vue"
import type { Router } from "vue-router"
import {
	clearCursor,
	cursorRow,
	describe,
	type Heading,
	nearest,
	nearestOnSide,
	placeCursor,
	type Row,
	rows
} from "./cursor.js"
import { SECTIONS } from "./sections.js"
import { type Shell, setMouse, toggleTheme } from "./shell.js"

const typing = (target: EventTarget | null): boolean =>
	target instanceof HTMLInputElement ||
	target instanceof HTMLTextAreaElement ||
	(target instanceof HTMLElement && target.isContentEditable)

export interface Keyboard {
	/** Put the cursor on the screen just shown: where a turn said to land, or the first row. */
	home(): void
	/** Open the prompt, optionally with a command already run. */
	openPrompt(command?: string): void
}

/** Where the cursor goes on the screen a turn brings in. */
type Landing =
	| { readonly at: "first" }
	| { readonly at: "last" }
	| { readonly at: "side"; readonly side: "left" | "right"; readonly y: number }

const ARROWS: Readonly<Record<string, Heading>> = {
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowUp: "up",
	ArrowDown: "down",
	h: "left",
	l: "right",
	k: "up",
	j: "down"
}

export const useKeyboard = (
	shell: Shell,
	router: Router,
	prompt: { open(command?: string): void; close(): void }
): Keyboard => {
	/** The place in reading order of the row last placed, for when it has gone. */
	let index = 0
	let armed = false
	let landing: Landing | null = null

	const place = (row: Row | undefined, list: readonly Row[]) => {
		if (row === undefined) {
			clearCursor()
			shell.focus = ""
			return
		}
		index = list.indexOf(row)
		shell.focus = placeCursor(row)
	}

	const placeAt = (at: number) => {
		const list = rows()
		place(list[Math.max(0, Math.min(at, list.length - 1))], list)
	}

	const home = () => {
		const land = landing
		landing = null
		void nextTick(() =>
			requestAnimationFrame(() => {
				const list = rows()
				if (land?.at === "side") place(nearestOnSide(list, land.side, land.y), list)
				else place(land?.at === "last" ? list.at(-1) : list[0], list)
			})
		)
	}

	/** Turn the page from an edge of the screen, if there is a page that way. */
	const turnFrom = (heading: Heading, from: Row | undefined) => {
		const turner = shell.turner
		const position = shell.position
		if (turner === null || position === null) return
		const forward = heading === "down" || heading === "right"
		if (forward ? position.current >= position.total : position.current <= 1) return
		const y = from?.box.top ?? 0
		landing =
			heading === "right"
				? { at: "side", side: "left", y }
				: heading === "left"
					? { at: "side", side: "right", y }
					: heading === "down"
						? { at: "first" }
						: { at: "last" }
		turner.turn(forward ? 1 : -1)
	}

	const move = (heading: Heading) => {
		const list = rows()
		const from = cursorRow(list)
		if (from === undefined) {
			// Nothing marked on this screen: the first move puts the cursor on it.
			if (list.length > 0) place(list[Math.min(index, list.length - 1)], list)
			else turnFrom(heading, undefined)
			return
		}
		let next = nearest(from, heading, list)
		if (next === undefined && (heading === "down" || heading === "up")) {
			next = list[list.indexOf(from) + (heading === "down" ? 1 : -1)]
		}
		if (next !== undefined) place(next, list)
		else turnFrom(heading, from)
	}

	/** Enter follows the row: a synthetic click, which the mouse gate lets through. */
	const follow = () => {
		const list = rows()
		const row = cursorRow(list) ?? list[index]
		row?.element.click()
	}

	const dialogKeys = (event: KeyboardEvent): boolean => {
		const dialog = shell.dialog
		if (dialog === null) return false
		const key = event.key
		if (dialog.kind === "gate") {
			if (key === "y" || key === "Y" || key === "Enter") {
				setMouse(shell, true)
				shell.dialog = null
			} else if (key === "n" || key === "N") {
				setMouse(shell, false)
				shell.dialog = null
			} else if (key === "Escape") shell.dialog = null
			else return true
		} else if (key === "Escape" || key === "Enter" || key === " " || key === "q") {
			shell.dialog = null
		} else return true
		event.preventDefault()
		return true
	}

	const onKey = (event: KeyboardEvent) => {
		if (event.key === "`" && event.ctrlKey) {
			event.preventDefault()
			if (shell.prompt) prompt.close()
			else prompt.open()
			return
		}

		if (shell.dialog !== null) {
			if (dialogKeys(event)) event.preventDefault()
			return
		}

		if (typing(event.target)) return
		if (event.metaKey || event.ctrlKey || event.altKey) return

		const key = event.key

		if (armed) {
			armed = false
			const section = SECTIONS.find((candidate) => candidate.key === key)
			if (section !== undefined) {
				event.preventDefault()
				void router.push(section.href)
				return
			}
			if (key === "t") {
				event.preventDefault()
				toggleTheme(shell)
				return
			}
			if (key === "g") {
				event.preventDefault()
				placeAt(0)
				return
			}
			// Any other key cancels the sequence and is handled as itself.
			const row = cursorRow()
			shell.focus = row ? describe(row.element) : ""
		}

		const heading = ARROWS[key]
		if (heading !== undefined) {
			event.preventDefault()
			move(heading)
			return
		}

		switch (key) {
			case "g":
				event.preventDefault()
				armed = true
				shell.focus = "g …"
				return
			case "t":
				event.preventDefault()
				toggleTheme(shell)
				return
			case "/":
			case ":":
				event.preventDefault()
				prompt.open()
				return
			case "?":
				event.preventDefault()
				prompt.open("help")
				return
			case "G":
				event.preventDefault()
				placeAt(Number.MAX_SAFE_INTEGER)
				return
			case "n":
			case "PageDown":
				event.preventDefault()
				shell.turner?.turn(1)
				return
			case "p":
			case "PageUp":
				event.preventDefault()
				shell.turner?.turn(-1)
				return
			case " ":
				event.preventDefault()
				shell.turner?.turn(event.shiftKey ? -1 : 1)
				return
			case "Home":
				event.preventDefault()
				shell.turner?.go(0)
				return
			case "End":
				event.preventDefault()
				shell.turner?.go(Number.MAX_SAFE_INTEGER)
				return
			case "Enter":
				event.preventDefault()
				follow()
				return
			case "Escape":
				if (shell.prompt) prompt.close()
				return
			default:
		}
	}

	onMounted(() => document.addEventListener("keydown", onKey))
	onBeforeUnmount(() => document.removeEventListener("keydown", onKey))

	return { home, openPrompt: (command?: string) => prompt.open(command) }
}
