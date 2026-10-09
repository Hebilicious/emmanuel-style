/**
 * The keyboard layer: the page cursor and every global shortcut.
 *
 * A terminal has no pointer, so moving through a page is done the way a vim user
 * expects: one highlighted row at a time, plus plain single-key jumps between
 * sections. Everything is owned by this one handler, because splitting the
 * keyboard across modules is what previously left an armed prefix in one closure
 * and its suffix delivered to another.
 *
 *   j / k / arrows    move the cursor between rows
 *   Enter             follow the cursor
 *   h l b e           home, library, blog, experience
 *   t                 toggle the theme
 *   n / p             next / previous page (handled by utils/paginate.ts)
 *   / or ?            open the prompt, Esc closes it
 *
 * All shortcut keys are plain letters with no modifier, so nothing collides with
 * a browser binding: Ctrl+g, for instance, is a find-again shortcut in Edge.
 */
import { go } from "./navigation"
import { pageReady } from "./pageReady"

/** What the cursor can land on, in document order. */
const SELECTABLE = [
	"a.Command",
	"a.Entry",
	".EntryLink",
	".Icons a",
	".Switch",
	"a.Back",
	"a.Skip",
	// Article content: prose links, footnote markers and figures.
	"[data-flow] a[href]",
	"[data-flow] figure",
	"[data-flow] figure img"
].join(",")

/**
 * Section jumps are two-key sequences, the way `g`-prefixed motions work in vim:
 * the first key only arms, the second commits. A single letter would be too easy
 * to fire by accident, and a modified combination collides with browser
 * bindings.
 */
const SEQUENCE_LEADER = "g"

const SEQUENCES: Record<string, { href: string; label: string }> = {
	h: { href: "/", label: "home" },
	l: { href: "/library", label: "library" },
	b: { href: "/blog", label: "blog" },
	e: { href: "/experience", label: "experience" },
	t: { href: "", label: "theme" }
}

const setTheme = () => {
	const dark = document.documentElement.classList.contains("DarkTheme")
	const next = dark ? "light" : "dark"
	document.documentElement.classList.remove("LightTheme", "DarkTheme")
	document.documentElement.classList.add(next === "dark" ? "DarkTheme" : "LightTheme")
	try {
		localStorage.setItem("vueuse-color-scheme", next)
	} catch {
		// Storage can be unavailable; the class above is what matters.
	}
}

