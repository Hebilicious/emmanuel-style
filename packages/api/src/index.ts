/**
 * The site's backend worker.
 *
 * Two features, two Durable Object classes:
 *   - favorites: one counter object per article, toggled by readers.
 *   - stars: one shared cache object holding GitHub star counts with a TTL.
 *
 * Both are reachable two ways while the site is being ported: the original REST
 * routes and `POST /api/graphql`, which serves the server-owned part of the
 * shared schema.
 *
 * The Astro site stays static and keeps working offline; every route here is
 * additive, and the client treats a missing answer as "no data" rather than an
 * error.
 */
import { Hono } from "hono"
import { cors } from "hono/cors"
import { Favourites } from "./favourites"
import { type GraphQLRequest, runGraphQL } from "./graphql"
import { StarCache } from "./stars"

export { Favourites, StarCache }

const app = new Hono<{ Bindings: Env }>()

/**
 * Origin policy.
 *
 * The allow-list is configuration, not a hardcoded domain, because the site is
 * served from emmanuel.style and previews run on workers.dev and localhost.
 * Anything not on the list is refused rather than echoed, so a stray origin
 * cannot read responses.
 */
const isAllowedOrigin = (origin: string, configured: string): boolean => {
	const allowed = configured
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)

	// With nothing configured, allow same-origin and local development only.
	if (allowed.length === 0) {
		return origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")
	}

	return allowed.includes(origin)
}

app.use(
	"/api/*",
	cors({
		origin: (origin, c) => (isAllowedOrigin(origin, c.env.ALLOWED_ORIGINS) ? origin : null),
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["content-type", "x-reader-id"],
		maxAge: 86400
	})
)

/** One Durable Object per article slug. */
const favouriteStub = (env: Env, slug: string) =>
	env.FAVOURITES.get(env.FAVOURITES.idFromName(slug))

app.get("/api/favourites/:slug", async (c) => {
	const slug = c.req.param("slug")
	if (!slug) return c.json({ error: "missing slug" }, 400)

	const state = await favouriteStub(c.env, slug).count()
	return c.json({ slug, count: state.count })
})

app.post("/api/favourites/:slug", async (c) => {
	const slug = c.req.param("slug")
	if (!slug) return c.json({ error: "missing slug" }, 400)

	const state = await favouriteStub(c.env, slug).add()
	return c.json({ slug, count: state.count })
})

/** One shared cache object for all repositories. */
const starStub = (env: Env) => env.STAR_CACHE.get(env.STAR_CACHE.idFromName("global"))

const MAX_REPOS = 40

app.get("/api/stars", async (c) => {
	const raw = c.req.query("repos") ?? ""
	const repos = raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean)
		.slice(0, MAX_REPOS)

	if (repos.length === 0) return c.json({ repos: [] })

	const result = await starStub(c.env).get(repos)
	c.header("cache-control", "public, max-age=600")
	return c.json({ repos: result })
})

app.get("/api/health", (c) => c.json({ ok: true }))

/** The header a client uses to name itself, so a replayed toggle is a no-op. */
const READER_HEADER = "x-reader-id"

/**
 * GraphQL, over the same two Durable Objects.
 *
 * The reader's identity comes from `x-reader-id`, not the body: the header is
 * what the site's local-first layer already sends with every write, and keeping
 * it out of the document means a queued mutation replays identically.
 *
 * Responses are always 200 with `{data}` or `{errors}`, including for a
 * malformed document, because that is what a GraphQL client parses. Only a
 * body that is not JSON at all is a 400.
 */
app.post("/api/graphql", async (c) => {
	let body: GraphQLRequest
	try {
		body = await c.req.json<GraphQLRequest>()
	} catch {
		return c.json({ errors: [{ message: "request body must be JSON" }] }, 400)
	}

	const result = await runGraphQL(body, {
		readerId: c.req.header(READER_HEADER) ?? null,
		favourite: async (slug) => {
			const state = await favouriteStub(c.env, slug).count()
			return { slug, count: state.count }
		},
		toggleFavourite: async (slug, key) => {
			const state = await favouriteStub(c.env, slug).toggle(key)
			return { slug, count: state.count }
		},
		stars: async (names) => starStub(c.env).get(names.slice(0, MAX_REPOS))
	})

	return c.json(result)
})

export default app
