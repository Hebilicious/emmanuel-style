/**
 * The content pipeline.
 *
 * Reads the Astro package's markdown and data modules and writes
 * `.content/content.ts`, the typed bundle `@emmanuel/schema` describes: the
 * rendered blocks of every article, each block carrying the footnotes it cites,
 * plus the shelves, roles and schools the Library and the Experience page read.
 *
 * The site compiles its documents against the same schema, so a block that asks
 * for a field that does not exist fails at build time, and the data answers from
 * the bundle with the network off.
 *
 * Run it with `pnpm --filter @emmanuel/flamme run content`.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { BlockShape, NoteShape, PostShape, SiteShape } from "@emmanuel/schema"
import type { Root as MdastRoot, RootContent as MdastContent } from "mdast"
import rehypeStringify from "rehype-stringify"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import {
	assertNotesAgree,
	htmlText,
	type NoteDefinition,
	type ParsedBlock,
	splitArticle,
	toBlocks,
	unwrapFootnoteRefs
} from "./blocks.ts"
import remarkFrontMatter from "./remark-front-matter.ts"
import { experiences, schools, shelves } from "./site-data.ts"
import {
	markdownFiles,
	parseFrontMatter,
	readFrontMatter,
	readText,
	relativeTo,
	resolveImages,
	slugOf
} from "./sources.ts"

const here = dirname(fileURLToPath(import.meta.url))
const flamme = relativeTo(here, "..")
const repo = relativeTo(flamme, "..", "..")
const astro = join(repo, "packages", "astro")

const BLOG_DIR = join(astro, "src", "content", "blog")
const ASTRO_IMAGES = join(astro, "src", "assets", "images")
const FLAMME_IMAGES = join(flamme, "public", "images")
const OUTPUT = join(flamme, ".content", "content.ts")

const site: SiteShape = {
	name: "Emmanuel",
	tagline: "Software engineer. Notes on the tools, the science and the history.",
	date: new Date().toISOString().slice(0, 10),
	sections: shelves
}

const warnings: string[] = []
const warn = (message: string) => {
	warnings.push(message)
	console.warn(`warning: ${message}`)
}

/**
 * Markdown to HTML.
 *
 * The GFM extension is what makes `[^1]` a footnote: the reference becomes a
 * superscript anchor to `#user-content-fn-1` and the definitions become an ordered
 * list in a `<section data-footnotes>`. `remark-rehype` and `rehype-stringify` are
 * the plain unified pair the Astro build wraps, so the two sites render the same
 * markdown the same way without this package depending on Astro.
 *
 * Parsing, transforming and stringifying are separate processors on purpose. The
 * article is transformed once and then walked, because the splitter reads the
 * markdown nodes: `footnoteReference` names the note a block cites and
 * `footnoteDefinition` carries the note's own body.
 *
 * HAST is stringified with `allowDangerousHtml` and `allowDangerousCharacters`:
 * the stringifier is handed a fragment of an already-rendered document, so an
 * escaped entity would otherwise come out double-escaped, and inline HTML an
 * article wrote is already in the tree as a `raw` node.
 */
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontMatter)

const transform = unified()
	.use(remarkRehype, { allowDangerousHtml: true })
	.use(rehypeStringify, { allowDangerousHtml: true, allowDangerousCharacters: true })

/**
 * Render one block's markdown node to the HTML the page places.
 *
 * `runSync` returns the tree `remark-rehype` produced; the original node is mdast
 * and the compiler is hast, so the return value is what must be stringified. Using
 * the input instead leaves `paragraph` nodes for `rehype-stringify`, which then
 * throws "Cannot compile unknown node".
 */
const renderNode = (node: MdastContent): string => {
	const copy = structuredClone(node)
	const tree = transform.runSync({ type: "root", children: [copy] } as MdastRoot)
	return transform.stringify(tree as never)
}

/** Render a footnote definition, which the splitter lifted out as its own root. */
const renderNote = (note: NoteDefinition): string => {
	const copy = structuredClone(note.content)
	const tree = transform.runSync(copy)
	return transform.stringify(tree as never)
}

const toNote = (note: NoteDefinition): NoteShape => {
	const html = renderNote(note)
	return { id: note.id, number: note.number, html, text: htmlText(html) }
}

