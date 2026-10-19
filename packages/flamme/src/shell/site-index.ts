/**
 * The site as the prompt and the WebMCP tools see it: the articles with their
 * text, the repositories, the roles.
 *
 * Read through Flamme like every other piece of content, from one document both
 * share, so the store behind it is shared too.
 */
import { computed, type ComputedRef } from "vue"
import { useQuery } from "@flamme/vue"
import { SiteIndex } from "$flamme"
import type { TerminalIndex } from "./terminal.js"

export const useSiteIndex = (): ComputedRef<TerminalIndex> => {
	const { data } = useQuery(SiteIndex)
	return computed<TerminalIndex>(() => ({
		articles: (data.value?.posts ?? []).map((post) => ({
			slug: post.slug,
			title: post.title,
			description: post.description,
			date: post.date,
			tags: post.tags,
			body: (post.blocks ?? []).map((block) => block.text).filter((text) => text !== "")
		})),
		repositories: (data.value?.shelves ?? []).flatMap((shelf) =>
			(shelf.repositories ?? []).map((repo) => ({
				name: repo.name,
				description: repo.description,
				language: repo.language,
				url: repo.url,
				homepage: repo.homepage,
				archived: repo.archived,
				shelf: shelf.label
			}))
		),
		roles: (data.value?.roles ?? []).map((role) => ({
			id: role.id,
			title: role.title,
			company: role.company,
			start: role.start,
			end: role.end,
			summary: role.summary
		}))
	}))
}
