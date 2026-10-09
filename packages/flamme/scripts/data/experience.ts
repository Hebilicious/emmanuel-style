/**
 * Experience entries.
 *
 * Placeholder content: every role, description and date below is lorem ipsum,
 * standing in until the real entries come off LinkedIn. The shape is what the
 * page and the graph consume, so swapping in real data means replacing the
 * values and nothing else.
 */
export interface Role {
	company: string
	title: string
	/** ISO month, `YYYY-MM`. */
	start: string
	/** ISO month, or null when the role is current. */
	end: string | null
	location: string
	summary: string
	highlights: string[]
	stack: string[]
}

export const roles: Role[] = [
	{
		company: "Lorem Ipsum",
		title: "Senior Software Engineer",
		start: "2022-03",
		end: null,
		location: "Earth",
		summary:
			"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
		highlights: [
			"Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.",
			"Duis aute irure dolor in reprehenderit in voluptate velit esse cillum.",
			"Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia."
		],
		stack: ["TypeScript", "Vue", "Cloudflare Workers"]
	},
	{
		company: "Dolor Sit",
		title: "Full Stack Engineer",
		start: "2020-01",
		end: "2022-02",
		location: "Earth",
		summary:
			"Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam.",
		highlights: [
			"Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit.",
			"Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet."
		],
		stack: ["Node.js", "GraphQL", "PostgreSQL"]
	},
	{
		company: "Amet Consectetur",
		title: "Frontend Engineer",
		start: "2018-06",
		end: "2019-12",
		location: "Earth",
		summary:
			"At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque.",
		highlights: [
			"Et harum quidem rerum facilis est et expedita distinctio.",
			"Temporibus autem quibusdam et aut officiis debitis aut rerum."
		],
		stack: ["JavaScript", "React", "Webpack"]
	},
	{
		company: "Adipiscing Elit",
		title: "Software Engineer",
		start: "2016-09",
		end: "2018-05",
		location: "Earth",
		summary:
			"Nam libero tempore, cum soluta nobis est eligendi optio cumque nihil impedit quo minus id quod maxime placeat.",
		highlights: [
			"Omnis voluptas assumenda est, omnis dolor repellendus.",
			"Itaque earum rerum hic tenetur a sapiente delectus."
		],
		stack: ["PHP", "MySQL", "jQuery"]
	}
]

export const education = [
	{
		school: "Supinfo",
		degree: "Master of Engineering, Computer Science",
		start: "2011-09",
		end: "2016-06",
		location: "Earth",
		summary:
			"Quis autem vel eum iure reprehenderit qui in ea voluptate velit esse quam nihil molestiae consequatur."
	}
]

/**
 * The year and month of a `YYYY-MM` string.
 *
 * Split here rather than destructured at the call: `noUncheckedIndexedAccess` types an
 * indexed element as possibly absent, so a destructure of `split("-")` gives
 * `number | undefined` for both halves and every use of them has to be guarded. One
 * parse with a fallback keeps the arithmetic below plain.
 */
const yearMonth = (value: string): { year: number; month: number } => {
	const [year, month] = value.split("-").map(Number)
	return { year: year ?? 0, month: month ?? 1 }
}

/** Months between two `YYYY-MM` strings, inclusive of the start month. */
export const monthsBetween = (start: string, end: string | null) => {
	const from = yearMonth(start)
	const to = yearMonth(end ?? currentMonth())
	return (to.year - from.year) * 12 + (to.month - from.month) + 1
}

export const currentMonth = () => {
	const now = new Date()
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

/** Whole years and leftover months, for labels like `4 yrs 2 mos`. */
export const formatDuration = (months: number) => {
	const years = Math.floor(months / 12)
	const rest = months % 12
	const parts: string[] = []
	if (years > 0) parts.push(`${years} yr${years === 1 ? "" : "s"}`)
	if (rest > 0) parts.push(`${rest} mo${rest === 1 ? "" : "s"}`)
	return parts.join(" ") || "1 mo"
}

/** `2022-03` as `Mar 2022`. */
export const formatMonth = (value: string | null) => {
	if (!value) return "Present"
	const { year, month } = yearMonth(value)
	return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(
		new Date(year, month - 1, 1)
	)
}
