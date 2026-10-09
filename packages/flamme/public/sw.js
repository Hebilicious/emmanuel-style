/**
 * The service worker.
 *
 * The site is a static bundle plus one GraphQL endpoint, so this owns the shell:
 * every route's HTML, the JS and CSS chunks, the fonts and the article images are
 * precached from a manifest the build writes, and a navigation is answered from that
 * cache.
 *
 * It matters more here than in a typical app, because the content is answered by the
 * local transport from the bundle rather than by a server: with the shell cached, a
 * cold load works with the network off.
 *
 * The manifest is read ONLY during install. Reading it per request was the bug that
 * made the whole site unreachable offline: the fetch failed, the handler rejected,
 * and a rejected `respondWith` is a network error rather than a cache miss. The cache
 * name is fixed instead, and a build replaces its contents.
 */

const MANIFEST = "/precache-manifest.json"

/** One stable name, so no request ever has to read the manifest to find the cache. */
const CACHE = "emmanuel-shell"

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const response = await fetch(MANIFEST, { cache: "no-store" })
			const manifest = await response.json()
			const cache = await caches.open(CACHE)

			// A stale entry from the previous build would be served for a chunk that no
			// longer exists, so the cache is rebuilt rather than added to.
			const existing = await cache.keys()
			await Promise.all(existing.map((request) => cache.delete(request)))

			// `addAll` is all-or-nothing and one 404 would leave the worker with no cache
			// at all, so each entry is added on its own and a failure is skipped.
			await Promise.all(
				manifest.urls.map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {}))
			)

			await self.skipWaiting()
		})()
	)
})

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys()
			await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))
			await self.clients.claim()
		})()
	)
})

self.addEventListener("fetch", (event) => {
	const request = event.request
	if (request.method !== "GET") return

	const url = new URL(request.url)

	// The API is never cached: favourites and star counts are live, and the client
	// keeps its own durable copy for when the worker is unreachable.
	if (url.pathname.startsWith("/api/")) return
	if (url.origin !== self.location.origin) return

	// A navigation is answered from the cache, because every route was written into it.
	if (request.mode === "navigate") {
		event.respondWith(
			(async () => {
				const cache = await caches.open(CACHE)

				/*
				 * A route is a directory with an `index.html`, and a browser may ask for
				 * either form: `/library` or `/library/`. Collapsing the trailing slash
				 * first is what makes both find the same document.
				 */
				const path = url.pathname.replace(/\/+$/, "")
				const candidates =
					path === ""
						? ["/index.html"]
						: [`${path}/index.html`, `${path}.html`, path, `${path}/`]

				for (const candidate of candidates) {
					const hit = await cache.match(candidate)
					if (hit) return hit
				}

				try {
					return await fetch(request)
				} catch {
					return (await cache.match("/index.html")) ?? Response.error()
				}
			})()
		)
		return
	}

	// Everything else is cache-first: the chunks and the fonts are content-hashed, so
	// a cached copy is the right one for the HTML that asked for it.
	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE)

			/*
			 * Matched by URL as well as by request.
			 *
			 * A module script is requested in `cors` mode with credentials, and a stored
			 * response whose `Vary` header differs does not match the request object even
			 * though it is the same URL: the entry was in the cache and the script load
			 * still failed offline. `ignoreVary` and a bare URL lookup are what make the
			 * hit unconditional.
			 */
			const cached =
				(request.destination === "" ? null : await cache.match(request, { ignoreVary: true })) ??
				(await cache.match(request, { ignoreVary: true })) ??
				(await cache.match(url.pathname))

			if (cached) return cached

			try {
				const response = await fetch(request)
				if (response.ok && response.type === "basic") cache.put(request, response.clone())
				return response
			} catch {
				return (await cache.match(url.pathname)) ?? Response.error()
			}
		})()
	)
})
