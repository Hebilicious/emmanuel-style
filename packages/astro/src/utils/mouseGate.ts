/**
 * Mouse gate.
 *
 * Keyboard-only navigation means a click must not follow a link. Rather than
 * stripping hrefs, pointer clicks are intercepted in the capture phase and the
 * visitor is asked, once, whether they want the pointer back. Answering yes
 * stores the choice for the session and lets clicks through from then on.
 */
import { pageReady } from "./pageReady"

const STORAGE_KEY = "mouse-navigation"

const isEnabled = () => {
	try {
		return sessionStorage.getItem(STORAGE_KEY) === "on"
	} catch {
		return false
	}
}

const remember = (value: "on" | "off") => {
	try {
		sessionStorage.setItem(STORAGE_KEY, value)
	} catch {
		// Storage can be unavailable; the in-memory flag below still applies.
	}
}

export const createMouseGate = () => {
	pageReady((signal) => {
		const root = document.querySelector<HTMLElement>("[data-gate]")
		if (!root) return

		const yes = root.querySelector<HTMLButtonElement>("[data-gate-yes]")
		const no = root.querySelector<HTMLButtonElement>("[data-gate-no]")

		// Once the visitor opts in, they are not asked again this session.
		let enabled = isEnabled()
		let open = false

		const setOpen = (next: boolean) => {
			open = next
			root.hidden = !next
			if (next) yes?.focus()
		}

		const enable = () => {
			enabled = true
			remember("on")
			// Drives the CSS that hides the cursor and stops the page responding
			// to a pointer while the mouse is disabled.
			document.body.classList.add("mouse-enabled")
			setOpen(false)
		}

		const decline = () => {
			enabled = false
			remember("off")
			document.body.classList.remove("mouse-enabled")
			setOpen(false)
		}

		yes?.addEventListener("click", enable)
		no?.addEventListener("click", decline)

		/*
		 * An external link opens in a new tab, always.
		 *
		 * It used to ask for confirmation first, which is friction for no gain: the
		 * site is left in place either way and the reader can see where they went.
		 */
		const openExternally = (href: string) => {
			window.open(href, "_blank", "noopener,noreferrer")
		}

		/*
		 * A click on an external link is intercepted in both modes, so the new tab is
		 * opened by the same code every time and never navigates this page away.
		 */
		document.addEventListener(
			"click",
			(event) => {
				if (!event.isTrusted) return

				const target = event.target as HTMLElement | null
				const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null
				if (!anchor) return
				if (anchor.dataset.synthetic === "true") return

				// Modified clicks already mean "new tab", so the browser handles them.
				if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

				const href = anchor.getAttribute("href") ?? ""
				if (!/^https?:/i.test(href)) return

				event.preventDefault()
				event.stopPropagation()
				openExternally(href)
			},
			{ capture: true, signal }
		)

		/**
		 * Anything that looks like a deliberate pointer navigation is held back.
		 * Plain clicks on non-link chrome are left alone so the theme switch, the
		 * terminal prompt and text selection keep working.
		 */
		let lastClick = 0

		document.addEventListener(
			"click",
			(event) => {
				if (enabled) return

				// Only real pointer input counts. Synthetic clicks are how the
				// terminal and the WebMCP tools navigate, and those are keyboard
				// driven, so they must pass.
				if (!event.isTrusted) return

				const target = event.target as HTMLElement | null

				// The gate's own buttons are the way out, so they always work.
				if (target?.closest?.("[data-gate]")) return

				const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null
				const synthetic = anchor?.dataset.synthetic === "true"
				const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey

				// External links were handled above and are already opening in a new tab.
				if (anchor && !synthetic && !modified) {
					event.preventDefault()
					event.stopPropagation()
				}

				/*
				 * Two clicks in a row, anywhere on the page, ask the question.
				 * One click is not enough: a stray tap should not interrupt, and
				 * the pair is unambiguous.
				 */
				const now = Date.now()
				const doubled = now - lastClick < 450
				lastClick = now
				if (!doubled) return

				lastClick = 0
				setOpen(true)
			},
			{ capture: true, signal }
		)

		// Keys answer the prompt while it is open.
		document.addEventListener(
			"keydown",
			(event) => {
				if (!open) return
				if (event.key === "y" || event.key === "Y" || event.key === "Enter") {
					event.preventDefault()
					enable()
					return
				}
				if (event.key === "n" || event.key === "N") {
					event.preventDefault()
					decline()
					return
				}
				if (event.key === "Escape") {
					event.preventDefault()
					setOpen(false)
				}
			},
			{ signal }
		)

		// Reflect the stored choice, and only then stop intercepting.
		document.body.classList.toggle("mouse-enabled", enabled)
		if (enabled) root.hidden = true
	})
}
