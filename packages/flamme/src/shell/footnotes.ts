/**
 * Following a footnote on a paged screen.
 *
 * On a scrolling page a footnote is an anchor jump. Here there is nothing to
 * scroll to: the note is already at the foot of the column, on the same screen as
 * the sentence that cites it. Following the reference therefore moves the cursor
 * to the note and marks it for a moment, and the note's back link returns the
 * cursor to the reference.
 */
import { placeCursor } from "./cursor.js"
import type { Shell } from "./shell.js"

const flash = (element: HTMLElement) => {
	element.dataset["flash"] = "false"
	void element.offsetWidth
	element.dataset["flash"] = "true"
	window.setTimeout(() => delete element.dataset["flash"], 1500)
}

export const useFootnotes = (shell: Shell) => ({
	/** Follow a footnote link, if `anchor` is one. `true` when it was. */
	follow(anchor: HTMLAnchorElement): boolean {
		const screen = document.querySelector<HTMLElement>(".Page .Screen")
		if (screen === null) return false

		const note = anchor.dataset["footnoteRef"]
		if (note !== undefined) {
			const target = screen.querySelector<HTMLElement>(`[data-note="${CSS.escape(note)}"]`)
			if (target === null) return true
			flash(target)
			const back = target.querySelector<HTMLElement>("[data-footnote-back-to]")
			if (back) shell.focus = placeCursor(back)
			return true
		}

		const back = anchor.dataset["footnoteBackTo"]
		if (back !== undefined) {
			const references = Array.from(
				screen.querySelectorAll<HTMLElement>(`[data-footnote-ref="${CSS.escape(back)}"]`)
			).filter((reference) => {
				const clip = reference.closest<HTMLElement>("[data-clip]")
				if (clip === null) return true
				const box = reference.getBoundingClientRect()
				const frame = clip.getBoundingClientRect()
				return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1
			})
			const reference = references[0]
			if (reference) {
				shell.focus = placeCursor(reference)
				flash(reference)
			}
			return true
		}

		return false
	}
})