const toPost = async (file: string): Promise<PostShape | null> => {
	const source = await readText(file)
	const { data, body } = parseFrontMatter(source)
	const frontMatter = readFrontMatter(data)
	const slug = slugOf(file)

	if (frontMatter.draft) {
		console.log(`skipping ${slug}: draft`)
		return null
	}
	if (!frontMatter.title) warn(`${slug}: no title in front matter`)
	if (!frontMatter.publishDate) warn(`${slug}: no publishDate in front matter`)

	// A path relative to a markdown file means nothing to a browser. Each image the
	// article points at is checked against the files the site actually serves before
	// anything is rewritten.
	const rewrites = resolveImages(body, FLAMME_IMAGES)
	const rewritten = body.replace(
		/!\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
		(full, alt: string, src: string, title: string) => {
			const target = rewrites.get(src)
			return target ? `![${alt}](${target}${title})` : full
		}
	)

	const tree = parser.parse(rewritten)
	const split = splitArticle(tree)
	assertNotesAgree(split)

	// The notes are rendered before the blocks, because a block's HTML carries the
	// notes its `noteIds` names: the layout gets one string and one list, and the two
	// have to agree.
	const notes = split.notes.map(toNote)
	const notesById = new Map(notes.map((note) => [note.id, note]))

	/*
	 * `toBlocks` reads each node's real kind, text and footnote references, and
	 * `renderBlocks` renders the node and splices in the notes it cites. Splitting
	 * those two steps is what lets the notes be rendered first, so a block's HTML
	 * carries the notes its `noteIds` names.
	 */
	/*
	 * The block HTML carries the footnote reference as a plain superscript and
	 * nothing else.
	 *
	 * `renderBlocks` would also splice the note's own text into the block as an
	 * `<aside>`, which duplicates it: the page renders the notes its blocks cite at
	 * the foot of the column, from `noteIds`. The reference stays, the note body does
	 * not travel with it.
	 */
	const parsed: ParsedBlock[] = toBlocks(split).map((block, index) => {
		const html = unwrapFootnoteRefs(renderNode(split.nodes[index] as never), notesById)
		return { ...block, html }
	})

	const cited = new Set(parsed.flatMap((block) => block.noteIds))
	const dangling = [...cited].filter((id) => !notesById.has(id))
	if (dangling.length > 0) {
		throw new Error(`${slug}: blocks cite notes that do not exist: ${dangling.join(", ")}`)
	}

	const blocks: BlockShape[] = parsed.map((block) => ({
		id: block.id,
		kind: block.kind,
		depth: block.depth,
		html: block.html,
		text: block.text,
		noteIds: block.noteIds,
		image: block.image,
		caption: block.caption
	}))

	for (const block of blocks) {
		if (block.noteIds.length > 0) {
			console.log(`  ${block.id} cites ${block.noteIds.join(", ")}`)
		}
	}

	const citedCount = new Set(blocks.flatMap((block) => block.noteIds)).size
	console.log(
		`${slug}: ${blocks.length} blocks, ${notes.length} notes, ${citedCount} cited, ` +
			`${blocks.filter((block) => block.kind === "figure").length} figures, ${rewrites.size} images`
	)

	return {
		slug,
		title: frontMatter.title,
		description: frontMatter.description,
		date: frontMatter.publishDate,
		tags: frontMatter.tags,
		notes,
		blocks
	}
}

/**
 * The module the site imports.
 *
 * It is TypeScript rather than JSON because the site is compiled against
 * `@emmanuel/schema`, and a JSON import would type every block as `string`. The
 * shapes are annotated from the schema, so this file failing to typecheck means
 * the bundle and the schema have drifted apart.
 */
/**
 * The generated module.
 *
 * Emitted without type annotations and without imports on purpose. tsx hands a
 * `.ts` file to Node's type stripping, and a generated file that carries a type
 * import and annotated `const` declarations is parsed as plain JavaScript when
 * that path is taken, which fails with "Missing initializer in const
 * declaration". `src/content.ts` is the hand-written, typed wrapper: it imports
 * this value and asserts it against the shapes `@emmanuel/schema` declares.
 */
const module = (
	posts: PostShape[],
	sections: SiteShape,
	roles: typeof experiences,
	educationEntries: typeof schools
) => `/**
 * Generated by scripts/build-content.ts. Do not edit.
 *
 * Every block of every article, each carrying the footnotes it cites, plus the
 * data the Library and the Experience page read. Typed by src/content.ts.
 */

export const site = ${json(sections)}

export const shelves = site.sections

export const posts = ${json(posts)}

export const roles = ${json(roles)}

export const schools = ${json(educationEntries)}

export const content = { site, shelves, posts, roles, schools }

export default content
`

const json = (value: unknown) => JSON.stringify(value, null, "\t")

const main = async () => {
	const files = await markdownFiles(BLOG_DIR)
	const posts = (await Promise.all(files.map(toPost))).filter((post): post is PostShape => post !== null)

	if (posts.length === 0) throw new Error(`no published articles under ${BLOG_DIR}`)

	posts.sort((a, b) => b.date.localeCompare(a.date))

	await mkdir(dirname(OUTPUT), { recursive: true })

	const source = module(posts, site, experiences, schools)
	await writeFile(OUTPUT, source, "utf8")

	const blocks = posts.reduce((total, post) => total + post.blocks.length, 0)
	const notes = posts.reduce((total, post) => total + post.notes.length, 0)

	console.log("")
	console.log(`wrote ${OUTPUT}`)
	console.log(
		`${posts.length} posts, ${blocks} blocks, ${notes} notes, ${shelves.length} shelves, ` +
			`${experiences.length} roles, ${schools.length} schools, ` +
			`${(Buffer.byteLength(source) / 1024).toFixed(1)} kB`
	)
	if (warnings.length > 0) {
		console.log(`${warnings.length} warnings`)
		for (const warning of warnings) console.log(`  ${warning}`)
	} else {
		console.log("no warnings")
	}
	console.log(`images served from ${FLAMME_IMAGES}, copied from ${ASTRO_IMAGES}`)
}

await main()
