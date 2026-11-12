import { defineConfig } from "cf/config"

/**
 * The site: the static build in `dist`, served from emmanuel.style.
 *
 * It has no code of its own to run: the worker is its files. Which directory they
 * come from is a build setting, in `wrangler.config.ts` beside this file.
 *
 * This is a package of its own, beside `packages/flamme`, on purpose. `cf` builds
 * a project with the tool it finds in it, and in a Vite project that is a plain
 * `vite build`: it would skip the steps that write a document per route and the
 * service worker's list of files. Here there is nothing to find, so `cf` packs the
 * directory the site's own build has already written.
 */
export default defineConfig({
	worker: {
		name: "emmanuel-style",
		compatibilityDate: "2026-09-17",
		previewUrls: true,
		observability: {
			enabled: true
		},
		assets: {
			/*
			 * Files are served at the paths they have, with no redirect to or from a
			 * trailing slash: the service worker stores every file of the build, and a
			 * stored redirect cannot answer a navigation.
			 */
			htmlHandling: "none",
			// An article or a project is a route the app draws, not a file: the shell answers for it.
			notFoundHandling: "single-page-application"
		},
		domains: ["emmanuel.style"]
	}
})
