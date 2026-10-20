/**
 * The mouse, and what a click on a link does.
 *
 * The mouse is on: hovering a row puts the reading cursor on it, so the pointer
 * draws the same highlight the keyboard does and the status row names what a click
 * would open. A reader who wants the keyboard alone turns it off (`mouse off` at
 * the prompt); then a mouse click does not follow a link or open a row, and two
 * clicks in a row ask once whether to have it back. The anchors keep their
 * `href`s either way, so search engines, screen readers and "copy link" still see
 * real links: the gate refuses the click, it does not take the link away.
 *
 * Only a mouse (or a pen) is gated. A touch screen is not a mouse, and a phone has
 * no keyboard to fall back on, so a tap always works. A click the keyboard caused
 * (Enter on a focused row, which the keyboard layer sends as a synthetic click) is
 * never gated either.
 *
 * Whatever the mode, a link is followed the same way: an internal link through the
 * router, so the shell stays mounted, and an external one in a new tab, so reading
 * never navigates the site away.
 */
import { onBeforeUnmount, onMounted } from "vue"
import type { Router } from "vue-router"
import { describe, placeCursor, rowOf } from "./cursor.js"
import type { Shell } from "./shell.js"

/** Two clicks this close together ask the question. */
const DOUBLE_CLICK_MS = 450

/** What a gated click is refused on: links, and the rows the cursor reaches. */
const GATED = "a[href], [data-row], figure.Plate"

const isExternal = (anchor: HTMLAnchorElement): boolean => {
	const href = anchor.getAttribute("href") ?? ""
	if (!/^https?:/i.test(href)) return false
	try {
		return new URL(href).origin !== window.location.origin
	} catch {
		return false
	}
}

export const usePointer = (
	shell: Shell,
	router: Router,
	footnotes: { follow(anchor: HTMLAnchorElement): boolean }
): void => {
	let lastPointer = ""
	let lastClick = 0

	const onPointerDown = (event: PointerEvent) => {
		lastPointer = event.pointerType
	}

	/** The row under the mouse takes the cursor, without taking the focus. */
	let hovered: Element | null = null
	const onPointerOver = (event: PointerEvent) => {
		if (!shell.mouse || event.pointerType === "touch" || shell.dialog !== null) return
		const target = event.target instanceof Element ? event.target : null
		if (target === null || target === hovered) return
		hovered = target
		const row = rowOf(target)
		if (row === undefined || row.element.hasAttribute("data-cursor")) return
		placeCursor(row, { focus: false })
		shell.focus = describe(row.element)
	}

	/** The kind of input behind a click: `mouse`, `pen`, `touch`, or `""` for the keyboard. */
	const pointerOf = (event: MouseEvent): string => {
		if (event.detail === 0) return ""
		const reported = (event as PointerEvent).pointerType
		return typeof reported === "string" && reported !== "" ? reported : lastPointer || "mouse"
	}

	/**
	 * The gate, in the capture phase: it sees the click before the link, the row or
	 * the router does, and stops it there.
	 */
	const onGate = (event: MouseEvent) => {
		if (!event.isTrusted) return
		const kind = pointerOf(event)
		if (kind === "" || kind === "touch") return
		if (shell.mouse) return

		const target = event.target as Element | null
		// The dialogs are the way out, so a click inside one always works.
		if (target?.closest("[role='dialog']")) return

		if (target?.closest(GATED)) {
			event.preventDefault()
			event.stopPropagation()
		}

		/*
		 * Two clicks in a row, anywhere on the page, ask the question. One is not
		 * enough: a stray click should not interrupt the reader, and a pair is
		 * unambiguous.
		 */
		const now = Date.now()
		const doubled = now - lastClick < DOUBLE_CLICK_MS
		lastClick = doubled ? 0 : now
		if (doubled && shell.dialog === null) shell.dialog = { kind: "gate" }
	}

	/**
	 * Links the router does not already own: anchors in an article's markup, the
	 * footnote references, and every external link.
	 */
	const onLink = (event: MouseEvent) => {
		if (event.defaultPrevented || event.button !== 0) return
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
		const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]")
		if (!anchor) return

		if (footnotes.follow(anchor)) {
			event.preventDefault()
			return
		}

		if (isExternal(anchor)) {
			if (anchor.target === "_blank") return
			event.preventDefault()
			window.open(anchor.href, "_blank", "noopener,noreferrer")
			return
		}

		const href = anchor.getAttribute("href") ?? ""
		if (href.startsWith("#") || anchor.target === "_blank" || anchor.hasAttribute("download"))
			return
		const url = new URL(anchor.href)
		if (url.origin !== window.location.origin) return
		event.preventDefault()
		void router.push(`${url.pathname}${url.search}${url.hash}`)
	}

	onMounted(() => {
		document.addEventListener("pointerdown", onPointerDown, { capture: true })
		document.addEventListener("pointerover", onPointerOver)
		document.addEventListener("click", onGate, { capture: true })
		document.addEventListener("click", onLink)
		document.body.classList.toggle("mouse-enabled", shell.mouse)
	})

	onBeforeUnmount(() => {
		document.removeEventListener("pointerdown", onPointerDown, { capture: true })
		document.removeEventListener("pointerover", onPointerOver)
		document.removeEventListener("click", onGate, { capture: true })
		document.removeEventListener("click", onLink)
	})
}
