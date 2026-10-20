/**
 * The footnote proof, and the Library's.
 *
 * The layout only reaches a footnote through the block that cites it: a note
 * nobody cites never renders, and a citation nobody defines has nothing to render.
 * So the check is an equality rather than a subset. It runs against the generated
 * module, not against the markdown, because the generated module is what the site
 * reads. The test runs the pipeline itself and compares the in-memory result
 * against the committed module, so a stale bundle fails here too.
 *
 * The Library is checked for what its pages rely on: every project has a name of its
 * own (its address), a cover the component can draw, a place on the front page that
 * no other project has, and outside work carries its pull requests.
 *
 * Run it with `pnpm --filter @emmanuel/flamme run content:check`.
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { BlockShape, PostShape, ProjectShape, SkillShape } from "@emmanuel/schema"
import { MOTIFS } from "../src/components/cover.ts"

const here = dirname(fileURLToPath(import.meta.url))
const flamme = join(here, "..")

interface Bundle {
	posts: PostShape[]
	shelves: { slug: string; projects: ProjectShape[] }[]
	roles: unknown[]
	schools: unknown[]
	skills: SkillShape[]
}

const failures: string[] = []
const check = (condition: boolean, message: string) => {
	if (!condition) failures.push(message)
}

const load = async (): Promise<Bundle> => {
	const source = await readFile(join(flamme, ".content", "content.ts"), "utf8")
	const { posts, shelves, roles, schools, skills } = (await import(
		`data:text/javascript;base64,${Buffer.from(
			// The module is plain data and type-only imports, so dropping the type
			// import is enough to load it without a compiler.
			source.replace(/^import type .*$/gm, "")
		).toString("base64")}`
	)) as Bundle
	return { posts, shelves, roles, schools, skills }
}

const citedBy = (block: BlockShape) => block.noteIds

const verifyPost = (post: PostShape) => {
	const defined = new Set(post.notes.map((note) => note.id))
	const cited = new Set(post.blocks.flatMap(citedBy))

	const undefinedCitations = [...cited].filter((id) => !defined.has(id))
	const uncitedNotes = [...defined].filter((id) => !cited.has(id))

	check(
		undefinedCitations.length === 0,
		`${post.slug}: ${undefinedCitations.length} citation(s) with no definition: ${undefinedCitations.join(", ")}`
	)
	check(
		uncitedNotes.length === 0,
		`${post.slug}: ${uncitedNotes.length} note(s) never cited by a block: ${uncitedNotes.join(", ")}`
	)
	check(
		defined.size === cited.size && [...defined].every((id) => cited.has(id)),
		`${post.slug}: the union of the blocks' noteIds is not the set of notes`
	)

	// The numbering is what the printed markers show, so it has to be the note's
	// own number and not its position.
	for (const note of post.notes) {
		check(
			note.id === `${post.slug}-fn-${note.number}`,
			`${post.slug}: note ${note.id} prints the number ${note.number}`
		)
	}

	// Blocks are the page's reading order, and the ids are the layout's handles.
	check(
		post.blocks.every((block, index) => block.id === `${post.slug}-b${index + 1}`),
		`${post.slug}: block ids are not ${post.slug}-b1..b${post.blocks.length} in reading order`
	)
	check(
		post.blocks.every((block) => block.html.trim() !== ""),
		`${post.slug}: a block rendered empty`
	)
	check(
		post.blocks.every((block) => (block.kind === "figure") === (block.image !== null)),
		`${post.slug}: image is set on a block that is not a figure, or missing from one that is`
	)
	check(
		post.blocks.every((block) =>
			block.kind === "heading" ? block.depth >= 1 && block.depth <= 6 : block.depth === 0
		),
		`${post.slug}: a heading has no depth, or a non-heading has one`
	)

	const kinds = new Set(post.blocks.map((block) => block.kind))
	const citedBlocks = post.blocks.filter((block) => block.noteIds.length > 0)

	console.log(`\n${post.slug}`)
	console.log(`  title       ${post.title}`)
	console.log(`  date        ${post.date}`)
	console.log(`  tags        ${post.tags.join(", ")}`)
	console.log(`  blocks      ${post.blocks.length}`)
	console.log(`  notes       ${post.notes.length}`)
	console.log(`  kinds       ${[...kinds].sort().join(", ")}`)
	console.log(`  figures     ${post.blocks.filter((block) => block.kind === "figure").length}`)
	const byNumber = (a: string, b: string) =>
		Number(/(\d+)$/.exec(a)?.[1]) - Number(/(\d+)$/.exec(b)?.[1])
	console.log(`  cited union ${[...cited].sort(byNumber).join(", ")}`)
	console.log(`  defined     ${[...defined].sort(byNumber).join(", ")}`)
	console.log("  which block cites which note:")

	for (const block of citedBlocks) {
		const kind = block.kind.padEnd(9)
		const label = block.text.length > 52 ? `${block.text.slice(0, 52)}...` : block.text
		console.log(`    ${block.id.padEnd(22)}${kind}${block.noteIds.join(", ").padEnd(22)}${label}`)
	}

	console.log(`  first ${Math.min(8, post.blocks.length)} blocks:`)
	for (const block of post.blocks.slice(0, 8)) {
		const notes = block.noteIds.length > 0 ? block.noteIds.join(", ") : "-"
		const label = block.text.length > 44 ? `${block.text.slice(0, 44)}...` : block.text
		console.log(
			`    ${block.id.padEnd(22)}${block.kind.padEnd(10)}d${block.depth}  ${notes.padEnd(12)}${label}`
		)
	}
}

const verifyLibrary = (shelves: Bundle["shelves"]) => {
	const projects = shelves.flatMap((shelf) => shelf.projects)
	const names = projects.map((project) => project.name)
	const duplicates = names.filter((name, index) => names.indexOf(name) !== index)
	check(duplicates.length === 0, `library: names used twice: ${duplicates.join(", ")}`)
	for (const project of projects) {
		check(/^[a-z0-9][a-z0-9-]*$/.test(project.name), `library: ${project.name} is not an address`)
		check(
			(MOTIFS as readonly string[]).includes(project.cover),
			`library: ${project.name} draws an unknown cover "${project.cover}"`
		)
		check(
			project.tagline.trim() !== "" && project.body.length > 0,
			`library: ${project.name} has no tagline or no text`
		)
		if (project.kind !== "project") {
			check(
				project.contributions !== null && project.contributions > 0,
				`library: ${project.name} is outside work with no merged pull requests`
			)
			check(
				project.links.length > 0,
				`library: ${project.name} is outside work with no pull requests to read`
			)
			check(
				project.repo === null,
				`library: ${project.name} is outside work but asks for a star count`
			)
		}
	}
	const places = projects.flatMap((project) =>
		project.featured === null ? [] : [project.featured]
	)
	check(
		new Set(places).size === places.length,
		"library: two projects share a place on the front page"
	)
	check(places.includes(1), "library: nothing leads the front page")
	console.log(
		`\nlibrary: ${projects.length} projects on ${shelves.length} shelves, ${places.length} on the front page`
	)
}

/** Every skill cites real work: the projects it names are in the Library. */
const verifySkills = (skills: SkillShape[], shelves: Bundle["shelves"]) => {
	const names = new Set(shelves.flatMap((shelf) => shelf.projects.map((project) => project.name)))
	for (const skill of skills) {
		check(/^[a-z0-9][a-z0-9-]*$/.test(skill.name), `skills: ${skill.name} is not a skill name`)
		check(
			skill.description.startsWith("Use when"),
			`skills: ${skill.name}'s description does not say when to use it`
		)
		check(skill.evidence.length > 0, `skills: ${skill.name} cites no evidence`)
		for (const project of skill.evidence) {
			check(
				names.has(project),
				`skills: ${skill.name} cites "${project}", which is not in the Library`
			)
		}
	}
	console.log(`skills: ${skills.length}, each citing the Library`)
}

const main = async () => {
	const bundle = await load()

	console.log(`content bundle: ${join(flamme, ".content", "content.ts")}`)
	console.log(
		`shelves ${bundle.shelves.length}, roles ${bundle.roles.length}, schools ${bundle.schools.length}`
	)

	for (const post of bundle.posts) verifyPost(post)
	verifyLibrary(bundle.shelves)
	verifySkills(bundle.skills, bundle.shelves)

	// Every footnote in the article is reachable from a block, and the page's
	// block list is what the layout paginates, so an empty body is a failure too.
	check(bundle.posts.length > 0, "the bundle has no posts")
	for (const post of bundle.posts) {
		check(post.blocks.length > 0, `${post.slug}: no blocks`)
	}

	if (failures.length > 0) {
		console.error(`\n${failures.length} failure(s):`)
		for (const failure of failures) console.error(`  ${failure}`)
		process.exitCode = 1
		return
	}

	console.log(
		"\nok: every block's footnotes resolve, and the union of the blocks' noteIds is exactly the notes defined"
	)
}

await main()
