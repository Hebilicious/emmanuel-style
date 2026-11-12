import { bindings, defineConfig, exports, triggers } from "cf/config"

/**
 * The worker behind the site: favourites and star counts, at emmanuel.style/api.
 *
 * The site is a worker of its own on the same host (`packages/flamme`); this one
 * answers `/api/*` in front of it. `cf deploy` reads this file; `wrangler` does
 * not.
 */
export default defineConfig({
	worker: {
		name: "emmanuel-style-api",
		compatibilityDate: "2026-09-17",
		entrypoint: "src/index.ts",
		previewUrls: true,
		observability: {
			enabled: true
		},
		triggers: [
			triggers.fetch({
				pattern: "emmanuel.style/api/*",
				zone: "emmanuel.style"
			})
		],
		/*
		 * The two Durable Object classes, both on SQLite storage, as they were first
		 * created. This map is their whole history: a class that is renamed or removed
		 * is marked here rather than in a list of migrations.
		 */
		exports: {
			Favourites: exports.durableObject({ storage: "sqlite" }),
			StarCache: exports.durableObject({ storage: "sqlite" })
		},
		env: {
			ALLOWED_ORIGINS: bindings.text(
				"https://emmanuel.style,http://localhost:4321,http://localhost:4399,http://localhost:4400"
			),
			FAVOURITES: bindings.durableObject({
				worker: "emmanuel-style-api",
				exportName: "Favourites"
			}),
			STAR_CACHE: bindings.durableObject({
				worker: "emmanuel-style-api",
				exportName: "StarCache"
			})
			/*
			 * `GITHUB_TOKEN` is a secret the worker reads when it is there (`src/stars.ts`):
			 * GitHub refuses requests without one from Cloudflare's addresses. It is not
			 * declared here, because a declared secret is a required one and a deploy
			 * without it fails; the star counts are worth less than the deploy. Set it once
			 * with `wrangler secret put GITHUB_TOKEN --name emmanuel-style-api`: a deploy
			 * keeps the secrets a worker already has.
			 */
		}
	}
})
