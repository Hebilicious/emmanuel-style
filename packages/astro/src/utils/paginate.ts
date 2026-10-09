/**
 * Screens.
 *
 * The site is a fixed, adaptive screen: a page holds as many whole blocks as fit
 * and the reader moves between screens with `n` / `p`. Nothing scrolls, nothing
 * is cropped, and no element is wider or taller than the space it is given.
 *
 * How it works, in three steps, with no hidden scroll boxes and no offsets:
 *
 *  1. Every block is put back in the flow and measured. The flow is a single
 *     column of the width the blocks will be rendered at, so a measurement is
 *     valid for the render: text cannot reflow between the two.
 *  2. Blocks are assigned to pages, filling each page to the available height.
 *     A heading is kept with the block that follows it, and a block taller than a
 *     page gets a page of its own rather than dragging its neighbours with it.
 *  3. Only the current page's blocks are rendered, as siblings of the flow. The
 *     rest are detached, so they cost nothing and cannot be reached by the
 *     keyboard.
 *
 * Blocks are never re-parented into per-page containers, and the flow never
 * scrolls: both of those were the source of clipped content and of arrow keys
 * panning the pane sideways.
 */
import { pageReady } from "./pageReady"

/** Gap between the two page columns of a spread. */
const gap = () =>
	Number.parseFloat(
		getComputedStyle(document.documentElement).getPropertyValue(
			"--spacing_fluid-column-space-column-s"
		) || "0"
	) || 24

/**
 * A block that opens a page: a shelf or a marked section.
 *
 * Not every heading. Treating each `h2` and `h3` as a page break cut the article
 * into a page per subheading and left the columns a third full.
 */
const opensPage = (el: HTMLElement) =>
	el.matches("[data-section], .ShelfTitle, [data-screen], .Chart")

/** A heading that should not be left alone at the foot of a page. */
const isHeading = (el: HTMLElement) => /^H[1-6]$/.test(el.tagName)

