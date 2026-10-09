/**
 * The browser entry point.
 *
 * The order matters and is the one Flamme's own app uses:
 *
 *   1. build the container, so the durable snapshot and its queued writes are
 *      restored before anything reads the cache;
 *   2. install the client, the data-loader plugin (before the router, which is the
 *      order vue-router documents) and the router;
 *   3. `await router.isReady()`, so the first navigation's loaders have run before
 *      the first render, which is what stops a loading frame painting over the
 *      shell;
 *   4. mount;
 *   5. register the service worker in a production build only: it has no `sw.js`
 *      to register in dev, and it is what makes the *next* load work offline.
 */
import { DataLoaderPlugin } from "@flamme/router"
import { createApp, h } from "vue"
import { RouterView, createWebHistory } from "vue-router"
import { createSiteClient } from "./client.js"
import { createAppRouter } from "./routes.js"
import { installServiceWorker } from "./sw.js"

/*
 * Vite's CSS pipeline is entered through bare imports, and the order is the
 * cascade: the generated tokens first, then the rules that read them. Without
 * `cssforge.css` every `var(--ink)` in the rest of the sheet resolves to nothing
 * and the page renders unstyled.
 */
import "./styles/fonts.css"
import "./styles/cssforge.css"
import "./styles/global.css"
import "./styles/shell.css"

const start = async (): Promise<void> => {
	const flamme = createSiteClient()
	await flamme.ready

	const { router, dataLoader } = await createAppRouter({
		client: flamme.client,
		history: createWebHistory()
	})

	const app = createApp({ render: () => h(RouterView) })
	app.use(flamme.plugin)
	app.use(DataLoaderPlugin, dataLoader())
	app.use(router)

	await router.isReady()
	app.mount("#app")

	// Registered last, and only in a build: the worker is what makes the next load
	// work with the network off.
	if (import.meta.env.PROD) installServiceWorker()
}

void start()
