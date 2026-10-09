/**
 * The service worker.
 *
 * Registered in a production build only. The site is a static bundle plus one
 * GraphQL endpoint, so the worker's whole job is the shell: every route's HTML, the
 * JS and CSS chunks, the fonts and the article images are precached from a manifest
 * the build writes, and a navigation is answered from that cache first.
 *
 * A content page never needs the network at all, because its data is in the bundle
 * (see `content.ts`), so this is what makes a *cold* load offline work rather than
 * only a warm one.
 */
export const installServiceWorker = (): void => {
	if (!("serviceWorker" in navigator)) return

	const register = () => {
		void navigator.serviceWorker.register("/sw.js", { type: "module" })
	}

	/*
	 * Registered immediately when the document has already loaded.
	 *
	 * The app boots asynchronously (the durable snapshot is restored and the first
	 * navigation's loaders run before the mount), so by the time this is called the
	 * `load` event has usually fired. Waiting for it then meant the listener never ran
	 * and the site had no worker at all.
	 */
	if (document.readyState === "complete") register()
	else window.addEventListener("load", register, { once: true })
}
