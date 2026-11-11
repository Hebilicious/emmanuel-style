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
import { createMachine } from "./machine.js"
import type { Shell } from "./shell.js"
import { turning } from "./turns.js"

/** Two clicks this close together ask the question. */
const DOUBLE_CLICK_MS = 450

/**
 * The controls that are in the same place before, during and after a turn: the
 * bar, the dock, the wire, and whatever a dialog marks `data-steady` (its close
 * button, its next and previous).
 */
const STEADY = [
	".Bar a[href]",
	".Bar button",
	".Dock button",
	".Dock a[href]",
	".Wire a[href]",
	"[data-steady]"
].join(",")

/** The steady control under a point, the smallest one if several are. */
const steadyAt = (x: number, y: number): HTMLElement | null => {
	let found: HTMLElement | null = null
	let area = Number.POSITIVE_INFINITY
	for (const element of document.querySelectorAll<HTMLElement>(STEADY)) {
		if (element.matches(":disabled")) continue
		const box = element.getBoundingClientRect()
		if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue
		if (box.width * box.height < area) {
			area = box.width * box.height
			found = element
		}
	}
	return found
}

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

	/**
	 * The mouse question, while the mouse is off: one click arms it, a second within
	 * `DOUBLE_CLICK_MS` asks, and a click that comes later is a first click again.
	 */
	let armedAt = 0
	const doubleClick = createMachine<
		"idle" | "armed",
		{ type: "CLICK"; time: number; ask: () => void }
	>("idle", {
		idle: {
			CLICK: (event) => {
				armedAt = event.time
				return "armed"
			}
		},
		armed: {
			CLICK: (event) => {
				if (event.time - armedAt >= DOUBLE_CLICK_MS) {
					armedAt = event.time
					return undefined
				}
				event.ask()
				return "idle"
			}
		}
	})

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
		doubleClick.send({
			type: "CLICK",
			time: Date.now(),
			ask: () => {
				if (shell.dialog === null) shell.dialog = { kind: "gate" }
			}
		})
	}

	/**
	 * A click while a turn runs. The browser draws a transition over the page and
	 * gives every click during it to the root element, so a second click on the
	 * dock's arrow, or on a section while a leaf was still in the air, was lost. A
	 * click that lands on a steady control is handed to it. The page itself is left
	 * alone: what is under the pointer there is changing, and a click meant for the
	 * old page should not open something on the new one.
	 */
	const onTurnClick = (event: MouseEvent) => {
		if (!event.isTrusted || event.button !== 0) return
		if (event.target !== document.documentElement || turning.is("idle")) return
		const kind = pointerOf(event)
		if (kind !== "touch" && kind !== "" && !shell.mouse) return
		const control = steadyAt(event.clientX, event.clientY)
		if (control === null) return
		event.preventDefault()
		control.click()
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
		document.addEventListener("click", onTurnClick, { capture: true })
		document.addEventListener("click", onLink)
		document.body.classList.toggle("mouse-enabled", shell.mouse)
	})

	onBeforeUnmount(() => {
		document.removeEventListener("pointerdown", onPointerDown, { capture: true })
		document.removeEventListener("pointerover", onPointerOver)
		document.removeEventListener("click", onGate, { capture: true })
		document.removeEventListener("click", onTurnClick, { capture: true })
		document.removeEventListener("click", onLink)
	})
}
