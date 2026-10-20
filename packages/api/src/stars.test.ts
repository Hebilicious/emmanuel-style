/**
 * The `stars` field answers the document the site compiles against the shared
 * schema.
 *
 * The site's `Stars` query asks for `name` and `stars`, because `Repository` is
 * keyed on `name` in `packages/schema/schema.graphql`, and the compiler adds
 * `__typename`. The worker's own schema calls the same value `repo`; it answered
 * `Cannot query field "name"` until `name` was added, and the Library showed no
 * counts. This drives `runGraphQL` with that document.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { runGraphQL } from "./graphql.ts"

test("stars answers the shared-schema document, keyed by name", async () => {
	const result = await runGraphQL(
		{
			query: "query Stars($names: [String!]!) { stars(names: $names) { __typename name stars } }",
			variables: { names: ["cssforge", "vue-query-nuxt"] }
		},
		{
			readerId: null,
			favourite: async (slug) => ({ slug, count: 0 }),
			toggleFavourite: async (slug) => ({ slug, count: 0 }),
			stars: async (names) => names.map((repo, index) => ({ repo, stars: index + 3, cached: true }))
		}
	)

	assert.equal(result.errors, undefined, result.errors?.map((error) => error.message).join("; "))
	assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
		stars: [
			{ __typename: "Repository", name: "cssforge", stars: 3 },
			{ __typename: "Repository", name: "vue-query-nuxt", stars: 4 }
		]
	})
})
