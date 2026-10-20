<script setup lang="ts">
/**
 * A project's cover: a plate drawn for it, the way a paper illustrates a story it
 * has no photograph for.
 *
 * Each motif says what the project is at a glance: poll lines for the forecaster,
 * a market's candles for Agris, one catalog fanned out to its surfaces for
 * AcidCat, a timeline of merged pull requests for outside work. The drawing is
 * seeded by the project's name, so a cover is the same on every visit and no two
 * covers of one motif are alike. It is ink and accent on the paper's sunk tone,
 * over a halftone screen, so it sits in either theme like the rest of the page.
 */
import { computed } from "vue"

const props = withDefaults(
	defineProps<{
		motif: string
		seed: string
		/** The months of merged pull requests, for the `timeline` motif. */
		activity?: readonly string[]
		/** The big figure the timeline carries, its count of merged pull requests. */
		count?: number | null
		/** Width over height. */
		ratio?: number
	}>(),
	{ activity: () => [], count: null, ratio: 16 / 7 }
)

const W = 320
const H = computed(() => Math.round(W / props.ratio))

/** A small seeded generator (mulberry32), so a cover draws the same every time. */
const random = computed(() => {
	let state = 2166136261
	for (const char of props.seed)
		state = Math.imul(state ^ char.charCodeAt(0), 16777619)
	return () => {
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
})

const id = computed(() => `cover-${props.seed.replace(/[^a-z0-9]/gi, "")}`)

/**
 * How a mark is drawn: `ink`, `accent` and `faint` strokes, `fill` and `accent-fill`
 * washes, or a colour of its own (the palette's swatches).
 */
type Kind = "ink" | "accent" | "faint" | "fill" | "accent-fill" | (string & {})
type Path = { d: string; kind?: Kind; width?: number; dash?: string }
type Box = { x: number; y: number; w: number; h: number; kind?: Kind }
type Label = {
	x: number
	y: number
	text: string
	size?: number
	kind?: "ink" | "accent" | "faint"
	anchor?: "start" | "middle" | "end"
	display?: boolean
}

interface Drawing {
	paths: Path[]
	boxes: Box[]
	labels: Label[]
	dots?: { x: number; y: number; r: number; kind?: "ink" | "accent" }[]
}

const smooth = (points: [number, number][]): string =>
	points
		.map(([x, y], index) => {
			if (index === 0) return `M${x.toFixed(1)} ${y.toFixed(1)}`
			const [px, py] = points[index - 1] as [number, number]
			const mid = (px + x) / 2
			return `C${mid.toFixed(1)} ${py.toFixed(1)} ${mid.toFixed(1)} ${y.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`
		})
		.join(" ")

const drawing = computed<Drawing>(() => {
	const rnd = random.value
	const h = H.value
	const paths: Path[] = []
	const boxes: Box[] = []
	const labels: Label[] = []
	const dots: NonNullable<Drawing["dots"]> = []
	const left = 22
	const right = W - 22
	const top = 22
	const bottom = h - 22

	switch (props.motif) {
		case "polls": {
			// Four candidates' lines across a campaign, the leader in the accent with its band.
			const steps = 14
			const xs = Array.from(
				{ length: steps },
				(_, i) => left + ((right - left - 30) * i) / (steps - 1)
			)
			const levels = [0.3, 0.42, 0.62, 0.78]
			levels.forEach((level, line) => {
				let y = top + (bottom - top) * level
				const points = xs.map((x) => {
					y += (rnd() - 0.5) * 9
					y = Math.max(top + 4, Math.min(bottom - 4, y))
					return [x, y] as [number, number]
				})
				if (line === 0) {
					const upper = points.map(([x, y]) => [x, y - 7] as [number, number])
					const lower = points
						.map(([x, y]) => [x, y + 7] as [number, number])
						.reverse()
					paths.push({
						d: `${smooth(upper)} L${smooth(lower).slice(1)} Z`,
						kind: "accent-fill"
					})
				}
				paths.push({
					d: smooth(points),
					kind: line === 0 ? "accent" : line === 1 ? "ink" : "faint",
					width: line === 0 ? 2.2 : 1.4
				})
				const last = points.at(-1) as [number, number]
				dots.push({
					x: last[0],
					y: last[1],
					r: line === 0 ? 3 : 2,
					kind: line === 0 ? "accent" : "ink"
				})
			})
			const today = right - 30
			paths.push({
				d: `M${today} ${top - 6} V${bottom + 4}`,
				kind: "faint",
				dash: "2 3"
			})
			labels.push({
				x: today + 6,
				y: top + 2,
				text: "2027",
				size: 10,
				kind: "accent"
			})
			for (let i = 0; i < 5; i += 1)
				paths.push({
					d: `M${left} ${top + ((bottom - top) * i) / 4} H${today}`,
					kind: "faint",
					width: 0.4
				})
			break
		}
		case "market": {
			// Candles over a session, with the average drawn through them.
			const count = 22
			const step = (right - left) / count
			let price = top + (bottom - top) * 0.55
			const average: [number, number][] = []
			for (let i = 0; i < count; i += 1) {
				const open = price
				price = Math.max(
					top + 10,
					Math.min(bottom - 10, price + (rnd() - 0.52) * 22)
				)
				const close = price
				const high = Math.min(open, close) - rnd() * 10
				const low = Math.max(open, close) + rnd() * 10
				const x = left + i * step + step / 2
				const up = close < open
				paths.push({
					d: `M${x.toFixed(1)} ${high.toFixed(1)} V${low.toFixed(1)}`,
					kind: up ? "accent" : "ink",
					width: 1
				})
				boxes.push({
					x: x - step * 0.3,
					y: Math.min(open, close),
					w: step * 0.6,
					h: Math.max(1.5, Math.abs(close - open)),
					kind: up ? "accent-fill" : "fill"
				})
				average.push([x, (open + close) / 2 + 6])
			}
			paths.push({ d: smooth(average), kind: "faint", width: 1.2 })
			break
		}
		case "catalog":
		case "surfaces": {
			// One catalog, fanned out to the surfaces it is served on.
			const surfaces =
				props.motif === "catalog"
					? ["CLI", "MCP", "WEBMCP", "HTTP", "CODE"]
					: ["VAPOR", "WEBMCP", "CLI", "MCP", "RPC"]
			const cx = left + 46
			const cy = h / 2
			boxes.push({ x: cx - 34, y: cy - 22, w: 68, h: 44, kind: "accent" })
			labels.push({
				x: cx,
				y: cy + 4,
				text: props.motif === "catalog" ? "catalog" : "capability",
				size: 10,
				kind: "accent",
				anchor: "middle"
			})
			surfaces.forEach((name, i) => {
				const y = top + ((bottom - top) * i) / (surfaces.length - 1)
				const x = right - 62
				paths.push({
					d: `M${cx + 34} ${cy} C${cx + 90} ${cy} ${x - 60} ${y} ${x} ${y}`,
					kind: i === 1 ? "accent" : "ink",
					width: i === 1 ? 1.6 : 0.9
				})
				boxes.push({
					x,
					y: y - 8,
					w: 62,
					h: 16,
					kind: i === 1 ? "accent-fill" : "fill"
				})
				labels.push({
					x: x + 31,
					y: y + 3.5,
					text: name,
					size: 8,
					kind: i === 1 ? "accent" : "ink",
					anchor: "middle"
				})
			})
			break
		}
		case "paper": {
			// A front page in miniature: the nameplate, a rule, and columns of text.
			labels.push({
				x: W / 2,
				y: top + 14,
				text: "THE EMMANUEL STYLE",
				size: 15,
				kind: "ink",
				anchor: "middle",
				display: true
			})
			paths.push({
				d: `M${left} ${top + 22} H${right} M${left} ${top + 25} H${right}`,
				kind: "ink",
				width: 0.8
			})
			const columns = 4
			const gap = 10
			const width = (right - left - gap * (columns - 1)) / columns
			for (let c = 0; c < columns; c += 1) {
				const x = left + c * (width + gap)
				let y = top + 36
				if (c === 0) {
					boxes.push({ x, y, w: width * 2 + gap, h: 30, kind: "accent-fill" })
				}
				if (c < 2) y += 36
				while (y < bottom) {
					const length = width * (0.6 + rnd() * 0.4)
					paths.push({
						d: `M${x} ${y} H${x + length}`,
						kind: "faint",
						width: 1.4
					})
					y += 6
				}
			}
			break
		}
		case "signal": {
			// Waves on a line: a device answering, a stream of messages.
			for (let i = 0; i < 4; i += 1) {
				const amplitude = 6 + rnd() * 16
				const frequency = 1.5 + rnd() * 3
				const offset = top + ((bottom - top) * (i + 0.5)) / 4
				const points: [number, number][] = []
				for (let x = left; x <= right; x += 6)
					points.push([
						x,
						offset +
							Math.sin((x / (right - left)) * Math.PI * frequency + i) *
								amplitude *
								(i === 1 ? 1 : 0.6)
					])
				paths.push({
					d: smooth(points),
					kind: i === 1 ? "accent" : "faint",
					width: i === 1 ? 2 : 1
				})
			}
			break
		}
		case "box": {
			// A drop box: an open crate with a report falling in.
			const cx = W / 2
			const base = bottom - 6
			paths.push({
				d: `M${cx - 70} ${base - 40} L${cx} ${base - 18} L${cx + 70} ${base - 40} L${cx} ${base - 62} Z`,
				kind: "ink",
				width: 1
			})
			paths.push({
				d: `M${cx - 70} ${base - 40} V${base - 6} L${cx} ${base + 16} V${base - 18} M${cx} ${base + 16} L${cx + 70} ${base - 6} V${base - 40}`,
				kind: "ink",
				width: 1
			})
			boxes.push({ x: cx - 18, y: top - 4, w: 36, h: 46, kind: "accent-fill" })
			for (let i = 0; i < 5; i += 1)
				paths.push({
					d: `M${cx - 12} ${top + 4 + i * 7} H${cx + 12 - rnd() * 10}`,
					kind: "accent",
					width: 1
				})
			paths.push({
				d: `M${cx} ${top + 48} V${base - 46} M${cx - 6} ${base - 52} L${cx} ${base - 46} L${cx + 6} ${base - 52}`,
				kind: "accent",
				width: 1.4
			})
			break
		}
		case "lock": {
			// Rings around a keyhole: a session, a key, an identity.
			const cx = W / 2 + (rnd() - 0.5) * 60
			const cy = h / 2
			for (let r = 14; r < W; r += 12)
				paths.push({
					d: `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0`,
					kind: r < 40 ? "accent" : "faint",
					width: r < 40 ? 1.4 : 0.6
				})
			paths.push({
				d: `M${cx} ${cy - 9} a5 5 0 1 1 0.1 0 Z M${cx - 3} ${cy - 5} L${cx - 5} ${cy + 10} H${cx + 5} L${cx + 3} ${cy - 5}`,
				kind: "accent-fill"
			})
			break
		}
		case "form": {
			// A form: labels, fields, and the button that posts it.
			const rows = 3
			for (let i = 0; i < rows; i += 1) {
				const y = top + i * 30
				paths.push({
					d: `M${left} ${y} H${left + 30 + rnd() * 40}`,
					kind: "faint",
					width: 1.6
				})
				boxes.push({
					x: left,
					y: y + 6,
					w: right - left - 90,
					h: 16,
					kind: "ink"
				})
				if (i === 1)
					paths.push({
						d: `M${left + 8} ${y + 14} H${left + 80}`,
						kind: "accent",
						width: 1.6
					})
			}
			boxes.push({
				x: right - 70,
				y: bottom - 22,
				w: 70,
				h: 22,
				kind: "accent-fill"
			})
			labels.push({
				x: right - 35,
				y: bottom - 7.5,
				text: "POST",
				size: 9,
				kind: "accent",
				anchor: "middle"
			})
			break
		}
		case "block": {
			// Code, with one block marked out: the server code beside the page.
			let y = top
			let indent = 0
			for (let i = 0; y < bottom; i += 1) {
				const length = 40 + rnd() * 140
				const marked = i >= 3 && i <= 6
				paths.push({
					d: `M${left + 24 + indent * 14} ${y} H${left + 24 + indent * 14 + length}`,
					kind: marked ? "accent" : "faint",
					width: 2
				})
				labels.push({
					x: left + 12,
					y: y + 3,
					text: String(i + 1),
					size: 7,
					kind: "faint",
					anchor: "end"
				})
				indent = Math.max(
					0,
					Math.min(3, indent + (rnd() < 0.4 ? 1 : rnd() < 0.5 ? -1 : 0))
				)
				y += 11
			}
			boxes.push({
				x: left + 18,
				y: top + 3 * 11 - 6,
				w: right - left - 18,
				h: 4 * 11 + 1,
				kind: "accent"
			})
			labels.push({
				x: right - 4,
				y: top + 3 * 11 - 9,
				text: "<server>",
				size: 8,
				kind: "accent",
				anchor: "end"
			})
			break
		}
		case "cache": {
			// Queries stacked in a cache, the fresh one on top.
			for (let i = 0; i < 4; i += 1) {
				const x = left + 30 + i * 18
				const y = top + i * 12
				boxes.push({
					x,
					y,
					w: right - left - 120,
					h: bottom - top - 40,
					kind: i === 3 ? "accent" : "faint"
				})
			}
			for (let i = 0; i < 4; i += 1)
				paths.push({
					d: `M${left + 92} ${top + 52 + i * 10} H${left + 92 + 60 + rnd() * 80}`,
					kind: "accent",
					width: 1.6
				})
			break
		}
		case "snapshot": {
			// Frames of one page, kept as the reader moves on and restored on the way back.
			for (let i = 0; i < 3; i += 1) {
				const x = left + i * 54
				const y = top + i * 8
				const w = 150
				const hh = bottom - top - 18
				boxes.push({ x, y, w, h: hh, kind: i === 2 ? "accent" : "faint" })
				if (i === 2) {
					for (let j = 0; j < 3; j += 1)
						boxes.push({
							x: x + 12,
							y: y + 14 + j * 18,
							w: w - 24,
							h: 10,
							kind: j === 1 ? "accent-fill" : "fill"
						})
				}
			}
			break
		}
		case "switch": {
			// One value in, the first branch that matches lit.
			const cx = left + 40
			const cy = h / 2
			const lit = Math.floor(rnd() * 3)
			dots.push({ x: cx, y: cy, r: 4, kind: "accent" })
			for (let i = 0; i < 4; i += 1) {
				const y = top + ((bottom - top) * i) / 3
				paths.push({
					d: `M${cx} ${cy} C${cx + 80} ${cy} ${cx + 80} ${y} ${cx + 160} ${y} H${right}`,
					kind: i === lit ? "accent" : "faint",
					width: i === lit ? 2 : 1,
					...(i === 3 ? { dash: "3 3" } : {})
				})
				dots.push({ x: right, y, r: 2.5, kind: i === lit ? "accent" : "ink" })
			}
			break
		}
		case "pages":
		case "template": {
			// Pages stacked, or the scaffold of a project: boxes waiting for their contents.
			const count = props.motif === "pages" ? 3 : 6
			if (props.motif === "pages") {
				for (let i = 0; i < count; i += 1) {
					const x = left + 40 + i * 30
					const y = top + (2 - i) * 6
					boxes.push({
						x,
						y,
						w: 120,
						h: bottom - top - 6,
						kind: i === 2 ? "accent" : "faint"
					})
					if (i === 2)
						for (let j = 0; j < 7; j += 1)
							paths.push({
								d: `M${x + 12} ${y + 16 + j * 9} H${x + 12 + 50 + rnd() * 46}`,
								kind: j === 0 ? "accent" : "faint",
								width: j === 0 ? 3 : 1.4
							})
				}
			} else {
				const columns = 3
				const gap = 10
				const width = (right - left - gap * (columns - 1)) / columns
				const height = (bottom - top - gap) / 2
				for (let i = 0; i < count; i += 1) {
					const x = left + (i % columns) * (width + gap)
					const y = top + Math.floor(i / columns) * (height + gap)
					boxes.push({
						x,
						y,
						w: width,
						h: height,
						kind: i === 0 ? "accent" : "faint"
					})
					labels.push({
						x: x + 8,
						y: y + 14,
						text: ["module", "docs", "test", "ci", "release", "lint"][i] ?? "",
						size: 8,
						kind: i === 0 ? "accent" : "faint"
					})
				}
			}
			break
		}
		case "palette": {
			// Ramps of a palette in OKLCH: lightness down each strip, hue across them.
			const hues = 7
			const steps = 6
			const width = (right - left) / hues
			const height = (bottom - top) / steps
			for (let i = 0; i < hues; i += 1) {
				for (let j = 0; j < steps; j += 1) {
					boxes.push({
						x: left + i * width + 1,
						y: top + j * height + 1,
						w: width - 2,
						h: height - 2,
						kind: `oklch(${0.92 - j * 0.12} ${0.05 + j * 0.025} ${(200 + i * 40) % 360})`
					})
				}
			}
			break
		}
		case "erase": {
			// A history of commits, one trailer rubbed out of it.
			const y = h / 2
			paths.push({ d: `M${left} ${y} H${right}`, kind: "ink", width: 1.4 })
			const commits = 9
			const erased = 2 + Math.floor(rnd() * 5)
			for (let i = 0; i < commits; i += 1) {
				const x = left + 10 + ((right - left - 20) * i) / (commits - 1)
				dots.push({ x, y, r: 5, kind: i === erased ? "accent" : "ink" })
				if (i === erased) {
					paths.push({
						d: `M${x - 22} ${y - 30} H${x + 40} M${x - 22} ${y - 22} H${x + 26}`,
						kind: "faint",
						width: 2
					})
					paths.push({
						d: `M${x - 26} ${y - 36} L${x + 44} ${y - 16}`,
						kind: "accent",
						width: 2.4
					})
				}
			}
			paths.push({
				d: `M${left + 60} ${y} C${left + 90} ${y} ${left + 100} ${y + 30} ${left + 130} ${y + 30} H${right - 60} C${right - 30} ${y + 30} ${right - 30} ${y} ${right - 10} ${y}`,
				kind: "faint",
				width: 1
			})
			break
		}
		case "sync": {
			// The file in the repository and the platform, kept in step.
			boxes.push({
				x: left + 10,
				y: top + 14,
				w: 80,
				h: bottom - top - 28,
				kind: "accent"
			})
			boxes.push({
				x: right - 90,
				y: top + 14,
				w: 80,
				h: bottom - top - 28,
				kind: "faint"
			})
			labels.push({
				x: left + 50,
				y: top + 30,
				text: ".jsonc",
				size: 9,
				kind: "accent",
				anchor: "middle"
			})
			labels.push({
				x: right - 50,
				y: top + 30,
				text: "workers",
				size: 9,
				kind: "ink",
				anchor: "middle"
			})
			const cy = h / 2
			paths.push({
				d: `M${left + 100} ${cy - 8} H${right - 104} M${right - 110} ${cy - 13} L${right - 104} ${cy - 8} L${right - 110} ${cy - 3}`,
				kind: "accent",
				width: 1.4
			})
			paths.push({
				d: `M${right - 100} ${cy + 8} H${left + 104} M${left + 110} ${cy + 3} L${left + 104} ${cy + 8} L${left + 110} ${cy + 13}`,
				kind: "ink",
				width: 1,
				dash: "3 3"
			})
			break
		}
		case "plug": {
			// Plugins in a row of sockets, one lit.
			const count = 5
			const width = (right - left) / count
			for (let i = 0; i < count; i += 1) {
				const x = left + i * width + width / 2
				const lit = i === 2
				paths.push({
					d: `M${x - 18} ${top + 40} h36 v28 a18 18 0 0 1 -36 0 Z M${x - 9} ${top + 40} v-16 M${x + 9} ${top + 40} v-16`,
					kind: lit ? "accent" : "faint",
					width: lit ? 1.6 : 1
				})
				paths.push({
					d: `M${x} ${top + 86} V${bottom}`,
					kind: lit ? "accent" : "faint",
					width: lit ? 1.6 : 1
				})
			}
			break
		}
		case "tree": {
			// A selection: a root and the fields under it, the ones asked for lit.
			const levels = [1, 3, 6]
			const positions: [number, number][][] = levels.map((count, level) =>
				Array.from(
					{ length: count },
					(_, i) =>
						[
							left + 30 + level * ((right - left - 60) / 2),
							top + ((bottom - top) * (i + 0.5)) / count
						] as [number, number]
				)
			)
			positions.forEach((row, level) => {
				row.forEach(([x, y], i) => {
					const lit = rnd() < 0.55 || level === 0
					if (level > 0) {
						const parent = positions[level - 1]?.[
							Math.floor((i * (positions[level - 1]?.length ?? 1)) / row.length)
						] ?? [x, y]
						paths.push({
							d: `M${parent[0]} ${parent[1]} C${(parent[0] + x) / 2} ${parent[1]} ${(parent[0] + x) / 2} ${y} ${x} ${y}`,
							kind: lit ? "accent" : "faint",
							width: lit ? 1.4 : 0.8
						})
					}
					dots.push({
						x,
						y,
						r: level === 0 ? 5 : 3.5,
						kind: lit ? "accent" : "ink"
					})
				})
			})
			break
		}
		case "hook": {
			// An issue, labelled, and the bot's reply under it.
			boxes.push({
				x: left,
				y: top,
				w: right - left - 40,
				h: 34,
				kind: "faint"
			})
			paths.push({
				d: `M${left + 12} ${top + 13} H${left + 150} M${left + 12} ${top + 23} H${left + 100}`,
				kind: "faint",
				width: 1.6
			})
			boxes.push({
				x: right - 140,
				y: top + 10,
				w: 82,
				h: 14,
				kind: "accent-fill"
			})
			labels.push({
				x: right - 99,
				y: top + 20,
				text: "needs repro",
				size: 8,
				kind: "accent",
				anchor: "middle"
			})
			boxes.push({
				x: left + 40,
				y: top + 48,
				w: right - left - 40,
				h: bottom - top - 48,
				kind: "accent"
			})
			for (let i = 0; i < 3; i += 1)
				paths.push({
					d: `M${left + 52} ${top + 62 + i * 10} H${left + 52 + 80 + rnd() * 120}`,
					kind: "accent",
					width: 1.4
				})
			break
		}
		case "list": {
			// Tasks, some done.
			for (let i = 0; i * 18 + top < bottom - 6; i += 1) {
				const y = top + i * 18
				const done = rnd() < 0.5
				boxes.push({
					x: left,
					y,
					w: 11,
					h: 11,
					kind: done ? "accent-fill" : "faint"
				})
				if (done)
					paths.push({
						d: `M${left + 2.5} ${y + 6} L${left + 5} ${y + 8.5} L${left + 9} ${y + 3}`,
						kind: "accent",
						width: 1.4
					})
				paths.push({
					d: `M${left + 22} ${y + 6} H${left + 22 + 60 + rnd() * 160}`,
					kind: done ? "faint" : "ink",
					width: 1.6
				})
			}
			break
		}
		case "timeline": {
			// One bar per month with a merged pull request, from the first to the last.
			const months = [...props.activity]
			if (months.length === 0) break
			const index = (month: string) => {
				const [year, m] = month.split("-").map(Number)
				return (year ?? 0) * 12 + ((m ?? 1) - 1)
			}
			const first = index(months[0] as string)
			const last = Math.max(first + 5, index(months.at(-1) as string))
			const span = last - first + 1
			const counts = new Map<number, number>()
			for (const month of months)
				counts.set(index(month), (counts.get(index(month)) ?? 0) + 1)
			const peak = Math.max(...counts.values())
			const baseline = bottom
			const height = (bottom - top) * 0.55
			const width = (right - left) / span
			for (let i = 0; i < span; i += 1) {
				const count = counts.get(first + i) ?? 0
				const x = left + i * width
				if (count === 0) {
					paths.push({
						d: `M${x + width / 2} ${baseline - 2} V${baseline}`,
						kind: "faint",
						width: 1
					})
					continue
				}
				const barHeight = Math.max(3, (count / peak) * height)
				boxes.push({
					x: x + Math.min(1, width * 0.15),
					y: baseline - barHeight,
					w: Math.max(1.5, width - Math.min(2, width * 0.3)),
					h: barHeight,
					kind: "accent-fill"
				})
			}
			paths.push({
				d: `M${left} ${baseline + 0.5} H${right}`,
				kind: "ink",
				width: 0.8
			})
			const startYear = Math.floor(first / 12)
			const endYear = Math.floor(last / 12)
			labels.push({
				x: left,
				y: baseline + 12,
				text: String(startYear),
				size: 8,
				kind: "faint"
			})
			if (endYear !== startYear)
				labels.push({
					x: right,
					y: baseline + 12,
					text: String(endYear),
					size: 8,
					kind: "faint",
					anchor: "end"
				})
			if (props.count !== null) {
				labels.push({
					x: left,
					y: top + 26,
					text: String(props.count),
					size: 34,
					kind: "ink",
					display: true
				})
				labels.push({
					x: left + 4 + String(props.count).length * 22,
					y: top + 24,
					text: props.count === 1 ? "merged" : "merged",
					size: 9,
					kind: "accent"
				})
			}
			break
		}
		default: {
			labels.push({
				x: W / 2,
				y: h / 2 + 18,
				text: props.seed.slice(0, 1).toUpperCase(),
				size: 56,
				kind: "accent",
				anchor: "middle",
				display: true
			})
		}
	}
	return { paths, boxes, labels, dots }
})

const stroke = (kind: string | undefined) =>
	kind === "accent"
		? "var(--accent)"
		: kind === "faint"
			? "var(--faint)"
			: kind === "ink"
				? "var(--muted)"
				: "none"

const fill = (kind: string | undefined) =>
	kind === "fill"
		? "color-mix(in oklab, var(--muted) 55%, transparent)"
		: kind === "accent-fill"
			? "color-mix(in oklab, var(--accent) 38%, transparent)"
			: kind?.startsWith("oklch")
				? kind
				: "none"

const boxStroke = (kind: string | undefined) =>
	kind === "accent"
		? "var(--accent)"
		: kind === "faint"
			? "var(--faint)"
			: kind === "ink"
				? "var(--muted)"
				: "none"
</script>

<template>
  <svg
    class="Cover"
    :viewBox="`0 0 ${W} ${H}`"
    preserveAspectRatio="xMidYMid slice"
    aria-hidden="true"
    focusable="false">
    <defs>
      <!-- A halftone screen, the texture of a printed plate. -->
      <pattern
        :id="`${id}-screen`"
        width="5"
        height="5"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)">
        <circle cx="2.5" cy="2.5" r="0.7" class="Screen"></circle>
      </pattern>
    </defs>
    <rect :width="W" :height="H" class="Ground"></rect>
    <rect :width="W" :height="H" :fill="`url(#${id}-screen)`"></rect>
    <rect
      v-for="(box, index) of drawing.boxes"
      :key="`b${index}`"
      :x="box.x"
      :y="box.y"
      :width="box.w"
      :height="box.h"
      :fill="fill(box.kind)"
      :stroke="boxStroke(box.kind)"
      stroke-width="1">
    </rect>
    <path
      v-for="(path, index) of drawing.paths"
      :key="`p${index}`"
      :d="path.d"
      :fill='path.kind === "accent-fill" || path.kind === "fill" ? fill(path.kind) : "none"'
      :stroke='path.kind === "accent-fill" || path.kind === "fill" ? "none" : stroke(path.kind)'
      :stroke-width="path.width ?? 1"
      :stroke-dasharray="path.dash"
      stroke-linecap="round"
      stroke-linejoin="round">
    </path>
    <circle
      v-for="(dot, index) of drawing.dots"
      :key="`d${index}`"
      :cx="dot.x"
      :cy="dot.y"
      :r="dot.r"
      :fill='dot.kind === "accent" ? "var(--accent)" : "var(--muted)"'>
    </circle>
    <text
      v-for="(label, index) of drawing.labels"
      :key="`l${index}`"
      :x="label.x"
      :y="label.y"
      :font-size="label.size ?? 10"
      :text-anchor='label.anchor ?? "start"'
      :class="{ Display: label.display }"
      :fill='label.kind === "accent"
      ? "var(--accent)"
      : label.kind === "faint"
      	? "var(--faint)"
      	: "var(--ink)"'>
      {{ label.text }}
    </text>
  </svg>
</template>

<style scoped>
.Cover {
  display: block;
  width: 100%;
  height: 100%;
  font-family: var(--font-monaspace);
  letter-spacing: 0.08em;
}

.Ground {
  fill: var(--sunk);
}

.Screen {
  fill: color-mix(in oklab, var(--ink) 9%, transparent);
}

/* Nabla, in the ink palette the nameplate uses, as `.display` sets it. */
.Display {
  font-family: var(--font-nabla);
  font-palette: var(--nabla-ink);
  font-weight: 700;
  letter-spacing: 0;
}
</style>
