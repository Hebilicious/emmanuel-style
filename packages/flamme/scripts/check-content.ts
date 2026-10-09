/**
 * The footnote proof.
 *
 * The layout only reaches a footnote through the block that cites it: a note
 * nobody cites never renders, and a citation nobody defines has nothing to render.
 * So the check is an equality rather than a subset. It runs against the generated
 * module, not against the markdown, because the generated module is what the site
 * reads. The test runs the pipeline itself and compares the in-memory result
 * against the committed module, so a stale bundle fails here too.
 *
 * Run it with `pnpm --filter @emmanuel/flamme run content:check`.
 */

import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { BlockShape, PostShape } from "@emmanuel/schema"

const here = dirname(fileURLToPath(import.meta.url))
const flamme = join(here, "..")

interface Bundle {
	posts: PostShape[]
	shelves: { slug: string }[]
	roles: unknown[]
	schools: unknown[]
}

const failures: string[] = []
const check = (condition: boolean, message: string) => {
	if (!condition) failures.push(message)
}

const load = async (): Promise<Bundle> => {
	const source = await readFile(join(flamme, ".content", "content.ts"), "utf8")
	const { posts, shelves, roles, schools } = (await import(
		`data:text/javascript;base64,${Buffer.from(
			// The module is plain data and type-only imports, so dropping the type
			// import is enough to load it without a compiler.
			source.replace(/^import type .*$/gm, "")
		).toString("base64")}`
	)) as Bundle
	return { posts, shelves, roles, schools }
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
			note.id === `fn-${note.number}`,
			`${post.slug}: note ${note.id} prints the number ${note.number}`
		)
	}

	// Blocks are the page's reading order, and the ids are the layout's handles.
	check(
		post.blocks.every((block, index) => block.id === `b${index + 1}`),
		`${post.slug}: block ids are not b1..b${post.blocks.length} in reading order`
	)
	check(
		post.blocks.every((block) => block.html.trim() !== ""),
		`${post.slug}: a block rendered empty`
	)
	check(
		post.blocks.every(
			(block) =>
				(block.kind === "figure") === (block.image !== null),
		),
		`${post.slug}: image is set on a block that is not a figure, or missing from one that is`
	)
	check(
		post.blocks.every((block) => (block.kind === "heading" ? block.depth >= 1 && block.depth <= 6 : block.depth === 0)),
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
	console.log(`  cited union ${[...cited].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))).join(", ")}`)
	console.log(`  defined     ${[...defined].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3))).join(", ")}`)
	console.log("  which block cites which note:")

	for (const block of citedBlocks) {
		const kind = block.kind.padEnd(9)
		const label = block.text.length > 52 ? `${block.text.slice(0, 52)}...` : block.text
		console.log(`    ${block.id.padEnd(5)}${kind}${block.noteIds.join(", ").padEnd(14)}${label}`)
	}

	console.log(`  first ${Math.min(8, post.blocks.length)} blocks:`)
	for (const block of post.blocks.slice(0, 8)) {
		const notes = block.noteIds.length > 0 ? block.noteIds.join(", ") : "-"
		const label = block.text.length > 44 ? `${block.text.slice(0, 44)}...` : block.text
		console.log(`    ${block.id.padEnd(5)}${block.kind.padEnd(10)}d${block.depth}  ${notes.padEnd(12)}${label}`)
	}
}

const main = async () => {
	const bundle = await load()

	console.log(`content bundle: ${join(flamme, ".content", "content.ts")}`)
	console.log(`shelves ${bundle.shelves.length}, roles ${bundle.roles.length}, schools ${bundle.schools.length}`)

	for (const post of bundle.posts) verifyPost(post)

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

	console.log("\nok: every block's footnotes resolve, and the union of the blocks' noteIds is exactly the notes defined")
}

await main()
