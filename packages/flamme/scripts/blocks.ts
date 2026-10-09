/**
 * The block splitter.
 *
 * A page body is a list of blocks rather than one HTML string because the layout
 * is screen-based: the paginator has to know what it is placing to fill a screen,
 * and it cannot know that about a blob it only sees after the browser has
 * measured it. So the body is split into its top-level nodes, each one rendered
 * standalone, each one carrying the text a search index reads and the footnotes it
 * cites.
 *
 * The footnote handling is the point of this module. `remark-rehype` collects
 * every definition into a single `<section data-footnotes>` at the end of the
 * document and turns the reference in the body into
 *
 *   <sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref>1</a></sup>
 *
 * which is exactly what the layout needs, because the reference names the note it
 * points at. The definitions never become blocks, the reference anchor is
 * unwrapped to a plain `<sup>`, and the note itself is rendered into the block
 * that cites it.
 *
 * Splitting runs on the markdown tree rather than on the rendered HTML string.
 * Reparsing the HTML and regrouping its elements reproduces the same elements, but
 * it loses the markdown underneath them, and a figure's caption is the alt text of
 * an image: reading it from markdown is cheaper and more honest than re-deriving
 * it from the HTML.
 */

import { fromHtml } from "hast-util-from-html"
import { toHtml } from "hast-util-to-html"
import { toString as hastToString } from "hast-util-to-string"
import type { Element } from "hast"
import type {
	Blockquote,
	Code,
	FootnoteDefinition,
	FootnoteReference,
	Heading,
	Image,
	List,
	ListItem,
	Root as MdastRoot,
	RootContent as MdastContent,
	Table
} from "mdast"
import { visit } from "unist-util-visit"
import type { BlockKind, NoteShape } from "@emmanuel/schema"

/** One footnote, as the article defined it. */
export interface NoteDefinition {
	/** `fn-1`. */
	id: string
	/** The number as printed in the text. */
	number: number
	/** The definition's body, ready to render on its own. */
	content: MdastRoot
	/**
	 * The definition rendered. The splitter is tree surgery and does not render, but
	 * a block's HTML has to carry the notes its `noteIds` names, so the pipeline
	 * fills this in before the blocks are built.
	 */
	html: string | null
}

export interface ParsedBlock {
	id: string
	kind: BlockKind
	depth: number
	html: string
	text: string
	noteIds: string[]
	image: string | null
	caption: string | null
}

/** A rendered body, split into the parts the content model is built from. */
export interface SplitBody {
	/** The body's top-level nodes, in reading order, definitions removed. */
	nodes: MdastContent[]
	/** Every note the document defines. */
	notes: NoteDefinition[]
	/** The note numbers the body cites. */
	cited: number[]
}

/** `user-content-fn-1` and `fn-1` name the same note. `fnref-1-2` is a backreference. */
const NOTE_ANCHOR_PATTERN = /^user-content-fn-(\d+)$/
const NOTE_ID_PATTERN = /^fn-(\d+)$/

export const noteId = (number: number) => `fn-${number}`

