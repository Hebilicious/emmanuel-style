/**
 * The sections of the site, as the bar, the keyboard and the prompt name them.
 *
 * Each section carries its nameplate, which is what the bar prints in the middle,
 * and its dateline, the line under a newspaper's nameplate that says which part
 * of the paper this is. `key` is the second key of its `g` shortcut, drawn as a
 * superscript beside the link.
 */
export interface Section {
	readonly label: string
	readonly href: string
	readonly key: string
	readonly plate: string
	readonly dateline: string
	readonly title: string
	readonly match: (path: string) => boolean
}

export const SECTIONS: readonly Section[] = [
	{
		label: "home",
		href: "/",
		key: "h",
		plate: "The Emmanuel Style",
		dateline: "front page",
		title: "Emmanuel",
		match: (path) => path === "/"
	},
	{
		label: "library",
		href: "/library",
		key: "l",
		plate: "Library",
		dateline: "the work",
		title: "Library · Emmanuel",
		match: (path) => path.startsWith("/library")
	},
	{
		label: "blog",
		href: "/blog",
		key: "b",
		plate: "The Blog",
		dateline: "dispatches",
		title: "Blog · Emmanuel",
		match: (path) => path.startsWith("/blog")
	},
	{
		label: "experience",
		href: "/experience",
		key: "e",
		plate: "Experience",
		dateline: "the ledger",
		title: "Experience · Emmanuel",
		match: (path) => path.startsWith("/experience")
	},
	{
		label: "skills",
		href: "/skills",
		key: "s",
		plate: "Skills",
		dateline: "for hire",
		title: "Skills · Emmanuel",
		match: (path) => path.startsWith("/skills")
	}
]

export const sectionOf = (path: string): Section =>
	SECTIONS.find((section) => section.match(path.replace(/\/+$/, "") || "/")) ??
	(SECTIONS[0] as Section)
