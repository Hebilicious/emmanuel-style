/**
 * The paginator: blocks into screens.
 *
 * This is the piece the Astro build could not do properly. There, the article
 * arrived as one server-rendered blob of prose and the paginator had to measure a
 * hydrated DOM after the fact, re-deriving page boundaries on every resize and
 * getting it wrong whenever text reflowed at a different width. Here the content is
 * already a list of typed blocks, so pagination is arithmetic over that list: no
 * measurement pass, no reflow hazard, and the notes a block cites are known before
 * anything is rendered.
 *
 * Two things decide where a page ends:
 *
 *   - a block that opens a page (a section heading, a chart, a role) always starts
 *     one, so a section opens on a left page;
 *   - otherwise blocks are packed until the next one would not fit, measured against
 *     the height the pane actually has.
 *
 * Heights come from the rendered DOM, because a block's height depends on the font
 * and the measure. They are read once per layout, not once per turn, and the
 * measurement happens with every block in the flow so nothing is measured at zero.
 */

export interface Pageable {
	readonly id: string
	/** Opens a page of its own. */
	readonly opens?: boolean
	/** Takes a whole spread, as a chart or a role card does. */
	readonly wide?: boolean
}

export interface Page<T> {
	readonly blocks: T[]
	/** `true` when this page is a single wide block and should use the spread. */
	readonly spread: boolean
}

export interface PackOptions {
	/** Height one page has to fill, in px. */
	readonly height: number
	/** Blocks shown at once: two on a wide screen, one on a phone. */
	readonly columns: number
	/** Measured height of each block, by id. */
	readonly heights: ReadonlyMap<string, number>
	/** Vertical gap between blocks, in px. */
	readonly gap: number
}

/**
 * Pack blocks into pages.
 *
 * A block taller than a page gets the page to itself rather than dragging its
 * neighbours with it, and a block marked `wide` always gets one, because a chart or
 * a role card cannot share a screen with anything else and still be read.
 */
export const paginate = <T extends Pageable>(blocks: readonly T[], options: PackOptions): Page<T>[] => {
	const pages: Page<T>[] = []
	if (blocks.length === 0) return pages

	let current: T[] = []
	let used = 0

	const flush = () => {
		if (current.length > 0) {
			pages.push({ blocks: current, spread: current.length === 1 && current[0]?.wide === true })
			current = []
			used = 0
		}
	}

	const heightOf = (block: T) => options.heights.get(block.id) ?? 0

	for (const block of blocks) {
		// A wide block owns the screen.
		if (block.wide === true) {
			flush()
			pages.push({ blocks: [block], spread: true })
			continue
		}

		// A section heading opens a page, so it lands on a left page.
		if (block.opens === true && current.length > 0) flush()

		const next = heightOf(block) + (current.length > 0 ? options.gap : 0)

		if (current.length > 0 && used + next > options.height) {
			/*
			 * A heading must not be left alone at the foot of a page. If the last
			 * block is one, it moves to the next page with the block it introduces.
			 */
			const last = current[current.length - 1]
			if (last?.opens === true) {
				current.pop()
				flush()
				current.push(last)
				used = heightOf(last)
			} else {
				flush()
			}
		}

		current.push(block)
		used += heightOf(block) + (current.length > 1 ? options.gap : 0)
	}

	flush()
	return pages
}

/** How many pages a set of blocks produced. */
export const pageCount = <T extends Pageable>(blocks: readonly T[], options: PackOptions): number =>
	paginate(blocks, options).length
