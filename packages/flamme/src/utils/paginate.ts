/**
 * The paginator: measured blocks into pages, and pages into screens.
 *
 * The site is a fixed screen, so a long text is read as a series of spreads rather
 * than scrolled. This module is the arithmetic of that: it is handed the measured
 * blocks of a page and returns which part of which block goes on which page. It is
 * pure, so the rules can be tested without a browser; `Pager.vue` does the
 * measuring and the rendering.
 *
 * A column is filled to its foot, the way a newspaper sets type. A block that does
 * not fit whole is split at a line boundary, and its remainder opens the next
 * page: the same block is rendered on both pages, each showing the lines that
 * belong to it. A block is only ever cut where `cuts` allows, which the measuring
 * pass places in the gaps between lines of text, so a line is never sliced in two.
 *
 * The rules, in the order they apply:
 *
 *   1. a `screen` block takes a page of its own, which the spread shows across its
 *      whole width: a chart, or a role;
 *   2. an `opens` block starts a page: a shelf of the Library;
 *   3. a `keep` block is never left at the foot of a page without at least the start
 *      of the block after it: a heading;
 *   4. a block is split only when each part keeps `minLines` lines, so no page opens
 *      on a single stranded line or closes on one;
 *   5. a footnote is set at the foot of the page whose text cites it, and the space
 *      it takes is part of what the page has to fit.
 */

export interface Measured {
	readonly id: string
	/** The block's height, in px, at the width it is rendered at. */
	readonly height: number
	/**
	 * Offsets, in px from the block's top, where it may be cut, in ascending order.
	 * Each one falls between two lines. A block with none is never split.
	 */
	readonly cuts: readonly number[]
	/** The notes the block cites, with the offset of the line each citation sits on. */
	readonly refs?: readonly { readonly id: string; readonly at: number }[]
	readonly opens?: boolean
	readonly screen?: boolean
	readonly keep?: boolean
	/**
	 * Is moved whole rather than split, unless it is taller than a page: then it is
	 * split anyway, because a page is the most room it will ever have, and showing
	 * it whole would crop it.
	 */
	readonly atomic?: boolean
}

/** The part of one block a page shows, from `from` to `to` px of the block. */
export interface Slice {
	readonly id: string
	readonly from: number
	readonly to: number
	/** The block's full height, so a renderer knows whether this slice is all of it. */
	readonly height: number
}

export interface Page {
	readonly slices: readonly Slice[]
	/** The notes this page's slices cite, in the order they are cited. */
	readonly notes: readonly string[]
	/** A page holding a `screen` block, which the spread shows across its whole width. */
	readonly screen: boolean
}

/** What one turn shows: a page per column, or one `screen` page across them all. */
export interface Screen {
	readonly pages: readonly Page[]
	readonly wide: boolean
}

export interface PackOptions {
	/**
	 * The height a page has to fill, by page index. The first pages can be shorter
	 * than the rest, because the lead of an article sits above them.
	 */
	readonly height: number | ((page: number) => number)
	/** Space between two slices on a page, in px. */
	readonly gap: number
	/** The height of each note as it is set at the foot of a page, by note id. */
	readonly noteHeights?: ReadonlyMap<string, number>
	/** What the notes area adds around its notes: the rule, and the space above it. */
	readonly notesChrome?: number
	/** Space between two notes. */
	readonly noteGap?: number
	/** The fewest lines either part of a split block may have. Default 2. */
	readonly minLines?: number
}

/** The id of a slice that shows all of its block. */
export const isWhole = (slice: Slice): boolean => slice.from === 0 && slice.to >= slice.height

/**
 * Pack measured blocks into pages.
 *
 * Greedy, one page at a time: each block is placed whole if it fits what is left
 * of the page, split at the deepest cut that fits if it does not, or moved to the
 * next page when neither leaves a part worth showing. A block that does not fit an
 * empty page is split wherever it can be, because a page is the most room it will
 * ever have.
 */
