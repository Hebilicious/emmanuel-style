/**
 * GitHub star cache, one Durable Object for the whole site.
 *
 * Every visitor of the Library wants the same handful of star counts, and the
 * unauthenticated GitHub API allows 60 requests an hour per IP. A single object
 * holds one shared cache with a TTL, so a burst of traffic turns into one
 * upstream call per repository per TTL window instead of one per visit.
 *
 * The token is optional. Without it GitHub's anonymous limit applies; with it
 * the limit is 5000 an hour, which is plenty for a personal site.
 */
import { DurableObject } from "cloudflare:workers"

interface CacheEntry {
	stars: number
	fetchedAt: number
}

interface CacheShape {
	entries: Record<string, CacheEntry>
}

export interface Env {
	STAR_CACHE: DurableObjectNamespace
	/** Optional, raises the GitHub rate limit. */
	GITHUB_TOKEN?: string
}

/** One repository's star count, as returned to the site. */
export interface StarCount {
	repo: string
	stars: number
	cached: boolean
}

/** How long a star count is trusted before it is refreshed. */
const TTL_MS = 1000 * 60 * 30
/** Repositories per upstream round, to stay a good citizen. */
const CONCURRENCY = 5

export class StarCache extends DurableObject<Env> {
	async #read(): Promise<CacheShape> {
		const stored = await this.ctx.storage.get<CacheShape>("cache")
		return stored ?? { entries: {} }
	}

	async #fetchStars(repo: string): Promise<number | null> {
		const headers: Record<string, string> = {
			accept: "application/vnd.github+json",
			"user-agent": "emmanuel.style"
		}
		if (this.env.GITHUB_TOKEN) {
			headers.authorization = `Bearer ${this.env.GITHUB_TOKEN}`
		}

		try {
			const response = await fetch(`https://api.github.com/repos/Hebilicious/${repo}`, {
				headers
			})
			if (!response.ok) return null
			const data = (await response.json()) as { stargazers_count?: number }
			return typeof data.stargazers_count === "number" ? data.stargazers_count : null
		} catch {
			return null
		}
	}

	/**
	 * Return star counts for the requested repositories, refreshing anything
	 * older than the TTL. Stale values are served when a refresh fails, so a
	 * GitHub outage degrades to slightly old numbers instead of nothing.
	 */
	async get(repos: string[]): Promise<StarCount[]> {
		const cache = await this.#read()
		const now = Date.now()

		const stale = repos.filter((repo) => {
			const entry = cache.entries[repo]
			return !entry || now - entry.fetchedAt > TTL_MS
		})

		for (let index = 0; index < stale.length; index += CONCURRENCY) {
			const batch = stale.slice(index, index + CONCURRENCY)
			const results = await Promise.all(
				batch.map(async (repo) => ({ repo, stars: await this.#fetchStars(repo) }))
			)
			for (const result of results) {
				if (result.stars === null) continue
				cache.entries[result.repo] = { stars: result.stars, fetchedAt: now }
			}
		}

		if (stale.length > 0) {
			await this.ctx.storage.put("cache", cache)
		}

		return repos
			.filter((repo) => cache.entries[repo])
			.map((repo) => ({
				repo,
				stars: cache.entries[repo].stars,
				cached: true
			}))
	}
}
