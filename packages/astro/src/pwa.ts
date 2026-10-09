/**
 * Registers the precache service worker written at build time by the
 * `offline-support` integration in astro.config.ts.
 *
 * The worker is bundled as an ES module by `workbox-build`, so it must be
 * registered with `type: "module"`.
 *
 * In development there is no worker to register, and the site is served from
 * the dev server instead.
 */
const registerServiceWorker = () => {
	if (!("serviceWorker" in navigator)) return

	window.addEventListener("load", () => {
		navigator.serviceWorker.register("/sw.js", { type: "module" }).catch((error) => {
			console.error("Service worker registration failed:", error)
		})
	})

	const update = () => {
		navigator.serviceWorker.getRegistration().then((registration) => {
			registration?.update()
		})
	}

	// Pick up new deploys while a tab stays open.
	setInterval(update, 5 * 60 * 1000)
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) update()
	})
	window.addEventListener("online", update)
}

if (import.meta.env.PROD) registerServiceWorker()
