/**
 * The site's data, adapted to `@emmanuel/schema`.
 *
 * The Library is curated in `data/portfolio.ts` and the experience entries in
 * `data/experience.ts`. The schemas are not identical, which is what the adapters
 * are for:
 *
 *   - a portfolio entry leaves out what it does not have (a homepage, an end
 *     year, links); `ProjectShape` carries each as `null` or an empty list, and
 *     says whether the entry is a project of its own or outside work;
 *   - the experience `Role` has no id; `RoleShape` exposes one, derived from the
 *     company and the start month, which is stable across builds;
 *   - the education entry spells its qualification `degree`; `SchoolShape` spells
 *     it `qualification`.
 */

import type { ProjectShape, RoleShape, SchoolShape, ShelfShape, SkillShape } from "@emmanuel/schema"
import { education, roles } from "./data/experience.ts"
import { type PortfolioEntry, portfolio, shelves as shelfList } from "./data/portfolio.ts"
import { skills as skillList } from "./data/skills.ts"

const project = (entry: PortfolioEntry): ProjectShape => ({
	name: entry.name,
	title: entry.title,
	tagline: entry.tagline,
	body: [...entry.body],
	points: [...entry.points],
	kind: entry.shelf === "upstream" ? "upstream" : entry.shelf === "work" ? "work" : "project",
	shelf: entry.shelf,
	language: entry.language,
	stack: [...entry.stack],
	url: entry.url,
	homepage: entry.homepage ?? null,
	archived: entry.archived ?? false,
	repo: entry.repo ?? null,
	started: entry.started,
	ended: entry.ended ?? null,
	featured: entry.featured ?? null,
	contributions: entry.activity === undefined ? null : entry.activity.length,
	activity: [...(entry.activity ?? [])].sort(),
	links: (entry.links ?? []).map((link) => ({
		label: link.label,
		url: link.url,
		date: link.date ?? null
	})),
	cover: entry.cover
})

/** The shelves of the Library, in the order they are declared, each with its projects. */
export const shelves: ShelfShape[] = shelfList.map((shelf) => ({
	slug: shelf.slug,
	label: shelf.label,
	blurb: shelf.blurb,
	projects: portfolio.filter((entry) => entry.shelf === shelf.slug).map(project)
}))

/** Every project, shelf by shelf. */
export const projects: ProjectShape[] = shelves.flatMap((shelf) => shelf.projects)

const slugify = (value: string) =>
	value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")

export const experiences: RoleShape[] = roles.map((role) => ({
	id: `${slugify(role.company)}-${role.start}`,
	title: role.title,
	company: role.company,
	location: role.location,
	start: role.start,
	end: role.end,
	summary: role.summary,
	highlights: role.highlights,
	stack: role.stack
}))

export const schools: SchoolShape[] = education.map((entry) => ({
	id: `${slugify(entry.school)}-${entry.start}`,
	qualification: entry.degree,
	school: entry.school,
	location: entry.location,
	start: entry.start,
	end: entry.end,
	summary: entry.summary
}))

/** The skills, in the order the Skills section reads them. */
export const skills: SkillShape[] = skillList.map((skill) => ({
	name: skill.name,
	title: skill.title,
	description: skill.description,
	whenToUse: [...skill.whenToUse],
	steps: [...skill.steps],
	tools: [...skill.tools],
	evidence: [...skill.evidence],
	example: skill.example
}))
