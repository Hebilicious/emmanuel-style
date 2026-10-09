/**
 * Client for the backend worker.
 *
 * The site is static and works offline, so every call here is best effort: if
 * the network is down, or the worker is not deployed yet, the UI falls back to
 * a local answer instead of breaking the page.
 *
 * The base URL is read from `PUBLIC_API_BASE` at build time. When it is empty
 * the client resolves against the site origin, which is what the workers
 * deployment uses.
 */
const base = (import.meta.env.PUBLIC_API_BASE ?? "").replace(/\/$/, "")

const url = (path: string) => `${base}${path}`

export interface FavouriteCount {
	slug: string
	count: number
}

export interface StarCount {
	repo: string
	stars: number
	cached: boolean
}

const request = async <T>(path: string, init?: RequestInit): Promise<T | null> => {
	try {
		const response = await fetch(url(path), {
			...init,
			headers: { "content-type": "application/json", ...init?.headers }
		})
		if (!response.ok) return null
		return (await response.json()) as T
	} catch {
		return null
	}
}

/** Read the favourite count for one article. */
export const getFavourites = (slug: string) =>
	request<FavouriteCount>(`/api/favourites/${encodeURIComponent(slug)}`)

/** Add one favourite to an article and return the new total. */
export const addFavourite = (slug: string) =>
	request<FavouriteCount>(`/api/favourites/${encodeURIComponent(slug)}`, { method: "POST" })

/** Read star counts for the given repositories in one round trip. */
export const getStars = (repos: string[]) =>
	request<{ repos: StarCount[] }>(`/api/stars?repos=${encodeURIComponent(repos.join(","))}`)
