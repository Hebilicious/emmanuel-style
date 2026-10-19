/**
 * The shell's state: what the bar, the dock, the pager and the dialogs share.
 *
 * The shell is one screen, and several parts of it answer the same keys or show
 * the same facts: the dock reports the page the pager is on, the keyboard turns
 * whichever pager the route rendered, a figure opens over the page in the dialog
 * the layout owns. Rather than wiring those through events on `document`, the layout creates
 * one reactive object and provides it, and every part reads and writes it.
 *
 * It is created per app, in the layout's `setup`, never at module scope.
 */
import { type InjectionKey, inject, reactive } from "vue"

/** The one dialog that can be open at a time. */
export type Dialog =
	| { readonly kind: "gate" }
	| { readonly kind: "zoom"; readonly src: string; readonly caption: string }

/** What a pager registers so the keyboard and the dock can turn it. */
export interface Turner {
	/** Turn by a number of screens; negative turns back. */
	turn(delta: number): void
	/** Go to one screen, counted from zero. */
	go(screen: number): void
}

export type Theme = "light" | "dark"

export interface Shell {
	/** The screen the pager is on, counted from one, or `null` with no pager. */
	position: { current: number; total: number } | null
	/** What `n` and `p` step on this route: pages, or the front page's quotes. */
	turnLabel: "pages" | "quotes"
	/** The name of the element the cursor is on, for the status row. */
	focus: string
	/** Whether the prompt is open. */
	prompt: boolean
	/** Whether the reader asked for the mouse back. */
	mouse: boolean
	/** Whether the browser reports a network. */
	online: boolean
	theme: Theme
	dialog: Dialog | null
	/** The pager of the current route, or the front page's quote stepper. */
	turner: Turner | null
	/**
	 * Counts the first layouts of pagers. A route's turn waits for it to move, so the
	 * new page is captured laid out rather than empty.
	 */
	layouts: number
}

const SHELL_KEY: InjectionKey<Shell> = Symbol("shell")

/** The key `@vueuse/core` wrote in the previous build, so a returning reader keeps their theme. */
export const THEME_KEY = "vueuse-color-scheme"
/**
 * Per session: the mouse is on unless the reader turned it off for this visit
 * (`mouse off` at the prompt, or "No" at the gate).
 */
export const MOUSE_KEY = "mouse-navigation"

const readTheme = (): Theme =>
	typeof document !== "undefined" && document.documentElement.classList.contains("LightTheme")
		? "light"
		: "dark"

const readMouse = (): boolean => {
	try {
		return sessionStorage.getItem(MOUSE_KEY) !== "off"
	} catch {
		return true
	}
}

export const createShell = (): Shell =>
	reactive<Shell>({
		position: null,
		turnLabel: "pages",
		focus: "",
		prompt: false,
		mouse: readMouse(),
		online: typeof navigator === "undefined" ? true : navigator.onLine,
		theme: readTheme(),
		dialog: null,
		turner: null,
		layouts: 0
	})

export const SHELL = SHELL_KEY

/** The shell the layout provided. Every component under the layout can call this. */
export const useShell = (): Shell => {
	const shell = inject(SHELL_KEY)
	if (shell === undefined) throw new Error("useShell() called outside the layout")
	return shell
}

/**
 * Apply a theme: the class the stylesheet keys on, the stored choice, and the
 * browser chrome colour, which follows the paper.
 */
export const applyTheme = (shell: Shell, theme: Theme): void => {
	shell.theme = theme
	const root = document.documentElement
	root.classList.remove("LightTheme", "DarkTheme")
	root.classList.add(theme === "dark" ? "DarkTheme" : "LightTheme")
	try {
		localStorage.setItem(THEME_KEY, theme)
	} catch {
		// Storage can be unavailable; the class above is what matters.
	}
	const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
	if (meta) meta.content = PAPER[theme]
}

/**
 * The paper of each theme, as the browser chrome takes it. `--paper` is an OKLCH
 * colour, which `theme-color` is not guaranteed to accept, so the sRGB equivalent
 * of `neutral-50` and `neutral-950` is written out.
 */
const PAPER: Record<Theme, string> = { light: "#f7f6f3", dark: "#0b0b0a" }

export const toggleTheme = (shell: Shell): void =>
	applyTheme(shell, shell.theme === "dark" ? "light" : "dark")

/** Turn the mouse on or off for the rest of the session. */
export const setMouse = (shell: Shell, enabled: boolean): void => {
	shell.mouse = enabled
	try {
		sessionStorage.setItem(MOUSE_KEY, enabled ? "on" : "off")
	} catch {
		// Storage can be unavailable; the flag above still applies to this page.
	}
	document.body.classList.toggle("mouse-enabled", enabled)
}
