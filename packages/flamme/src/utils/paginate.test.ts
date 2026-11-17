import { describe, expect, it } from "vitest"
import { cutsFrom, isWhole, type Measured, paginate, screens } from "./paginate.ts"

/** A block of `lines` lines of `lineHeight` px, cuttable between every two lines. */
const text = (
	id: string,
	lines: number,
	lineHeight = 20,
	extra: Partial<Measured> = {}
): Measured => ({
	id,
	height: lines * lineHeight,
	cuts: Array.from({ length: lines - 1 }, (_, index) => (index + 1) * lineHeight),
	...extra
})

const ids = (pages: ReturnType<typeof paginate>) =>
	pages.map((page) =>
		page.slices.map((slice) =>
			isWhole(slice) ? slice.id : `${slice.id}[${slice.from}-${slice.to}]`
		)
	)

describe("paginate", () => {
	it("packs whole blocks until the page is full", () => {
		const pages = paginate([text("a", 2), text("b", 2), text("c", 2)], { height: 100, gap: 10 })
		expect(ids(pages)).toEqual([["a", "b"], ["c"]])
	})

	it("splits a block at a line boundary to fill the page", () => {
		const pages = paginate([text("a", 2), text("b", 8)], { height: 100, gap: 0 })
		// a takes 40px, so 3 lines of b fit on the first page and 5 go to the second.
		expect(ids(pages)).toEqual([["a", "b[0-60]"], ["b[60-160]"]])
	})

	it("never leaves a single line on either side of a split", () => {
		const pages = paginate([text("a", 4), text("b", 4)], { height: 100, gap: 0 })
		// Only one line of b would fit after a, so b moves to the next page whole.
		expect(ids(pages)).toEqual([["a"], ["b"]])
	})

	it("keeps a heading with the block it introduces", () => {
		const heading = text("h", 1, 20, { keep: true })
		const pages = paginate([text("a", 3), heading, text("b", 6)], { height: 100, gap: 0 })
		// After a (60px) and h (20px) one line of b fits, which the line rule refuses,
		// so h moves to the next page with b instead of being stranded there.
		expect(ids(pages)).toEqual([["a"], ["h", "b[0-80]"], ["b[80-120]"]])
	})

	it("keeps a heading and its dateline together with the text they introduce", () => {
		const heading = text("h", 1, 20, { keep: true })
		const dateline = text("d", 1, 20, { keep: true })
		const pages = paginate([text("a", 3), heading, dateline, text("b", 3)], { height: 100, gap: 0 })
		// a, h and d fill 100px, and none of b fits, so h and d move over with b.
		expect(ids(pages)).toEqual([["a"], ["h", "d", "b"]])
	})

	it("starts a page at an opening block", () => {
		const pages = paginate([text("a", 1), text("b", 1, 20, { opens: true }), text("c", 1)], {
			height: 100,
			gap: 0
		})
		expect(ids(pages)).toEqual([["a"], ["b", "c"]])
	})

	it("gives a screen block a page of its own, and splits it when it is taller", () => {
		const pages = paginate([text("a", 1), text("chart", 8, 20, { screen: true }), text("b", 1)], {
			height: 100,
			gap: 0
		})
		expect(ids(pages)).toEqual([["a"], ["chart[0-100]"], ["chart[100-160]"], ["b"]])
		expect(pages.map((page) => page.screen)).toEqual([false, true, true, false])
	})

	it("sets a note on the page that cites it and counts its height", () => {
		const cited = text("b", 4, 20, { refs: [{ id: "fn-1", at: 80 }] })
		const pages = paginate([text("a", 2), cited], {
			height: 100,
			gap: 0,
			noteHeights: new Map([["fn-1", 30]]),
			notesChrome: 10
		})
		// The citation is on b's last line. With its note b no longer fits whole after
		// a, so b is split, and the note goes with the part that carries the citation.
		expect(ids(pages)).toEqual([["a", "b[0-40]"], ["b[40-80]"]])
		expect(pages.map((page) => page.notes)).toEqual([[], ["fn-1"]])
	})

	it("puts a note with the part of a split block that cites it", () => {
		const cited = text("b", 8, 20, { refs: [{ id: "fn-1", at: 140 }] })
		const pages = paginate([cited], { height: 100, gap: 0, noteHeights: new Map([["fn-1", 20]]) })
		expect(ids(pages)).toEqual([["b[0-100]"], ["b[100-160]"]])
		expect(pages.map((page) => page.notes)).toEqual([[], ["fn-1"]])
	})

	it("leaves a lead's page to the lead when not one line fits under it", () => {
		const capped: Measured = { id: "a", height: 120, cuts: [60] }
		const pages = paginate([capped], { height: (page) => (page === 0 ? 40 : 100), gap: 0 })
		expect(ids(pages)).toEqual([[], ["a[0-60]"], ["a[60-120]"]])
	})

	it("allows a shorter first page for a lead", () => {
		const pages = paginate([text("a", 10)], { height: (page) => (page === 0 ? 60 : 100), gap: 0 })
		expect(ids(pages)).toEqual([["a[0-60]"], ["a[60-160]"], ["a[160-200]"]])
	})

	it("moves an atomic block whole, and splits it only when it is taller than a page", () => {
		const card = text("card", 4, 20, { atomic: true })
		expect(ids(paginate([text("a", 3), card], { height: 100, gap: 0 }))).toEqual([["a"], ["card"]])
		const tall = text("tall", 8, 20, { atomic: true })
		expect(ids(paginate([text("a", 3), tall], { height: 100, gap: 0 }))).toEqual([
			["a"],
			["tall[0-100]"],
			["tall[100-160]"]
		])
	})

	it("shows a block taller than a page without a cut on a page of its own", () => {
		const figure: Measured = { id: "f", height: 140, cuts: [] }
		const pages = paginate([text("a", 1), figure, text("b", 1)], { height: 100, gap: 0 })
		expect(ids(pages)).toEqual([["a"], ["f"], ["b"]])
	})
})

describe("screens", () => {
	it("pairs pages, and gives a screen page the whole spread", () => {
		const pages = paginate(
			[
				text("a", 5),
				text("b", 5),
				text("c", 5),
				text("chart", 2, 20, { screen: true }),
				text("d", 1)
			],
			{ height: 100, gap: 0 }
		)
		const grouped = screens(pages, 2)
		expect(grouped.map((screen) => [screen.wide, screen.pages.length])).toEqual([
			[false, 2],
			[false, 1],
			[true, 1],
			[false, 1]
		])
	})

	it("is one page per screen on a phone", () => {
		const pages = paginate([text("a", 5), text("b", 5)], { height: 100, gap: 0 })
		expect(screens(pages, 1).map((screen) => [screen.wide, screen.pages.length])).toEqual([
			[false, 1],
			[false, 1]
		])
	})
})

describe("cutsFrom", () => {
	it("cuts in the middle of the leading between lines", () => {
		expect(
			cutsFrom(
				[
					[2, 18],
					[22, 38],
					[42, 58]
				],
				60
			)
		).toEqual([20, 40])
	})

	it("never cuts through something that spans two lines", () => {
		// An image beside the first two lines makes them one run.
		expect(
			cutsFrom(
				[
					[2, 18],
					[22, 38],
					[0, 40],
					[42, 58]
				],
				60
			)
		).toEqual([41])
	})
})