export const createPaginator = () => {
	pageReady((signal) => {
		const pane = document.querySelector<HTMLElement>(".Page")
		const flow = pane?.querySelector<HTMLElement>("[data-flow]")

		/*
		 * A page with nothing to paginate still answers n and p.
		 *
		 * The front page has no flow, so it used to return before installing any
		 * handler and n and p did nothing at all. Here they step the quote instead.
		 */
		if (!pane || !flow) {
			document.addEventListener(
				"keydown",
				(event) => {
					const terminal = document.querySelector<HTMLElement>("[data-terminal]")
					if (terminal && !terminal.hidden) return

					const target = event.target as HTMLElement | null
					const typing =
						target instanceof HTMLInputElement ||
						target instanceof HTMLTextAreaElement ||
						target?.isContentEditable === true
					if (typing) return
					if (event.metaKey || event.ctrlKey || event.altKey) return
					if (!document.querySelector("[data-quotes]")) return

					if (event.key === "n" || event.key === "PageDown") {
						event.preventDefault()
						document.dispatchEvent(new CustomEvent("quote:step", { detail: 1 }))
						return
					}
					if (event.key === "p" || event.key === "PageUp") {
						event.preventDefault()
						document.dispatchEvent(new CustomEvent("quote:step", { detail: -1 }))
					}
				},
				{ signal }
			)
			return
		}

		/**
		 * The blocks in the flow.
		 *
		 * A wrapper marked `data-flatten` contributes its children instead of itself,
		 * so a section whose entries are each a page of their own is seen as those
		 * entries rather than as one block.
		 */
		const collect = () =>
			Array.from(flow.children)
				.filter((child): child is HTMLElement => child instanceof HTMLElement)
				.flatMap((child) =>
					child.hasAttribute("data-flatten")
						? Array.from(child.children).filter(
								(inner): inner is HTMLElement => inner instanceof HTMLElement
							)
						: [child]
				)

		/**
		 * Collected once the flow is populated.
		 *
		 * A framework island renders after this module runs, so an eager read saw only
		 * the server-rendered blocks and every island-rendered section was left out of
		 * the pagination. Waiting for the load event makes the read complete.
		 */
		let source: HTMLElement[] = []

		/**
		 * Blocks that must open a screen, such as a section heading, and blocks that
		 * must fill one, such as a chart or a full role.
		 */
		/**
		 * Blocks that take a page to themselves: a chart, a role. They are taller than
		 * a page can share, so pairing one with anything else would push that content
		 * out of sight.
		 */
		const whole = (block: HTMLElement) => block.matches("[data-screen], .Chart, .Role")
		/**
		 * A block that opens out across the whole spread rather than one column.
		 *
		 * A whole-page block is also wide: a role card uses the screen, so it is never
		 * measured or rendered at a single column's width.
		 */
		const wide = (block: HTMLElement) => block.matches("[data-wide], .Role, [data-screen], .Chart")

		let pages: HTMLElement[][] = [source]
		/** Pages shown at once: two on a wide screen, one on a phone. */
		let spread = 2
		let current = 0
		/** One column per page, built once. */
		let columns: HTMLElement[] = []

		/** Two columns of the pane, less the gutter, is one page's measure. */
		const measure = () => {
			const style = getComputedStyle(pane)
			const padTop = Number.parseFloat(style.paddingTop || "0")
			const padBottom = Number.parseFloat(style.paddingBottom || "0")

			/*
			 * The screen height comes from the shell, not from the pane.
			 *
			 * The pane grows to fit whatever the flow holds, so `clientHeight` reported
			 * the height of the whole article once it had been laid out, and the budget
			 * was wrong by an order of magnitude.
			 */
			const shell = pane.parentElement
			const shellHeight = shell ? shell.getBoundingClientRect().height : window.innerHeight
			const siblings = shell
				? Array.from(shell.children)
						.filter((child) => child !== pane)
						.reduce((sum, child) => sum + child.getBoundingClientRect().height, 0)
				: 0

			const height = Math.max(160, shellHeight - siblings - padTop - padBottom - 8)

			/*
			 * One column on a phone, two everywhere else.
			 *
			 * Two columns need width to be readable, and at a phone width each was
			 * about twenty characters wide with the words broken. This is the only
			 * layout change the site makes, and it is keyed to the same breakpoint the
			 * stylesheet uses.
			 */
			const wide = window.matchMedia("(min-width: 60rem)").matches
			const columns = wide ? 2 : 1
			const width = Math.max(240, (pane.clientWidth - gap() * (columns - 1)) / columns)
			return { height, width, columns }
		}

		/**
		 * The space each block occupies, in order.
		 *
		 * Taken as the distance from one block's top to the next, which already
		 * contains whatever margin collapsed between them. Adding each block's own
		 * margins double-counts every gap and overfills the page.
		 */
		const extents = () => {
			const tops = source.map((block) => block.getBoundingClientRect().top)
			const first = tops[0] ?? 0
			return source.map((block, index) => {
				const end =
					index === source.length - 1
						? tops[index] - first + block.getBoundingClientRect().height
						: tops[index + 1] - first
				return end
			})
		}

		const assign = (height: number, ends: number[]) => {
			const next: HTMLElement[][] = []
			let page: HTMLElement[] = []
			let start = 0

			const flush = () => {
				if (page.length > 0) next.push(page)
				page = []
			}

			for (const [index, block] of source.entries()) {
				// A chart or a role takes a screen to itself.
				if (whole(block)) {
					flush()
					next.push([block])
					start = ends[index]
					continue
				}

				const used = ends[index] - start

				/*
				 * A section heading opens a page, so a shelf or a chapter always starts on
				 * a left page instead of appearing at the foot of a right one. The only
				 * exception is the very first page, which has nothing before it.
				 */
				if (opensPage(block) && page.length > 0) {
					flush()
					start = ends[index - 1] ?? 0
				}

				if (page.length > 0 && used > height) {
					/*
					 * Keep a heading with the block it introduces: a heading alone at the
					 * foot of a page is worse than moving both to the next one.
					 */
					const last = page[page.length - 1]
					if (isHeading(last)) {
						page.pop()
						start = source.indexOf(last) === 0 ? 0 : ends[source.indexOf(last) - 1]
					}

					flush()
					start = index === 0 ? 0 : ends[index - 1]
				}

				page.push(block)
			}

			flush()
			return next
		}

		/**
		 * Build the pages as columns.
		 *
		 * Each page is a real column element with an explicit width, so the browser
		 * resolves its own layout and nothing is clipped or scrolled. Deep blocks stay
		 * where they are; only the column wrappers are created here.
		 */
		const build = () => {
			flow.style.width = `${window.innerWidth}px`
			flow.style.height = ""

			const host = document.createElement("div")
			host.dataset.spreadHost = "true"
			host.style.display = "flex"
			host.style.gap = `${gap()}px`
			host.style.alignItems = "flex-start"

			columns = pages.map((blocks, index) => {
				const column = document.createElement("div")
				column.dataset.pageColumn = String(index)
				/*
				 * A page is one measure wide, which is the width its blocks were
				 * measured at. A page of a single wide block opens out across the spread,
				 * because the block is the page: a role card uses the whole screen rather
				 * than being squeezed into a column and spilling out of it.
				 */
				// A page holding a whole-page block uses the spread.
				column.dataset.pageWidth = blocks.some(wide) ? "spread" : "measure"
				column.style.flex = "0 0 auto"
				column.append(...blocks)
				notesFor(blocks, column)
				return column
			})

			host.append(...columns)
			flow.replaceChildren(host)
		}

		/**
		 * The notes each page cites, placed at the foot of that page.
		 *
		 * The article collects every note at its end, which is correct for one long
		 * document and useless when the document is a screen: the note for a passage
		 * is dozens of pages away. Each page shows the notes its own text cites,
		 * copied from the article's list so the numbering and the links still resolve.
		 */
		const notesFor = (blocks: HTMLElement[], column: HTMLElement) => {
			const cited = new Set<string>()
			for (const block of blocks) {
				for (const ref of Array.from(block.querySelectorAll("[data-footnote-ref]"))) {
					const id = ref.closest("a")?.getAttribute("href")?.replace("#", "")
					if (id) cited.add(id)
				}
			}
			if (cited.size === 0) return

			const source = document.querySelector<HTMLElement>(".footnotes ol")
			if (!source) return

			const list = document.createElement("ol")
			list.dataset.pageNotes = "true"
			for (const id of cited) {
				const note = source.querySelector(`#${CSS.escape(id)}`)
				if (note) list.append(note.cloneNode(true))
			}
			if (list.children.length === 0) return

			const section = document.createElement("section")
			section.dataset.pageNotesSection = "true"
			// Named for assistive technology, not printed as a heading on every page.
			section.setAttribute("aria-label", "Notes")
			section.append(list)
			column.append(section)
		}

		const render = () => {
			/*
			 * The pane is a window on the spread: columns sit side by side and the
			 * window shows two of them. It is moved with a transform and never
			 * scrolled, so no scroll container exists and the arrow keys cannot pan it.
			 */
			const host = flow.firstElementChild as HTMLElement | null
			/*
			 * Offset by the column's own position, not by a fixed stride: a page of
			 * whole-screen blocks is a spread wide while an ordinary page is a single
			 * measure, so the step is not constant.
			 */
			const offset = columns[current]?.offsetLeft ?? 0
			if (host) host.style.transform = `translateX(${-offset}px)`

			const total = Math.ceil(pages.length / spread)
			pane.setAttribute("data-pageCount", String(total))
			pane.dataset.current = String(current)
			document.dispatchEvent(
				new CustomEvent("page:position", {
					detail: { current: Math.floor(current / spread) + 1, total }
				})
			)
		}

		/**
		 * Measure the blocks and lay out the pages.
		 *
		 * The flow is put back to one column of one page's width while measuring, so
		 * a block's height is the height it will have when rendered in a page column.
		 * Measuring at the full pane width made every page overfull, because the text
		 * wrapped into fewer lines than it would in a column.
		 */
		const apply = () => {
			const { height, width, columns } = measure()

			flow.style.removeProperty("transform")
			flow.replaceChildren(...source)
			for (const block of source) {
				block.style.removeProperty("display")
				block.style.removeProperty("width")
			}
			flow.style.width = `${width}px`
			flow.style.height = `${height}px`
			flow.style.overflow = "visible"

			// Published for the CSS that caps figures to a page.
			pane.style.setProperty("--screen-height", `${height}px`)
			pane.style.setProperty("--column-width", `${width}px`)

			// One page at a time on a phone, two on a wide screen.
			spread = columns

			pages = assign(height, extents())
			current = Math.min(current, Math.max(0, pages.length - 1))
			build()
			render()
		}

		/** A turn moves a whole spread: two pages, or one on a phone. */
		const show = (delta: number) => {
			const target = Math.max(0, Math.min(current + delta * spread, pages.length - 1))
			if (target === current) return

			const commit = () => {
				current = target
				render()
				document.dispatchEvent(new CustomEvent("page:turn"))
			}

			const doc = document as Document & { startViewTransition?: (cb: () => void) => void }
			if (typeof doc.startViewTransition === "function") doc.startViewTransition(commit)
			else commit()
		}

		document.addEventListener(
			"keydown",
			(event) => {
				const terminal = document.querySelector<HTMLElement>("[data-terminal]")
				if (terminal && !terminal.hidden) return

				const target = event.target as HTMLElement | null
				const typing =
					target instanceof HTMLInputElement ||
					target instanceof HTMLTextAreaElement ||
					target?.isContentEditable === true
				if (typing) return
				if (event.metaKey || event.ctrlKey || event.altKey) return

				/*
				 * Only n and p turn pages. The arrow keys belong to the cursor: they used
				 * to fall through to the pane's own scrolling, which panned the content
				 * sideways, so every default is refused here.
				 */
				if (event.key === "n" || event.key === "PageDown") {
					event.preventDefault()
					show(1)
					return
				}
				if (event.key === "p" || event.key === "PageUp") {
					event.preventDefault()
					show(-1)
					return
				}

				/*
				 * Arrows and space are not page turns, and left to the browser they scroll
				 * the pane. With the mouse enabled that is wanted; without it the default
				 * is refused so nothing pans.
				 */
				const mouse = document.body.classList.contains("mouse-enabled")
				if (!mouse && (event.key.startsWith("Arrow") || event.key === " ")) {
					event.preventDefault()
				}
			},
			{ signal }
		)

		/*
		 * The wheel is inert unless the visitor asked for a mouse.
		 *
		 * With the mouse enabled there has to be a way to move within a route, so the
		 * panes are allowed to scroll then; without it nothing scrolls at all.
		 */
		document.addEventListener(
			"wheel",
			(event) => {
				if (document.body.classList.contains("mouse-enabled")) return
				event.preventDefault()
			},
			{ passive: false, signal }
		)
		for (const el of [pane, flow]) {
			el.addEventListener("scroll", () => {
				el.scrollTop = 0
				el.scrollLeft = 0
			})
		}

		let resizeTimer = 0
		window.addEventListener(
			"resize",
			() => {
				window.clearTimeout(resizeTimer)
				resizeTimer = window.setTimeout(() => {
					current = 0
					apply()
				}, 150)
			},
			{ signal }
		)

		const start = () => {
			source = collect()
			if (source.length > 0) apply()
		}

		if (document.readyState === "complete") start()
		else window.addEventListener("load", start, { once: true })
	})
}