export const createCursor = () => {
	pageReady((signal) => {
		const page = document.querySelector<HTMLElement>(".Page")
		if (!page) return

		let index = 0
		/** Set by the leader key, consumed by the next one. Module scope is not
		 * needed here because both keys are handled by this same closure. */
		let armed = false

		/**
		 * Only the current page's rows are reachable.
		 *
		 * Paginated blocks are hidden with `content-visibility`, which does not
		 * affect `offsetParent`, so visibility is checked through the pagination
		 * attribute instead.
		 */
		const targets = () =>
			Array.from(page.querySelectorAll<HTMLElement>(SELECTABLE)).filter((el) => {
				if (el.closest("[hidden]")) return false
				// Visibility is the test, not the page number: `offsetParent` is
				// null for anything an ancestor has hidden, which covers off-page
				// blocks without this having to know how pagination works.
				return el.offsetParent !== null
			})

		const clear = () => {
			for (const el of page.querySelectorAll<HTMLElement>("[data-cursor]")) {
				el.removeAttribute("data-cursor")
			}
		}

		const focus = (next: number) => {
			const items = targets()
			if (items.length === 0) {
				clear()
				return
			}

			index = Math.max(0, Math.min(next, items.length - 1))
			clear()

			const el = items[index]
			el.setAttribute("data-cursor", "true")
			announce(describe(el))
			// Real focus, so Enter, assistive tech and the drawn highlight agree.
			el.focus({ preventScroll: true })
			el.scrollIntoView({ block: "nearest", behavior: "instant" })
		}

		const openPrompt = () => {
			const terminal = document.querySelector<HTMLElement>("[data-terminal]")
			if (!terminal?.hidden) return
			document.dispatchEvent(new CustomEvent("prompt:open"))
		}

		const promptOpen = () => {
			const terminal = document.querySelector<HTMLElement>("[data-terminal]")
			return terminal ? !terminal.hidden : false
		}

		/** Report the current target to the status line. */
		const announce = (text: string) => {
			document.dispatchEvent(new CustomEvent("focus:label", { detail: text }))
		}

		/**
		 * A short name for the highlighted element.
		 *
		 * Reading the whole row dumped "form-actions-nuxtTypeScriptstars…" into
		 * the status line, so named parts are preferred over the raw text.
		 */
		const describe = (el: HTMLElement | undefined) => {
			if (!el) return "nothing"
			const named =
				el.dataset.label ??
				el.querySelector(".Label")?.textContent ??
				el.querySelector(".Repo")?.textContent ??
				el.querySelector(".EntryTitle")?.textContent ??
				el.querySelector(".Title")?.textContent ??
				el.getAttribute("aria-label") ??
				el.textContent ??
				""
			return named.replace(/\s+/g, " ").trim().slice(0, 40)
		}

		document.addEventListener(
			"keydown",
			(event) => {
				// The prompt owns the keyboard while it is open.
				if (promptOpen()) return

				const target = event.target as HTMLElement | null
				const typing =
					target instanceof HTMLInputElement ||
					target instanceof HTMLTextAreaElement ||
					target?.isContentEditable === true
				if (typing) return

				// Modifier combinations belong to the browser.
				if (event.metaKey || event.ctrlKey || event.altKey) return

				// A pending sequence claims the next key outright.
				if (armed) {
					armed = false
					const target = SEQUENCES[event.key]
					if (target) {
						event.preventDefault()
						if (target.href) go(target.href)
						else setTheme()
						return
					}
					// Not a sequence key: fall through and treat it normally.
				}

				if (event.key === SEQUENCE_LEADER) {
					event.preventDefault()
					armed = true
					announce("g …")
					return
				}

				if (event.key === "/" || event.key === "?") {
					event.preventDefault()
					openPrompt()
					return
				}

				if (event.key === "G") {
					event.preventDefault()
					focus(targets().length - 1)
					return
				}

				if (event.key === "j" || event.key === "ArrowDown" || event.key === "ArrowRight") {
					event.preventDefault()
					focus(index + 1)
					return
				}

				if (event.key === "k" || event.key === "ArrowUp" || event.key === "ArrowLeft") {
					event.preventDefault()
					focus(index - 1)
					return
				}

				/*
				 * Enter and Space follow the highlighted element.
				 *
				 * A library entry opens a card first rather than leaving the site, which
				 * is what the entry's own description is for; the card's own button is
				 * what opens GitHub.
				 */
				if (event.key === "Enter" || event.key === " ") {
					const items = targets()
					const el = items[index]
					if (!el) return
					event.preventDefault()

					const name = el.querySelector(".Repo")?.textContent?.trim()
					if (el.classList.contains("EntryLink") && name) {
						document.dispatchEvent(new CustomEvent("repo:card", { detail: name }))
						return
					}

					// A figure opens full screen, so a picture too small to read in a
					// column can be examined.
					if (el.tagName === "FIGURE" || el.tagName === "IMG") {
						const image = el.tagName === "IMG" ? (el as HTMLImageElement) : el.querySelector("img")
						if (image) {
							document.dispatchEvent(
								new CustomEvent("figure:zoom", { detail: image.getAttribute("src") })
							)
							return
						}
					}

					el.click()
				}
			},
			{ signal }
		)

		// A page turn re-homes the cursor onto the newly visible rows.
		document.addEventListener("page:turn", () => focus(0), { signal })

		focus(0)
	})
}
