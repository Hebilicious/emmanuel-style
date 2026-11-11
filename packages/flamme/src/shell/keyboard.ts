/**
 * The keyboard layer: every shortcut the site answers, in one handler.
 *
 * The site is read with the keyboard, the way a pager is driven in a terminal.
 * One listener owns every key, because splitting them across modules is what
 * once left a `g` armed in one closure and its second key delivered to another.
 *
 *   g h · g l · g b · g e · g s   home, library, blog, experience, skills (in the bar)
 *   g t · t                  switch the theme
 *   ← ↓ ↑ → · h j k l        move the cursor across the screen; past its edge, turn
 *   n · p                    next and previous page (also PageDown PageUp, Space)
 *   g g · G                  first and last row
 *   Home · End               first and last page
 *   Enter                    follow the row: open a link, a project, a figure
 *   n · p · Esc              in an open project: the next, the previous, close
 *   PageDown · PageUp · ] [  in an open project: turn its list of pull requests
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
 *
 * Which keys mean what depends on the mode the keyboard is in, and it is in exactly
 * one (`modeOf`):
 *
 *   typing    the prompt (or any field) has the focus: keys are text
 *   project   a project is open: arrows and Enter reach its links, n p Esc act on it
 *   gate      the mouse question is up: y, n, Esc
 *   figure    a figure is open: any closing key closes it
 *   leader    `g` was pressed: the next key picks a section, the theme, or the top
 *   reading   everything else: the table above
 *
 * Each mode has its own handler in `HANDLERS`, so a key can only do what its mode
 * lists; nothing reaches the reading keys while a dialog is open.
 */
import { nextTick, onBeforeUnmount, onMounted } from "vue"
import type { Router } from "vue-router"
import {
	clearCursor,
	cursorRow,
	describe,
	type Heading,
	homeRow,
	nearest,
	nearestOnSide,
	placeCursor,
	type Row,
	rows
} from "./cursor.js"
import { closeFigure } from "./figure.js"
import { createMachine } from "./machine.js"
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

/** The mode the keyboard is in: which table of keys applies. */
export type KeyMode = "typing" | "project" | "gate" | "figure" | "leader" | "reading"

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
	let landing: Landing | null = null

	/** The `g` prefix: armed by `g`, spent by the next key whatever it is. */
	const leader = createMachine<"idle" | "armed", { type: "ARM" } | { type: "SPEND" }>("idle", {
		idle: { ARM: "armed" },
		armed: { SPEND: "idle" }
	})
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
				else if (land?.at === "last") place(list.at(-1), list)
				else if (land?.at === "first")
					place(list.find((row) => row.element.closest("[data-leaf]")) ?? list[0], list)
				else place(homeRow(list), list)
			})
		)
	}

	/** Turn the page from an edge of the screen, if there is a page that way. */
	const turnFrom = (heading: Heading, from: Row | undefined) => {
		const turner = shell.turner
		const position = shell.position
		// The pages under an open dialog stay where they are.
		if (turner === null || position === null || shell.dialog !== null) return
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

	const modeOf = (event: KeyboardEvent): KeyMode => {
		if (typing(event.target)) return "typing"
		const dialog = shell.dialog
		if (dialog !== null) return dialog.kind === "zoom" ? "figure" : dialog.kind
		return leader.is("armed") ? "leader" : "reading"
	}

	/** A handler says whether it used the key; a used key is kept from the browser. */
	const HANDLERS: Readonly<Record<KeyMode, (key: string, event: KeyboardEvent) => boolean>> = {
		typing: () => false,

		/*
		 * An open project is read like a page: the arrows and Enter reach its links,
		 * `n` and `p` go to the next and previous project, Esc sets it back down. Tab
		 * is left to the browser, which keeps the focus inside the dialog's links.
		 */
		project: (key) => {
			const heading = ARROWS[key]
			if (heading !== undefined) move(heading)
			else if (key === "Enter") follow()
			else if (key === "n") shell.project?.next()
			else if (key === "p") shell.project?.previous()
			else if (key === "PageDown" || key === "]") shell.project?.page(1)
			else if (key === "PageUp" || key === "[") shell.project?.page(-1)
			else if (key === "Escape" || key === "q") shell.project?.close()
			else return false
			return true
		},

		gate: (key) => {
			if (key === "y" || key === "Y" || key === "Enter") setMouse(shell, true)
			else if (key === "n" || key === "N") setMouse(shell, false)
			else if (key !== "Escape") return true
			shell.dialog = null
			return true
		},

		figure: (key) => {
			if (key === "Escape" || key === "Enter" || key === " " || key === "q") closeFigure(shell)
			return true
		},

		leader: (key, event) => {
			leader.send({ type: "SPEND" })
			const section = SECTIONS.find((candidate) => candidate.key === key)
			if (section !== undefined) void router.push(section.href)
			else if (key === "t") toggleTheme(shell)
			else if (key === "g") placeAt(0)
			else {
				// Any other key cancels the sequence and is handled as itself.
				const row = cursorRow()
				shell.focus = row ? describe(row.element) : ""
				return HANDLERS.reading(key, event)
			}
			return true
		},

		reading: (key, event) => {
			const heading = ARROWS[key]
			if (heading !== undefined) {
				move(heading)
				return true
			}
			switch (key) {
				case "g":
					leader.send({ type: "ARM" })
					shell.focus = "g …"
					return true
				case "t":
					toggleTheme(shell)
					return true
				case "/":
				case ":":
					prompt.open()
					return true
				case "?":
					prompt.open("help")
					return true
				case "G":
					placeAt(Number.MAX_SAFE_INTEGER)
					return true
				case "n":
				case "PageDown":
					shell.turner?.turn(1)
					return true
				case "p":
				case "PageUp":
					shell.turner?.turn(-1)
					return true
				case " ":
					shell.turner?.turn(event.shiftKey ? -1 : 1)
					return true
				case "Home":
					shell.turner?.go(0)
					return true
				case "End":
					shell.turner?.go(Number.MAX_SAFE_INTEGER)
					return true
				case "Enter":
					follow()
					return true
				case "Escape":
					if (shell.prompt) prompt.close()
					return false
				default:
					return false
			}
		}
	}

	const onKey = (event: KeyboardEvent) => {
		if (event.key === "`" && event.ctrlKey) {
			event.preventDefault()
			if (shell.prompt) prompt.close()
			else prompt.open()
			return
		}
		const mode = modeOf(event)
		// A key with a modifier held is the browser's, except where a dialog owns every key.
		const modified = event.metaKey || event.ctrlKey || event.altKey
		if (modified && mode !== "gate" && mode !== "figure") return
		if (HANDLERS[mode](event.key, event)) event.preventDefault()
	}

	onMounted(() => document.addEventListener("keydown", onKey))
	onBeforeUnmount(() => document.removeEventListener("keydown", onKey))

	return { home, openPrompt: (command?: string) => prompt.open(command) }
}