export const paginate = (blocks: readonly Measured[], options: PackOptions): Page[] => {
	const pages: Page[] = []
	const minLines = Math.max(1, options.minLines ?? 2)
	const heightOf =
		typeof options.height === "function" ? options.height : () => options.height as number

	let slices: Slice[] = []
	let notes: string[] = []
	let used = 0
	let screen = false

	const notesHeight = (ids: readonly string[]): number => {
		if (ids.length === 0) return 0
		const heights = ids.map((id) => options.noteHeights?.get(id) ?? 0)
		return (
			(options.notesChrome ?? 0) +
			heights.reduce((sum, height) => sum + height, 0) +
			(options.noteGap ?? 0) * (ids.length - 1)
		)
	}

	const flush = () => {
		if (slices.length === 0) return
		pages.push({ slices, notes, screen })
		slices = []
		notes = []
		used = 0
		screen = false
	}

	/** The notes cited by the part of `block` between `from` and `to`. */
	const citedIn = (block: Measured, from: number, to: number): string[] =>
		(block.refs ?? []).filter((ref) => ref.at > from && ref.at <= to).map((ref) => ref.id)

	/** Whether the part of `block` from `from` to `to` fits on the current page. */
	const fits = (block: Measured, from: number, to: number): boolean => {
		const room = heightOf(pages.length)
		const gap = slices.length > 0 ? options.gap : 0
		const merged = [...new Set([...notes, ...citedIn(block, from, to)])]
		return used + gap + (to - from) + notesHeight(merged) <= room + 0.5
	}

	const place = (block: Measured, from: number, to: number) => {
		used += (slices.length > 0 ? options.gap : 0) + (to - from)
		slices.push({ id: block.id, from, to, height: block.height })
		for (const id of citedIn(block, from, to)) if (!notes.includes(id)) notes.push(id)
	}

	/**
	 * The deepest cut after `from` at which the block may end this page.
	 *
	 * `strict` applies the line rule: the part placed and the part left over each
	 * keep `minLines` lines. Without it any cut that fits will do, which is only
	 * asked for on an empty page.
	 */
	const deepestCut = (block: Measured, from: number, strict: boolean): number | null => {
		const lines = [0, ...block.cuts, block.height]
		const start = lines.findIndex((offset) => offset >= from - 0.5)
		for (let end = lines.length - 2; end > start; end -= 1) {
			const cut = lines[end] as number
			if (strict && (end - start < minLines || lines.length - 1 - end < minLines)) continue
			if (fits(block, from, cut)) return cut
		}
		return null
	}

	for (const [index, block] of blocks.entries()) {
		if (block.screen === true || block.opens === true) flush()
		if (block.screen === true) screen = true

		let from = 0
		while (from < block.height - 0.5) {
			if (fits(block, from, block.height)) {
				place(block, from, block.height)
				break
			}

			const empty = slices.length === 0
			const splittable =
				block.atomic !== true || (empty && block.height - from > heightOf(pages.length) + 0.5)
			const cut = splittable
				? (deepestCut(block, from, true) ?? (empty ? deepestCut(block, from, false) : null))
				: null

			if (cut !== null) {
				place(block, from, cut)
				flush()
				if (block.screen === true) screen = true
				from = cut
				continue
			}

			if (!empty) {
				/*
				 * Nothing worth showing fits, so the block moves to the next page. The
				 * `keep` blocks left at the foot of this one (a heading, and the dateline
				 * under it) move with it, so a section never opens on the line before a
				 * page turn. They only move if something else stays behind.
				 */
				const kept: Measured[] = []
				while (kept.length < slices.length - 1) {
					const slice = slices[slices.length - 1 - kept.length]
					const previous = blocks[index - 1 - kept.length]
					if (slice === undefined || previous === undefined) break
					if (previous.keep !== true || slice.id !== previous.id || !isWhole(slice)) break
					kept.unshift(previous)
				}
				if (from === 0 && kept.length > 0) {
					slices.splice(slices.length - kept.length)
					const moved = new Set(kept.flatMap((moving) => citedIn(moving, 0, moving.height)))
					notes = notes.filter((id) => !moved.has(id))
					used = slices.reduce(
						(sum, slice, i) => sum + (i > 0 ? options.gap : 0) + slice.to - slice.from,
						0
					)
					flush()
					for (const moving of kept) place(moving, 0, moving.height)
				} else {
					flush()
				}
				if (block.screen === true) screen = true
				continue
			}

			/*
			 * An empty page and no cut that fits. When the page is a short one (a lead
			 * sits above it) and the next is taller, the page is left to the lead and the
			 * block starts overleaf: on a phone held sideways the headline can leave room
			 * for less than a line, and a block placed there would hang off the page.
			 */
			if (heightOf(pages.length + 1) > heightOf(pages.length) + 0.5) {
				pages.push({ slices: [], notes: [], screen: false })
				continue
			}

			/*
			 * Otherwise the block's first line is taller than a page. It is shown up to
			 * its first cut, or whole, rather than looping.
			 */
			const next = block.cuts.find((offset) => offset > from + 0.5) ?? block.height
			place(block, from, next)
			if (next < block.height) flush()
			from = next
		}

		if (block.screen === true) flush()
	}

	flush()
	return pages
}

/**
 * Group pages into screens.
 *
 * A screen shows `columns` pages side by side. A `screen` page is shown on its own
 * across the whole width, so it closes the screen before it even when that screen
 * has an empty column, and an `opens` page that `opensScreen` names starts a new
 * screen rather than a new column.
 */
export const screens = (
	pages: readonly Page[],
	columns: number,
	opensScreen: (page: Page) => boolean = () => false
): Screen[] => {
	const out: Screen[] = []
	let group: Page[] = []

	const flush = () => {
		if (group.length > 0) out.push({ pages: group, wide: false })
		group = []
	}

	for (const page of pages) {
		if (page.screen) {
			flush()
			out.push({ pages: [page], wide: columns > 1 })
			continue
		}
		if (group.length > 0 && opensScreen(page)) flush()
		group.push(page)
		if (group.length >= columns) flush()
	}

	flush()
	return out
}

/**
 * Cut offsets for a block, from the boxes of the things inside it that must not
 * be sliced: its lines of text, its images, its badges.
 *
 * The boxes are `[top, bottom]` in px from the block's top. Overlapping boxes are
 * merged, and a cut is placed in the middle of every gap between two merged runs,
 * which is the leading between two lines: half of it stays on each page.
 */
export const cutsFrom = (
	boxes: readonly (readonly [number, number])[],
	height: number
): number[] => {
	const sorted = boxes
		.filter(([top, bottom]) => bottom > top)
		.map(([top, bottom]) => [Math.max(0, top), Math.min(height, bottom)] as const)
		.sort((a, b) => a[0] - b[0])

	const runs: [number, number][] = []
	for (const [top, bottom] of sorted) {
		const last = runs[runs.length - 1]
		if (last !== undefined && top < last[1] - 0.5) last[1] = Math.max(last[1], bottom)
		else runs.push([top, bottom])
	}

	const cuts: number[] = []
	for (let index = 0; index < runs.length - 1; index += 1) {
		const end = (runs[index] as [number, number])[1]
		const next = (runs[index + 1] as [number, number])[0]
		const cut = (end + next) / 2
		if (cut > 0.5 && cut < height - 0.5) cuts.push(Math.round(cut * 100) / 100)
	}
	return cuts
}
