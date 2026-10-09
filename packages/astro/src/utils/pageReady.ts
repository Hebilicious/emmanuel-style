/**
 * Runs a setup function for the current document, and again after every router
 * swap.
 *
 * Astro's router replaces the body rather than reloading, so a module's
 * top-level DOM queries go stale after the first navigation: anything bound to
 * elements has to re-bind against the new ones.
 *
 * The previous run's document-level listeners are aborted first, so navigating
 * does not stack up handlers against elements that no longer exist.
 *
 * `astro:page-load` fires once after the initial load and again after every
 * swap, so no separate initial call is needed.
 */
const runs = new WeakMap<object, AbortController>()

export const pageReady = (setup: (signal: AbortSignal) => void) => {
	document.addEventListener("astro:page-load", () => {
		runs.get(setup)?.abort()

		const controller = new AbortController()
		runs.set(setup, controller)

		try {
			setup(controller.signal)
		} catch {
			// A failure while binding one feature must not break the page.
		}
	})
}