/** The note number an id or href names, or null when it names no footnote. */
export const noteNumberFrom = (value: string | undefined): number | null => {
	if (!value) return null
	const stripped = value.replace(/^#/, "")
	const match = NOTE_ANCHOR_PATTERN.exec(stripped) ?? NOTE_ID_PATTERN.exec(stripped)
	return match ? Number(match[1]) : null
}

/**
 * Split an article into its blocks and its footnotes.
 *
 * The definitions become notes and are removed from the body, so a definitions
 * list is never a block of the article. Everything else stays in reading order and
 * becomes one block each.
 */
export const splitArticle = (tree: MdastRoot): SplitBody => {
	const notes: NoteDefinition[] = []
	const cited = new Set<number>()
	const nodes: MdastContent[] = []

	for (const node of tree.children) {
		if (node.type === "footnoteDefinition") {
			const definition = node as FootnoteDefinition
			const number = Number(definition.identifier)
			notes.push({
				id: noteId(number),
				number,
				content: { type: "root", children: definition.children },
				html: null
			})
			continue
		}
		nodes.push(node)
	}

	// The whole tree is walked for references, not just the top level, so a citation
	// inside a list item or a table cell counts as one the body makes.
	visit(tree, "footnoteReference", (reference: FootnoteReference) => {
		cited.add(Number(reference.identifier))
	})

	notes.sort((a, b) => a.number - b.number)

	return { nodes, notes, cited: [...cited].sort((a, b) => a - b) }
}

/**
 * Turn the body's nodes into blocks, in reading order, with the footnotes each one
 * cites, and with the notes themselves spliced into the HTML of the block that
 * cites them.
 */
export const toBlocks = (body: SplitBody): ParsedBlock[] =>
	body.nodes.map((node, index) => {
		const block = blockFrom(node, index)
		return block.noteIds.length > 0 ? withNotes(block, body.notes) : block
	})

const blockFrom = (node: MdastContent, index: number): ParsedBlock => {
	const id = `b${index + 1}`
	const noteIds: string[] = []
	visit(node, "footnoteReference", (reference: FootnoteReference) => {
		noteIds.push(noteId(Number(reference.identifier)))
	})
	const notes = [...new Set(noteIds)]

	if (node.type === "paragraph") {
		// A paragraph holding nothing but an image is a figure, which is what the
		// layout places. The caption is the alt text the markdown carried.
		const inline = node.children.filter(
			(child) => !(child.type === "text" && child.value.trim() === "")
		)
		if (inline.length > 0 && inline.every((child) => child.type === "image")) {
			const image = inline[0] as Image
			const alt = (image.alt ?? "").trim()
			return {
				id,
				kind: "figure",
				depth: 0,
				html: "",
				text: alt,
				noteIds: notes,
				image: image.url,
				caption: alt === "" ? null : alt
			}
		}
	}

	return {
		id,
		kind: kindOf(node),
		depth: node.type === "heading" ? (node as Heading).depth : 0,
		html: "",
		text: textOf(node),
		noteIds: notes,
		image: null,
		caption: null
	}
}

const kindOf = (node: MdastContent): BlockKind => {
	switch (node.type) {
		case "heading":
			return "heading"
		case "list":
			return "list"
		case "blockquote":
			return "quote"
		case "code":
			return "code"
		case "table":
			return "table"
		case "thematicBreak":
			return "rule"
		default:
			return "paragraph"
	}
}

/**
 * The plain text a search index reads.
 *
 * Headings are read from the markdown rather than from their rendered HTML, which
 * carries a permalink anchor. A list joins its items with a space because the
 * ordinals are markup and the reading order is already the block's own.
 */
const textOf = (node: MdastContent): string => {
	switch (node.type) {
		case "code":
			return (node as Code).value.trim()
		case "table":
			return tableText(node as Table)
		case "list":
			return listText(node as List)
		case "blockquote": {
			const body = node as Blockquote
			return body.children.map((child) => textOf(child)).join(" ")
		}
		default:
			return inlineText(node)
	}
}

/**
 * The text of a node, with its inline markup dropped.
 *
 * Rendering the node and stripping the tags would be a second round trip through
 * the HTML pipeline; the leaf values of the tree are already the text. An image
 * contributes its alt text, because that is what the block's caption is.
 */
const inlineText = (node: unknown): string => {
	if (typeof node !== "object" || node === null) return ""
	const typed = node as { type?: string; value?: string; alt?: string; children?: unknown[] }
	if (typed.type === "image") return typed.alt ?? ""
	if (typeof typed.value === "string") return typed.value
	if (!Array.isArray(typed.children)) return ""
	return typed.children.map(inlineText).join("")
}

const listText = (node: List): string =>
	node.children
		.map((item: ListItem) => item.children.map((child) => textOf(child as MdastContent)).join(" "))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim()

const tableText = (node: Table): string =>
	node.children
		.flatMap((row) => row.children.map((cell) => inlineText(cell)))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim()

/**
 * Splice the notes a block cites into its HTML.
 *
 * The page renders in reading order and the reference anchor points at a
 * definitions list, so the note goes inside the block that cites it, after the
 * last element, in an `<aside>`. A reader then meets the marker and the note on
 * the same screen rather than a jump to the end of the article. The markers keep
 * `data-footnote-id`, so a page that wants its own placement can still find the
 * note without parsing an href.
 */
export const withNotes = (block: ParsedBlock, notes: NoteDefinition[]): ParsedBlock => {
	const wanted = new Set(block.noteIds)
	const cited = notes.filter((note) => wanted.has(note.id))
	if (cited.length === 0 || cited.some((note) => note.html === null)) return block

	const aside =
		`<aside class="footnotes" data-footnotes-for="${block.id}">` +
		cited
			.map(
				(note) =>
					`<div class="footnote" id="${note.id}" data-footnote-number="${note.number}">${note.html}</div>`
			)
			.join("") +
		"</aside>"

	return { ...block, html: `${block.html}\n${aside}` }
}

/**
 * Turn each rendered block element into the HTML the page gets, with the footnote
 * reference anchors unwrapped.
 *
 * The blocks are rendered per node rather than cut out of the whole body: a table
 * or a nested list is one element, and re-rendering it is what makes `html` a
 * fragment the paginator can place on its own.
 */
export const renderBlocks = (
	blocks: ParsedBlock[],
	body: SplitBody,
	render: (node: MdastContent) => string,
	notesById: Map<string, NoteShape>
): ParsedBlock[] =>
	blocks.map((block, index) => {
		// `noUncheckedIndexedAccess` types the lookup as possibly absent; the blocks and
		// the nodes are built from one another, so the pairing holds.
		const node = body.nodes[index]
		if (node === undefined) return block
		const html = render(node)
		return { ...block, html: block.noteIds.length > 0 ? withNotes({ ...block, html }, body.notes).html : unwrapFootnoteRefs(html, notesById) }
	})

/**
 * Rewrite the footnote reference anchors in a rendered block to plain
 * superscripts.
 *
 * The rendered reference is `<sup><a href="#user-content-fn-1" …>1</a></sup>`. The
 * block already records that it cites `fn-1`, and the page renders the note beside
 * the sentence, so the anchor is replaced by a `<sup>` that still names the note in
 * `data-footnote-id` and still prints its number.
 */
export const unwrapFootnoteRefs = (html: string, notesById: Map<string, NoteShape>): string =>
	html.replace(
		/<sup><a href="#user-content-fnref-[\d-]+"[^>]*data-footnote-ref[^>]*>([\s\S]*?)<\/a><\/sup>/g,
		(_full, marker: string) => {
			const number = Number(String(marker).replace(/\D/g, ""))
			const note = notesById.get(noteId(number))
			const id = note?.id ?? (Number.isFinite(number) ? noteId(number) : "")
			return `<sup class="footnote-ref" data-footnote-id="${id}">${marker}</sup>`
		}
	)

/** The HTML of one element, with no wrapper elements added. */
export const elementHtml = (element: Element): string => toHtml(element)

/** Read a rendered fragment back into elements, for a caller that has only HTML. */
export const elementsOf = (html: string): Element[] =>
	fromHtml(html, { fragment: true }).children.filter(
		(node): node is Element => node.type === "element"
	)

/** The text of a fragment of HTML. */
export const htmlText = (html: string): string => {
	// `fromHtml` returns a `Root` for a fragment, and `hastToString` wants the narrower
	// `Nodes` union; the root is what it accepts, so the cast names that.
	const tree = fromHtml(html, { fragment: true })
	return hastToString(tree as unknown as Parameters<typeof hastToString>[0])
		.replace(/\s+/g, " ")
		.trim()
}

/**
 * Assert the citations and the definitions agree.
 *
 * The layout only reaches a footnote through the block that cites it, so a note
 * nobody cites never renders and a citation nobody defines has nothing to render.
 * Both are build errors rather than warnings: the article is wrong, not the
 * pipeline.
 */
export const assertNotesAgree = (body: SplitBody): void => {
	const defined = new Set(body.notes.map((note) => note.number))
	const cited = new Set(body.cited)
	const undefinedRefs = body.cited.filter((number) => !defined.has(number))
	const uncited = body.notes.map((note) => note.number).filter((number) => !cited.has(number))

	if (undefinedRefs.length === 0 && uncited.length === 0) return

	const lines: string[] = []
	if (undefinedRefs.length > 0) {
		lines.push(`cited but never defined: ${undefinedRefs.map(noteId).join(", ")}`)
	}
	if (uncited.length > 0) {
		lines.push(`defined but never cited: ${uncited.map(noteId).join(", ")}`)
	}
	throw new Error(`footnotes do not agree with the body\n  ${lines.join("\n  ")}`)
}
