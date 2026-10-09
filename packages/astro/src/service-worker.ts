/// <reference lib="webworker" />
/**
 * The site's service worker.
 *
 * `workbox-build` injects the precache manifest into the single placeholder
 * below. `precacheAndRoute` registers the route that serves those assets.
 *
 * Navigations get their own `fetch` listener rather than a Workbox route. The
 * site is built as directories (`/experience/index.html`) and its links are
 * written without a trailing slash, so a request for `/experience` and
 * `/experience/` mean the same page. Workbox's precache route only resolves the
 * trailing-slash spelling, and registering a second route to cover the bare one
 * proved unreliable, so the navigation handler owns that lookup outright.
 *
 * Listeners are consulted newest first, so this runs before Workbox's routes.
 */
import { clientsClaim } from "workbox-core"
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching"

declare const self: ServiceWorkerGlobalScope

self.skipWaiting()
clientsClaim()

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

/** The pages this worker is willing to answer a navigation with. */
const htmlCandidates = (pathname: string): string[] => {
	if (pathname === "/") return ["/index.html"]
	const trimmed = pathname.replace(/\/+$/, "")
	return [`${trimmed}/index.html`, `${trimmed}.html`]
}

self.addEventListener("fetch", (event) => {
	const request = event.request
	if (request.mode !== "navigate") return

	const url = new URL(request.url)

	// Only same-origin pages are handled here; anything else goes to the network.
	if (url.origin !== self.location.origin) return

	event.respondWith(
		(async () => {
			for (const candidate of htmlCandidates(url.pathname)) {
				// `ignoreSearch` covers the `__WB_REVISION__` marker Workbox appends.
				const cached = await caches.match(new URL(candidate, url.origin).href, {
					ignoreSearch: true
				})
				if (cached) return cached
			}
			return fetch(request)
		})()
	)
})
