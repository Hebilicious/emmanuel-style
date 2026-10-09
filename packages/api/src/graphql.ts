/**
 * The GraphQL surface, served from the worker's own construction.
 *
 * Why not the Pothos schema from `@emmanuel/schema`:
 *
 * The schema exists so the site and the worker agree on field names, but half of
 * it is answered by the app, not by a server: `site`, `post`, `shelves`, `roles`
 * and `schools` are resolved from the markdown bundle inside the browser, and
 * their Pothos resolvers deliberately throw to make that explicit. Mounting that
 * schema here would publish five root fields that can only ever return an error,
 * and would put the whole content model on the public API.
 *
 * So the worker builds its own schema for the operations it actually owns:
 * `favourites`, `toggleFavourite` and `stars`. The shapes match the contract in
 * `packages/schema/schema.graphql` (`Favourite.slug`/`count`, the same argument
 * names), so a document compiled against the shared schema runs here unchanged.
 * Adding a content type here is the thing to avoid: those belong to the
 * app-resolved side.
 *
 * Hand-rolled instead of graphql-yoga: `graphql-js` is already in the workspace
 * as a dependency of the shared schema, and a Yoga plugin stack buys nothing for
 * one POST route.
 */
import {
	buildSchema,
	type ExecutionResult,
	execute,
	type GraphQLError,
	type GraphQLSchema,
	parse,
	validate
} from "graphql"
import { readerKey } from "./reader.ts"
import type { StarCount } from "./stars"

/**
 * The server-owned subset of the shared schema, in SDL.
 *
 * `stars` answers with the star cache's own shape: a repository name and a star
 * count. The rest of `Repository` in the shared schema is app-resolved content,
 * so it is not declared here at all.
 */
export const typeDefs = /* GraphQL */ `
	"""The favourite count of one article."""
	type Favourite {
		slug: ID
		count: Int
	}

	"""One repository's star count."""
	type Repository {
		repo: String
		stars: Int
	}

	type Query {
		"""The favourite count of one article."""
		favourites(slug: String!): Favourite

		"""Repositories with their star counts, for the Library."""
		stars(names: [String!]!): [Repository!]
	}

	type Mutation {
		"""Favourite an article for this reader, or take the favourite back."""
		toggleFavourite(slug: String!): Favourite
	}
`

/** One favourite, as every resolver in this file returns it. */
export interface Favourite {
	slug: string
	count: number
}

/** What the executor needs from the worker; no binding types leak into GraphQL. */
export interface GraphQLContext {
	/** The reader named by `x-reader-id`, or `null` when the header is absent. */
	readerId: string | null
	/** Read one article's favourite count. */
	favourite: (slug: string) => Promise<Favourite>
	/** Flip one reader's favourite for an article. */
	toggleFavourite: (slug: string, readerKey: string) => Promise<Favourite>
	/** Read star counts for the requested repositories. */
	stars: (names: string[]) => Promise<StarCount[]>
}

/**
 * The one failure the client can act on: a toggle with no reader to attribute
 * it to. Everything else is a bug and is reported without leaking internals.
 */
export class MissingReaderIdError extends Error {
	constructor() {
		super("toggleFavourite needs an x-reader-id header to identify the reader")
		this.name = "MissingReaderIdError"
	}
}

export interface GraphQLRequest {
	query?: unknown
	variables?: unknown
	operationName?: unknown
}

/** Build the executable schema once per isolate; the construction is pure. */
export const graphQLSchema: GraphQLSchema = buildSchema(typeDefs)

const errorOf = (message: string): GraphQLError =>
	({ message, locations: undefined, path: undefined }) as unknown as GraphQLError

/**
 * Run one GraphQL document.
 *
 * Malformed and unknown documents come back as `errors`, never as a thrown
 * request failure, which is what a GraphQL client expects to read.
 */
export const runGraphQL = async (
	body: GraphQLRequest,
	context: GraphQLContext
): Promise<ExecutionResult> => {
	if (typeof body.query !== "string" || body.query.trim().length === 0) {
		return { errors: [errorOf("a query string is required")] }
	}

	let document: ReturnType<typeof parse>
	try {
		document = parse(body.query)
	} catch (error) {
		return { errors: [errorOf(error instanceof Error ? error.message : String(error))] }
	}

	const validationErrors = validate(graphQLSchema, document)
	if (validationErrors.length > 0) return { errors: validationErrors }

	const rootValue = {
		favourites: ({ slug }: { slug: string }) => context.favourite(slug),

		/**
		 * This is a toggle, so the reader has to be identifiable: replaying the
		 * site's local write queue has to land on the same state, and an
		 * anonymous caller has nothing to replay a second time.
		 */
		toggleFavourite: async ({ slug }: { slug: string }) => {
			const key = await readerKey(context.readerId)
			if (!key) throw new MissingReaderIdError()
			return context.toggleFavourite(slug, key)
		},

		stars: async ({ names }: { names: string[] }) =>
			(await context.stars(names)).map((entry) => ({
				repo: entry.repo,
				stars: entry.stars
			}))
	}

	const result = await execute({
		schema: graphQLSchema,
		document,
		rootValue,
		contextValue: context,
		variableValues:
			body.variables && typeof body.variables === "object"
				? (body.variables as Record<string, unknown>)
				: undefined,
		operationName: typeof body.operationName === "string" ? body.operationName : undefined
	})

	if (result.errors && result.errors.length > 0) {
		const handled = result.errors.some(
			(error) => error.originalError instanceof MissingReaderIdError
		)
		return {
			errors: [
				errorOf(
					handled
						? "toggleFavourite needs an x-reader-id header to identify the reader"
						: "internal error"
				)
			]
		}
	}

	return result
}
