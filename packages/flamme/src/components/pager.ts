/**
 * The shapes the pager is handed.
 *
 * Kept out of `Pager.vue` so a page can name them without importing a component,
 * and so the generic parameter of the component has a constraint to extend.
 */

/** One block of a paged list: an article block, a library entry, a role. */
export interface PagerItem {
	readonly id: string
	/** Starts a page: a shelf of the Library, a section of the ledger. */
	readonly opens?: boolean
	/** Takes a page of its own, shown across the whole spread: the chart, a role. */
	readonly screen?: boolean
	/** Is never left at the foot of a page on its own: a heading. */
	readonly keep?: boolean
	/**
	 * Moves to the next page whole rather than being split, unless it is taller than
	 * a page, which only a split can show without cropping.
	 */
	readonly atomic?: boolean
	/**
	 * Stretches to fill what is left of its column once the page is laid out. It is
	 * measured at its own height, so it never takes room another block was given.
	 */
	readonly grow?: boolean
	/**
	 * Is shown whole on one page, always. When it is taller than the page it is set
	 * smaller until it fits (`zoom`, never below `MIN_FIT`), rather than being cut:
	 * a role of the ledger, the Library's front page. Implies `atomic`.
	 */
	readonly fit?: boolean
}

/** The smallest a `fit` block is set before it is allowed to split after all. */
export const MIN_FIT = 0.62

/** One footnote, as the foot of a page sets it. */
export interface PagerNote {
	readonly id: string
	readonly number: number
	readonly html: string
}

/** What a page can call on its pager through a template ref. */
export interface PagerHandle {
	turn(delta: number): void
	go(screen: number): void
	/** The screen a block starts on, counted from zero, or -1 before the layout. */
	screenOf(id: string): number
}
