/**
 * Fills the star counts on the Library page.
 *
 * Counts come from the backend worker, which caches them in a Durable Object so
 * the GitHub API is not hit on every visit. A failure leaves the placeholder
 * empty rather than showing a wrong number.
 *
 * With `ClientRouter` the page is swapped rather than reloaded, so this runs on
 * `astro:page-load`, which fires on the first load and after every swap. The
 * container carries a marker so a second call for the same page is a no-op.
 */
import { getStars } from "./api"

const STAR_REPOS = [
	"form-actions-nuxt",
	"vue-query-nuxt",
	"server-block-nuxt",
	"dom-snapshot-nuxt",
	"vue-switch-match",
	"nuxtpress",
	"authjs-nuxt",
	"cssforge",
	"nuxt-module-template",
	"reproduire",
	"rollup-plugin-web-worker",
	"serverless-esbuild-template",
	"ungraphql-parse-info",
	"graphql-crawler",
	"mnemonic-to-private-key",
	"plutus-guide",
	"nats-ml",
	"spacebudz-identity"
]

const LOADED = "starsLoaded"

const format = (stars: number) => (stars >= 1000 ? `${(stars / 1000).toFixed(1)}k` : String(stars))

const paint = (repo: string, stars: number) => {
	const node = document.querySelector(`[data-stars="${repo}"]`)
	if (!node) return
	node.textContent = `★ ${format(stars)}`
}

export const loadStars = async () => {
	const list = document.querySelector<HTMLElement>(".Entries")
	if (!list || list.dataset[LOADED] === "true") return
	list.dataset[LOADED] = "true"

	const result = await getStars(STAR_REPOS)
	if (!result) {
		// Let a later navigation try again rather than caching the failure.
		delete list.dataset[LOADED]
		return
	}

	for (const entry of result.repos) paint(entry.repo, entry.stars)
}

document.addEventListener("astro:page-load", () => {
	void loadStars()
})
