/**
 * The site's data, adapted to `@emmanuel/schema`.
 *
 * The Astro package stays the source of truth for the repositories and the
 * experience entries while the two sites are compared side by side, so these
 * modules are imported rather than copied: a repository added to the Library
 * shows up on both builds, and the day Astro is deleted the import moves with the
 * file instead of silently going stale in a duplicate.
 *
 * The schemas are not identical, which is what the adapters are for:
 *
 *   - Astro's `Repository.category` is a key of a label map; `RepositoryShape`
 *     carries the category as a string, so the key is written out.
 *   - Astro's `Role` has no id; `RoleShape` exposes one, derived from the
 *     company and the start month, which is stable across builds.
 *   - Astro's education entry spells its qualification `degree`; `SchoolShape`
 *     spells it `qualification`.
 */

import type { RepositoryShape, RoleShape, SchoolShape, ShelfShape } from "@emmanuel/schema"
import { education, roles } from "./data/experience.ts"
import { categories, repositories } from "./data/repositories.ts"

/** The shelves of the Library, in the order the categories are declared. */
export const shelves: ShelfShape[] = Object.entries(categories).map(([slug, label]) => ({
	slug,
	label,
	repositories: repositories
		.filter((repository) => repository.category === slug)
		.map(
			(repository): RepositoryShape => ({
				name: repository.name,
				description: repository.description,
				language: repository.language,
				url: repository.url,
				homepage: repository.homepage ?? null,
				archived: repository.archived ?? false,
				category: repository.category,
				// The stars come from the star cache at runtime, never from a build.
				stars: null
			})
		)
}))

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
