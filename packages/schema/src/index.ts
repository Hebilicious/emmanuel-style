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
 * The content types (`Site`, `Post`, `Shelf`, `Project`, `Role`) are in the
 * same schema on purpose. The markdown pipeline answers them from the bundle, so a
 * page renders with the network off, and the site reads its own content through
 * the same cache, fragments and local-first layer as the data that does come from
 * a server. A second source of truth for content would defeat that.
 *
 * Pothos builds this code-first: the types here are the single definition, and
 * `sdl.ts` is generated from them for the Flamme compiler, which needs a document.
 */

import SchemaBuilder from "@pothos/core"

/** A repository published on GitHub, as the worker reports its star count. */
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

/** A link worth following from a project: a pull request, a page. */
export interface LinkShape {
	label: string
	url: string
	/** The month it is from, `YYYY-MM`, when it has one. */
	date: string | null
}

/**
 * One piece of work in the Library: a project of its own, or a body of work in
 * someone else's repository (`kind: "upstream"` or `"work"`), read through the pull
 * requests merged there.
 */
export interface ProjectShape {
	/** The address of its page, `/library/<name>`. */
	name: string
	title: string
	tagline: string
	/** What it does and why, a paragraph each. */
	body: string[]
	/** What is worth knowing about it, a line each. */
	points: string[]
	kind: "project" | "upstream" | "work"
	/** The slug of its shelf. */
	shelf: string
	language: string
	stack: string[]
	url: string
	homepage: string | null
	archived: boolean
	/** The repository under the site's GitHub account, for its star count; `null` for outside work. */
	repo: string | null
	started: number
	/** The year it stopped, `null` while it is maintained. */
	ended: number | null
	/** Its place on the Library's front page, `null` when it is not there. */
	featured: number | null
	/** The merged pull requests, for outside work; `null` for a project of its own. */
	contributions: number | null
	/** The month of each merged pull request, `YYYY-MM`, oldest first. */
	activity: string[]
	links: LinkShape[]
	/** The picture its cover draws. */
	cover: string
}

/** One shelf of the Library. */
export interface ShelfShape {
	slug: string
	label: string
	/** The line under the shelf's title. */
	blurb: string
	projects: ProjectShape[]
}

/**
 * One skill, written the way an agent skill is (a `SKILL.md`): a name, a
 * description that says when to load it, and what it does once loaded. Each cites
 * the projects in the Library that are its evidence.
 */
export interface SkillShape {
	/** The skill's name, kebab-case, as a `SKILL.md` front matter has it. */
	name: string
	title: string
	/** "Use when …": the line an agent reads to decide whether to load the skill. */
	description: string
	/** The situations to call it for, a line each. */
	whenToUse: string[]
	/** How it runs, in order. */
	steps: string[]
	tools: string[]
	/** The names of the Library projects that prove it. */
	evidence: string[]
	/** A request it answers, as someone would write it. */
	example: string
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
		Project: ProjectShape
		Link: LinkShape
		Shelf: ShelfShape
		Role: RoleShape
		School: SchoolShape
		Skill: SkillShape
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

builder.objectType("Link", {
	description: "A link worth following from a project.",
	fields: (t) => ({
		label: t.exposeString("label", { nullable: false }),
		url: t.exposeString("url", { nullable: false }),
		date: t.exposeString("date", { nullable: true })
	})
})

builder.objectType("Project", {
	description: "One piece of work in the Library.",
	fields: (t) => ({
		name: t.exposeID("name", { nullable: false }),
		title: t.exposeString("title", { nullable: false }),
		tagline: t.exposeString("tagline", { nullable: false }),
		body: t.exposeStringList("body", { nullable: false }),
		points: t.exposeStringList("points", { nullable: false }),
		kind: t.exposeString("kind", { nullable: false }),
		shelf: t.exposeString("shelf", { nullable: false }),
		language: t.exposeString("language", { nullable: false }),
		stack: t.exposeStringList("stack", { nullable: false }),
		url: t.exposeString("url", { nullable: false }),
		homepage: t.exposeString("homepage", { nullable: true }),
		archived: t.exposeBoolean("archived", { nullable: false }),
		repo: t.exposeString("repo", { nullable: true }),
		started: t.exposeInt("started", { nullable: false }),
		ended: t.exposeInt("ended", { nullable: true }),
		featured: t.exposeInt("featured", { nullable: true }),
		contributions: t.exposeInt("contributions", { nullable: true }),
		activity: t.exposeStringList("activity", { nullable: false }),
		links: t.field({
			type: ["Link"],
			nullable: false,
			resolve: (project) => project.links
		}),
		cover: t.exposeString("cover", { nullable: false })
	})
})

builder.objectType("Shelf", {
	description: "One shelf of the Library.",
	fields: (t) => ({
		slug: t.exposeID("slug", { nullable: false }),
		label: t.exposeString("label", { nullable: false }),
		blurb: t.exposeString("blurb", { nullable: false }),
		projects: t.field({
			type: ["Project"],
			nullable: false,
			resolve: (shelf) => shelf.projects
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

builder.objectType("Skill", {
	description: "One skill, written as an agent skill.",
	fields: (t) => ({
		name: t.exposeID("name", { nullable: false }),
		title: t.exposeString("title", { nullable: false }),
		description: t.exposeString("description", { nullable: false }),
		whenToUse: t.exposeStringList("whenToUse", { nullable: false }),
		steps: t.exposeStringList("steps", { nullable: false }),
		tools: t.exposeStringList("tools", { nullable: false }),
		evidence: t.exposeStringList("evidence", { nullable: false }),
		example: t.exposeString("example", { nullable: false })
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
		projects: t.field({
			type: ["Project"],
			description: "Every piece of work in the Library, shelf by shelf.",
			resolve: () => {
				throw new Error("projects is resolved by the app, not by the schema")
			}
		}),
		project: t.field({
			type: "Project",
			nullable: true,
			args: { name: t.arg.string({ required: true }) },
			resolve: () => {
				throw new Error("project is resolved by the app, not by the schema")
			}
		}),
		roles: t.field({
			type: ["Role"],
			resolve: () => {
				throw new Error("roles is resolved by the app, not by the schema")
			}
		}),
		skills: t.field({
			type: ["Skill"],
			description: "The skills, in the order the Skills section reads them.",
			resolve: () => {
				throw new Error("skills is resolved by the app, not by the schema")
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
