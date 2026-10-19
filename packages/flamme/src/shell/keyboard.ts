/**
 * The keyboard layer: every shortcut the site answers, in one handler.
 *
 * The site is read with the keyboard, the way a pager is driven in a terminal.
 * One listener owns every key, because splitting them across modules is what
 * once left a `g` armed in one closure and its second key delivered to another.
 *
 *   g h · g l · g b · g e    home, library, blog, experience
 *   g t · t                  switch the theme
 *   n · p                    next and previous page (also → ←, PageDown PageUp, Space)
 *   j · k                    next and previous row (also ↓ ↑)
 *   g g · G                  first and last row
 *   Enter                    follow the row: open a link, a repository card, a figure
 *   / · : · ?                open the prompt (? prints the help)
 *   Ctrl+`                   open or close the prompt
 *   Esc                      close whatever is open
 *
 * Every shortcut is a plain key with no modifier, so none of them collides with a
 * browser binding, and a key with Ctrl, Alt or Meta held is left to the browser.
 * While a dialog is open it owns the keyboard; while the prompt has focus, typing
 * goes to the prompt.
 */
import { nextTick, onBeforeUnmount, onMounted } from "vue"
import type { Router } from "vue-router"
import { clearCursor, cursorTargets, describe, placeCursor } from "./cursor.js"
import { SECTIONS } from "./sections.js"
import { setMouse, type Shell, toggleTheme } from "./shell.js"

const typing = (target: EventTarget | null): boolean =>
	target instanceof HTMLInputElement ||
	target instanceof HTMLTextAreaElement ||
	(target instanceof HTMLElement && target.isContentEditable)

export interface Keyboard {
	/** Put the cursor on the first row of the screen. */
	home(): void
	/** Open the prompt, optionally with a command already run. */
	openPrompt(command?: string): void
}

export const useKeyboard = (
	shell: Shell,
	router: Router,
	prompt: { open(command?: string): void; close(): void }
): Keyboard => {
	let index = 0
	let armed = false

	const move = (next: number) => {
		const rows = cursorTargets()
		if (rows.length === 0) {
			clearCursor()
			shell.focus = ""
			return
		}
		index = Math.max(0, Math.min(next, rows.length - 1))
		const row = rows[index]
		if (row) shell.focus = placeCursor(row)
	}

	/** Where the cursor is now, which a footnote jump or a click may have moved. */
	const position = () => {
		const marked = cursorTargets().findIndex((row) => row.hasAttribute("data-cursor"))
		return marked === -1 ? index : marked
	}

	const home = () => {
		index = 0
		void nextTick(() => requestAnimationFrame(() => move(0)))
	}

	const current = (): HTMLElement | null => {
		const marked = document.querySelector<HTMLElement>(".Page [data-cursor]")
		if (marked && cursorTargets().includes(marked)) return marked
		return cursorTargets()[index] ?? null
	}

	/** Enter follows the row: a synthetic click, which the mouse gate lets through. */
	const follow = () => {
		const row = current()
		if (row) row.click()
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
		} else if (dialog.kind === "repo") {
			if (key === "o" || key === "O" || key === "Enter") {
				window.open(dialog.repo.url, "_blank", "noopener,noreferrer")
				shell.dialog = null
			} else if ((key === "s" || key === "S") && dialog.repo.homepage) {
				window.open(dialog.repo.homepage, "_blank", "noopener,noreferrer")
				shell.dialog = null
			} else if (key === "Escape" || key === "q") shell.dialog = null
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
				move(0)
				return
			}
			// Any other key cancels the sequence and is handled as itself.
			const row = current()
			shell.focus = row ? describe(row) : ""
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
			case "j":
			case "ArrowDown":
				event.preventDefault()
				move(position() + 1)
				return
			case "k":
			case "ArrowUp":
				event.preventDefault()
				move(position() - 1)
				return
			case "G":
				event.preventDefault()
				move(cursorTargets().length - 1)
				return
			case "n":
			case "ArrowRight":
			case "PageDown":
				event.preventDefault()
				shell.turner?.turn(1)
				return
			case "p":
			case "ArrowLeft":
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
