/**
 * Fetch every pull request by Hebilicious merged into somebody else's public
 * repository, and write them to `scripts/data/contributions.ts`.
 *
 * The Library lists outside work pull request by pull request, so the list is
 * data, not prose: it is fetched with the GitHub CLI and committed, and a build
 * never needs the network. Run by hand when there is new work to show:
 *
 *   pnpm --filter @emmanuel/flamme run contributions
 */
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

interface Found {
	readonly repository: { readonly nameWithOwner: string }
	readonly number: number
	readonly title: string
	readonly closedAt: string
}

const here = fileURLToPath(new URL(".", import.meta.url))

const found = JSON.parse(
	execFileSync(
		"gh",
		[
			"search",
			"prs",
			"--author",
			"Hebilicious",
			"--merged",
			"--visibility",
			"public",
			"--limit",
			"1000",
			"--json",
			"repository,number,title,closedAt",
			"--",
			"-user:Hebilicious"
		],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
	)
) as Found[]

const pulls = found
	.map((pull) => ({
		repository: pull.repository.nameWithOwner,
		number: pull.number,
		title: pull.title.replace(/\s+/g, " ").trim(),
		date: pull.closedAt.slice(0, 10)
	}))
	.sort(
		(a, b) =>
			a.repository.toLowerCase().localeCompare(b.repository.toLowerCase()) ||
			a.date.localeCompare(b.date) ||
			a.number - b.number
	)

const today = new Date().toISOString().slice(0, 10)
const lines = pulls.map((pull) => `\t${JSON.stringify(pull)}`)

writeFileSync(
	join(here, "data", "contributions.ts"),
	`/**
 * Every pull request by Hebilicious merged into somebody else's public repository.
 *
 * Written by \`scripts/contributions.ts\` from GitHub's search on ${today}; do not
 * edit by hand. The Library groups these by repository (\`portfolio.ts\`) and lists
 * each one in its entry.
 */
export interface Pull {
	readonly repository: string
	readonly number: number
	readonly title: string
	/** The day it was merged, \`YYYY-MM-DD\`. */
	readonly date: string
}

// dprint-ignore
export const pulls: readonly Pull[] = [
${lines.join(",\n")}
]
`
)

console.log(
	`${pulls.length} merged pull requests in ${new Set(pulls.map((pull) => pull.repository)).size} repositories`
)
