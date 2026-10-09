/**
 * The typed view of the generated content.
 *
 * `scripts/build-content.ts` writes `.content/content.ts` as plain data: it has no
 * type import and no annotated declarations, because tsx hands a generated `.ts`
 * file to Node's type stripping and a file that carries both is parsed as plain
 * JavaScript, which fails. The shapes live here instead, asserted once against the
 * same `@emmanuel/schema` types the worker serves, so a document that asks for a
 * field the pipeline did not produce fails to compile.
 *
 * Everything else in the app imports from this module, never from `.content`.
 */

import type {
	BlockShape,
	NoteShape,
	PostShape,
	RoleShape,
	SchoolShape,
	ShelfShape,
	SiteShape
} from "@emmanuel/schema"
import generated from "../.content/content.ts"

export interface ContentModule {
	readonly site: SiteShape
	readonly shelves: ShelfShape[]
	readonly posts: PostShape[]
	readonly roles: RoleShape[]
	readonly schools: SchoolShape[]
}

/** The whole generated bundle, typed. */
export const content = generated as ContentModule

export const site: SiteShape = content.site
export const shelves: ShelfShape[] = content.shelves
export const posts: PostShape[] = content.posts
export const roles: RoleShape[] = content.roles
export const schools: SchoolShape[] = content.schools

/** One post by its slug, or `null`. */
export const postBySlug = (slug: string): PostShape | null =>
	posts.find((post) => post.slug === slug) ?? null

/**
 * The notes a set of blocks cites, in note order.
 *
 * This is what puts a footnote on the page that refers to it: the layout asks the
 * blocks it is about to place which notes they carry, and renders those at the
 * foot of that page instead of leaving them to the end of the article.
 */
export const notesFor = (blocks: readonly BlockShape[], notes: readonly NoteShape[]): NoteShape[] => {
	const wanted = new Set(blocks.flatMap((block) => block.noteIds))
	return notes.filter((note) => wanted.has(note.id))
}

/** Where a note sits, so a note number can link back to the block that cites it. */
export const blockForNote = (blocks: readonly BlockShape[], noteId: string): BlockShape | null =>
	blocks.find((block) => block.noteIds.includes(noteId)) ?? null

export type { BlockShape, NoteShape, PostShape, RoleShape, SchoolShape, ShelfShape, SiteShape }
