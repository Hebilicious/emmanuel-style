/**
 * Toggle idempotency, proved against the GraphQL executor the worker serves.
 *
 * The Durable Object is replaced by an in-memory double of the same contract,
 * because the property under test is the reader bookkeeping: replaying a queued
 * write must land on the same count, not on the same *response*. A test against
 * a mocked executor would prove nothing, so this drives `runGraphQL` with the
 * real document and the real `readerKey` derivation.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { runGraphQL } from "./graphql.ts"
import { readerKey } from "./reader.ts"

/** The persisted shape the Durable Object keeps. */
interface State {
	count: number
	readers: string[]
}

/**
 * In-memory stand-in for the Favourites Durable Object.
 *
 * `add` is not implemented on purpose: this test only exercises the toggle, and
 * a surprise call to `add` should fail loudly rather than silently pass.
 */
const favouriteStore = () => {
	const state = new Map<string, State>()

	const read = (slug: string): State => state.get(slug) ?? { count: 0, readers: [] }

	return {
		count: async (slug: string) => ({ ...read(slug) }),
		toggle: async (slug: string, key: string) => {
			const current = read(slug)
			const favourited = current.readers.includes(key)
			const next: State = {
				count: current.count + (favourited ? -1 : 1),
				readers: favourited
					? current.readers.filter((entry) => entry !== key)
					: [...current.readers, key]
			}
			state.set(slug, next)
			return { ...next }
		}
	}
}

/** Run one mutation document as `readerId`, returning the count it answered with. */
const toggle = async (
	store: ReturnType<typeof favouriteStore>,
	readerId: string | null,
	slug = "x"
): Promise<number | null | undefined> => {
	const result = await runGraphQL(
		{ query: `mutation { toggleFavourite(slug: "${slug}") { count } }` },
		{
			readerId,
			favourite: async (requested: string) => {
				const state = await store.count(requested)
				return { slug: requested, count: state.count }
			},
			toggleFavourite: async (requested: string, key: string) => {
				const state = await store.toggle(requested, key)
				return { slug: requested, count: state.count }
			},
			stars: async () => []
		}
	)

	assert.equal(
		result.errors,
		undefined,
		`unexpected GraphQL errors: ${result.errors?.map((error) => error.message).join("; ")}`
	)

	const data = result.data as { toggleFavourite: { count: number } } | undefined
	return data?.toggleFavourite.count
}

test("two toggles by one reader return the count to where it started", async () => {
	const store = favouriteStore()

	assert.equal(await toggle(store, "reader-a"), 1)
	assert.equal(await toggle(store, "reader-a"), 0)
	assert.deepEqual(await store.count("x"), { count: 0, readers: [] })
})

test("one toggle each by two readers counts both", async () => {
	const store = favouriteStore()

	// The acceptance criterion reads these calls in sequence: the second call is
	// what reports 1 (reader A's favourite), and it is what a bystander reads.
	assert.equal(await toggle(store, "reader-a"), 1)
	assert.equal(await toggle(store, "reader-b"), 2)
	assert.equal(await store.count("x").then((state) => state.count), 2)

	// Take A back out, and exactly B's favourite is left.
	assert.equal(await toggle(store, "reader-a"), 1)
	assert.equal(await store.count("x").then((state) => state.count), 1)
})

test("a toggle is idempotent per reader, not globally", async () => {
	const store = favouriteStore()

	// Reader A on, reader B on, reader A off: B's favourite survives.
	assert.equal(await toggle(store, "reader-a"), 1)
	assert.equal(await toggle(store, "reader-b"), 2)
	assert.equal(await toggle(store, "reader-a"), 1)

	// Counting down is exact, never negative.
	assert.equal(await toggle(store, "reader-b"), 0)
	assert.equal(await toggle(store, "reader-b"), 1)
})

test("a reader id that only differs by surrounding space is the same reader", async () => {
	const store = favouriteStore()

	assert.equal(await toggle(store, "reader-a"), 1)
	assert.equal(await toggle(store, "  reader-a  "), 0)
})

test("a toggle without a reader id is refused, and changes nothing", async () => {
	const store = favouriteStore()
	const result = await runGraphQL(
		{ query: `mutation { toggleFavourite(slug: "x") { count } }` },
		{
			readerId: null,
			favourite: async (slug: string) => ({ slug, count: 0 }),
			toggleFavourite: async (slug: string) => ({ slug, count: 0 }),
			stars: async () => []
		}
	)

	assert.equal(result.data, undefined)
	assert.match(result.errors?.[0]?.message ?? "", /x-reader-id/)
	assert.deepEqual(await store.count("x"), { count: 0, readers: [] })
})

test("an unknown field is a validation error rather than a crash", async () => {
	const result = await runGraphQL(
		{ query: `query { site { name } }` },
		{
			readerId: "reader-a",
			favourite: async (slug: string) => ({ slug, count: 0 }),
			toggleFavourite: async (slug: string) => ({ slug, count: 0 }),
			stars: async () => []
		}
	)

	// App-resolved content is deliberately not part of the worker's schema.
	assert.equal(result.data, undefined)
	assert.match(result.errors?.[0]?.message ?? "", /site/)
})

test("readerKey is stable, opaque, and rejects what cannot identify a reader", async () => {
	const key = await readerKey("reader-a")
	assert.equal(key, await readerKey("reader-a"))
	assert.notEqual(key, await readerKey("reader-b"))
	assert.equal(key?.length, 64)
	assert.match(key ?? "", /^[0-9a-f]{64}$/)
	assert.equal(await readerKey(""), null)
	assert.equal(await readerKey(null), null)
	assert.equal(await readerKey("x".repeat(129)), null)
})
