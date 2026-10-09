/**
 * The schema for emmanuel.style.
 *
 * One schema, two consumers:
 *
 *   - the worker (`@emmanuel/api`) binds it to the Durable Objects and serves it
 *     over HTTP, which is how favourites and star counts reach a browser;
 *   - the site (`@emmanuel/flamme`) compiles its documents against it, so a
 *     document that asks for a field that does not exist fails at build time.
 *
 * The content types (`Site`, `DocPage`, `Shelf`, `Repository`, `Role`) are in the
 * same schema on purpose. The markdown pipeline answers them from the bundle, so a
 * page renders with the network off, and the site reads its own content through
 * the same cache, fragments and local-first layer as the data that does come from
 * a server. A second source of truth for content would defeat that.
 *
 * Pothos builds this code-first: the types here are the single definition, and
 * `sdl.ts` is generated from them for the Flamme compiler, which needs a document.
 */

import SchemaBuilder from "@pothos/core"

/** A repository published on GitHub, as the Library lists it. */
export interface RepositoryShape {
	name: string
	description: string
	language: string
	url: string
	homepage: string | null
	archived: boolean
	category: string
	/** Filled from the star cache; `null` when the cache has no answer yet. */
	stars: number | null
}

/** One shelf of the Library: a named group of repositories. */
export interface ShelfShape {
	slug: string
	label: string
	repositories: RepositoryShape[]
}

/** One role, as the Experience page reads it. */
export interface RoleShape {
	id: string
	title: string
	company: string
	location: string
	start: string
	end: string | null
	summary: string
	highlights: string[]
	stack: string[]
}

/** One education entry. */
export interface SchoolShape {
	id: string
	qualification: string
	school: string
	location: string
	start: string
	end: string | null
	summary: string
}

/** The GraphQL type of a markdown block, so a page's body can be laid out. */
export type BlockKind =
	| "heading"
	| "paragraph"
	| "figure"
	| "list"
	| "quote"
	| "code"
	| "table"
	| "rule"

/**
 * One block of a page's body.
 *
 * The body is a list of blocks rather than one HTML string because the layout is
 * screen-based: the paginator has to know what it is placing to fill a page, and it
 * cannot know that about a blob it only sees after the browser has measured it.
 * `html` is the block rendered, `text` is what a search index or a caption reads,
 * and `noteIds` are the footnotes this block cites, which is what puts a note on
 * the page that refers to it instead of at the end of the article.
 */
export interface BlockShape {
	id: string
	kind: BlockKind
	/** Heading depth, 0 for a block that is not a heading. */
	depth: number
	html: string
	text: string
	noteIds: string[]
	/** A figure's image and caption, empty for every other kind. */
	image: string | null
	caption: string | null
}

/** One footnote. */
export interface NoteShape {
	id: string
	/** The number as printed in the text. */
	number: number
	html: string
	text: string
}

/** One article. */
export interface PostShape {
	slug: string
	title: string
	description: string
	date: string
	tags: string[]
	notes: NoteShape[]
	blocks: BlockShape[]
}

/** The site-wide facts every route renders. */
export interface SiteShape {
	name: string
	tagline: string
	date: string
	sections: ShelfShape[]
}

const builder = new SchemaBuilder<{
	Objects: {
		Site: SiteShape
		Post: PostShape
		Block: BlockShape
		Note: NoteShape
		Repository: RepositoryShape
		Shelf: ShelfShape
		Role: RoleShape
		School: SchoolShape
		Favourite: { slug: string; count: number }
	}
}>({})

const Block = builder.objectRef<BlockShape>("Block")
const Note = builder.objectRef<NoteShape>("Note")
const Repository = builder.objectRef<RepositoryShape>("Repository")

builder.objectType(Block, {
	description: "One block of a page body, in reading order.",
	fields: (t) => ({
		id: t.exposeID("id", { nullable: false }),
		kind: t.exposeString("kind", { nullable: false }),
		depth: t.exposeInt("depth", { nullable: false }),
		html: t.exposeString("html", { nullable: false }),
		text: t.exposeString("text", { nullable: false }),
		noteIds: t.exposeStringList("noteIds", {
			nullable: false,
			description: "The footnotes this block cites, which belong on its page."
		}),
		image: t.exposeString("image", { nullable: true }),
		caption: t.exposeString("caption", { nullable: true })
	})
})

builder.objectType(Note, {
	description: "One footnote.",
	fields: (t) => ({
		id: t.exposeID("id", { nullable: false }),
		number: t.exposeInt("number", { nullable: false }),
		html: t.exposeString("html", { nullable: false }),
		text: t.exposeString("text", { nullable: false })
	})
})

