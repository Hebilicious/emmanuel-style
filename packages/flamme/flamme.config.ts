/**
 * The Flamme compiler config.
 *
 * `schema.graphql` is generated from `packages/schema/src/index.ts` by Pothos, so
 * the schema the documents are validated against and the schema the worker serves
 * cannot drift.
 *
 * `types` gives every object its cache key. The runtime's default is `id`, which a
 * page or a shelf does not have: pages are keyed by `slug`, shelves and sites by
 * `slug` and `name`, projects by `name`, and blocks and notes by `id`. A document
 * never repeats a key by hand because the compiler injects the ones it needs.
 *
 * Every object that more than one document selects needs a key. One without is
 * stored inside its parent, and a document that selects fewer of its fields writes
 * over the fields another document read: the Library's projects lost their covers
 * once the layout's index, which selects five fields of each, had been written.
 */
import { defineConfig } from "@flamme/core"
import { flammeRoutesPlugin } from "@flamme/vite"

export default defineConfig({
	schemaPath: "../schema/schema.graphql",
	include: ["src/**/*.{vue,ts,gql}"],
	runtimeDir: ".flamme",
	types: {
		Site: { keys: ["name"] },
		Shelf: { keys: ["slug"] },
		Repository: { keys: ["name"] },
		Project: { keys: ["name"] },
		Post: { keys: ["slug"] },
		Block: { keys: ["id"] },
		Note: { keys: ["id"] },
		Role: { keys: ["id"] },
		School: { keys: ["id"] },
		Skill: { keys: ["name"] },
		Favourite: { keys: ["slug"] }
	},
	plugins: [flammeRoutesPlugin()]
})