builder.objectType(Repository, {
	description: "A repository published on GitHub.",
	fields: (t) => ({
		name: t.exposeString("name", { nullable: false }),
		description: t.exposeString("description", { nullable: false }),
		language: t.exposeString("language", { nullable: false }),
		url: t.exposeString("url", { nullable: false }),
		homepage: t.exposeString("homepage", { nullable: true }),
		archived: t.exposeBoolean("archived", { nullable: false }),
		category: t.exposeString("category", { nullable: false }),
		stars: t.exposeInt("stars", { nullable: true })
	})
})

builder.objectType("Shelf", {
	description: "A named group of repositories.",
	fields: (t) => ({
		slug: t.exposeID("slug", { nullable: false }),
		label: t.exposeString("label", { nullable: false }),
		repositories: t.field({
			type: [Repository],
			resolve: (shelf) => shelf.repositories
		})
	})
})

builder.objectType("Post", {
	description: "One article.",
	fields: (t) => ({
		slug: t.exposeID("slug", { nullable: false }),
		title: t.exposeString("title", { nullable: false }),
		description: t.exposeString("description", { nullable: false }),
		date: t.exposeString("date", { nullable: false }),
		tags: t.exposeStringList("tags", { nullable: false }),
		blocks: t.field({
			type: [Block],
			description: "The body, in reading order.",
			resolve: (post) => post.blocks
		}),
		notes: t.field({
			type: [Note],
			description: "Every footnote, so a page can place the ones its blocks cite.",
			resolve: (post) => post.notes
		})
	})
})

builder.objectType("Site", {
	description: "The site-wide facts.",
	fields: (t) => ({
		name: t.exposeString("name", { nullable: false }),
		tagline: t.exposeString("tagline", { nullable: false }),
		date: t.exposeString("date", { nullable: false }),
		sections: t.field({
			type: ["Shelf"],
			resolve: (site) => site.sections
		})
	})
})

builder.objectType("Role", {
	description: "One role.",
	fields: (t) => ({
		id: t.exposeID("id", { nullable: false }),
		title: t.exposeString("title", { nullable: false }),
		company: t.exposeString("company", { nullable: false }),
		location: t.exposeString("location", { nullable: false }),
		start: t.exposeString("start", { nullable: false }),
		end: t.exposeString("end", { nullable: true }),
		summary: t.exposeString("summary", { nullable: false }),
		highlights: t.exposeStringList("highlights", { nullable: false }),
		stack: t.exposeStringList("stack", { nullable: false })
	})
})

builder.objectType("School", {
	description: "One education entry.",
	fields: (t) => ({
		id: t.exposeID("id", { nullable: false }),
		qualification: t.exposeString("qualification", { nullable: false }),
		school: t.exposeString("school", { nullable: false }),
		location: t.exposeString("location", { nullable: false }),
		start: t.exposeString("start", { nullable: false }),
		end: t.exposeString("end", { nullable: true }),
		summary: t.exposeString("summary", { nullable: false })
	})
})

builder.objectType("Favourite", {
	description: "The favourite count of one article.",
	fields: (t) => ({
		slug: t.exposeID("slug", { nullable: false }),
		count: t.exposeInt("count", { nullable: false })
	})
})

builder.queryType({
	fields: (t) => ({
		site: t.field({
			type: "Site",
			resolve: () => {
				throw new Error("site is resolved by the app, not by the schema")
			}
		}),
		post: t.field({
			type: "Post",
			nullable: true,
			args: { slug: t.arg.string({ required: true }) },
			resolve: () => {
				throw new Error("post is resolved by the app, not by the schema")
			}
		}),
		posts: t.field({
			type: ["Post"],
			description: "Every article, newest first, for the blog index.",
			resolve: () => {
				throw new Error("posts is resolved by the app, not by the schema")
			}
		}),
		shelves: t.field({
			type: ["Shelf"],
			resolve: () => {
				throw new Error("shelves is resolved by the app, not by the schema")
			}
		}),
		roles: t.field({
			type: ["Role"],
			resolve: () => {
				throw new Error("roles is resolved by the app, not by the schema")
			}
		}),
		schools: t.field({
			type: ["School"],
			resolve: () => {
				throw new Error("schools is resolved by the app, not by the schema")
			}
		}),
		favourites: t.field({
			type: "Favourite",
			description: "The favourite count of one article.",
			args: { slug: t.arg.string({ required: true }) },
			resolve: (_root, args) => ({ slug: args.slug, count: 0 })
		}),
		stars: t.field({
			type: ["Repository"],
			description: "Repositories with their star counts, for the Library.",
			args: { names: t.arg.stringList({ required: true }) },
			resolve: () => []
		})
	})
})

builder.mutationType({
	fields: (t) => ({
		toggleFavourite: t.field({
			type: "Favourite",
			description: "Favourite an article for this reader, or take the favourite back.",
			args: { slug: t.arg.string({ required: true }) },
			resolve: (_root, args) => ({ slug: args.slug, count: 0 })
		})
	})
})

export const schema = builder.toSchema()
export default schema
