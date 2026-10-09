/**
 * Open source projects shown in the Library.
 *
 * Generated from the GitHub API, then curated by hand: forks, experiments and
 * throwaway reproductions are left out, and every entry keeps the description
 * its repository carries.
 *
 * Shape:
 *   name        repository name, also the last segment of its url
 *   description repository description
 *   language    primary language reported by GitHub
 *   url         repository url
 *   homepage    project site, when the repository declares one
 *   archived    whether the repository is archived
 *   category    which shelf of the Library it sits on
 */
export interface Repository {
	name: string
	description: string
	language: string
	url: string
	homepage?: string
	archived?: boolean
	category: Category
}

export type Category = "modules" | "tooling" | "chain"

export const categories: Record<Category, string> = {
	modules: "Nuxt & Vue modules",
	tooling: "Tooling & templates",
	chain: "Chain & cryptography"
}

export const repositories: Repository[] = [
	{
		name: "form-actions-nuxt",
		description: "Nuxt Module that implements Form Actions",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/form-actions-nuxt",
		homepage: "https://form-actions-nuxt.pages.dev/",
		category: "modules"
	},
	{
		name: "vue-query-nuxt",
		description: "A lightweight, 0 config Nuxt Module for Vue Query.",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/vue-query-nuxt",
		category: "modules"
	},
	{
		name: "server-block-nuxt",
		description: "Use <server> tags in your Nuxt pages components",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/server-block-nuxt",
		category: "modules"
	},
	{
		name: "dom-snapshot-nuxt",
		description: "DOM Snapshot module for Nuxt",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/dom-snapshot-nuxt",
		category: "modules"
	},
	{
		name: "vue-switch-match",
		description: "Switch Match components for Vue and Nuxt.",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/vue-switch-match",
		category: "modules"
	},
	{
		name: "nuxtpress",
		description: "A nuxt module to use markdown files as pages",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/nuxtpress",
		category: "modules"
	},
	{
		name: "authjs-nuxt",
		description: "AuthJS edge-compatible authentication Nuxt module.",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/authjs-nuxt",
		homepage: "https://authjs-nuxt.pages.dev/",
		archived: true,
		category: "modules"
	},
	{
		name: "cssforge",
		description: "Generate CSS variables from design tokens.",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/cssforge",
		homepage: "https://jsr.io/@hebilicious/cssforge",
		category: "tooling"
	},
	{
		name: "nuxt-module-template",
		description: "A template for Nuxt Modules with Pnpm and Bun",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/nuxt-module-template",
		category: "tooling"
	},
	{
		name: "reproduire",
		description: "Github Action that comments on incomplete issues.",
		language: "JavaScript",
		url: "https://github.com/Hebilicious/reproduire",
		category: "tooling"
	},
	{
		name: "rollup-plugin-web-worker",
		description: "Rollup plugin that loads web worker in a dedicated chunk.",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/rollup-plugin-web-worker",
		category: "tooling"
	},
	{
		name: "serverless-esbuild-template",
		description:
			"This is a template repository to get you started really quickly with the serverless framework and typescript.",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/serverless-esbuild-template",
		category: "tooling"
	},
	{
		name: "ungraphql-parse-info",
		description:
			"An ESM, JSR published, edge compatible GraphQL info parser based on graphql-parse-resolve-info",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/ungraphql-parse-info",
		homepage: "https://jsr.io/@hebilicious/ungraphql-parse-info",
		category: "tooling"
	},
	{
		name: "graphql-crawler",
		description: "Crawl URLs and generate Sitemaps",
		language: "TypeScript",
		url: "https://github.com/Hebilicious/graphql-crawler",
		category: "tooling"
	},
	{
		name: "mnemonic-to-private-key",
		description: "Convert a mnemonic phrase to a private key",
		language: "JavaScript",
		url: "https://github.com/Hebilicious/mnemonic-to-private-key",
		category: "chain"
	},
	{
		name: "plutus-guide",
		description: "A guide for Plutus",
		language: "Dockerfile",
		url: "https://github.com/Hebilicious/plutus-guide",
		category: "chain"
	},
	{
		name: "nats-ml",
		description: "OCaml bindings for NATS",
		language: "OCaml",
		url: "https://github.com/Hebilicious/nats-ml",
		category: "chain"
	},
	{
		name: "spacebudz-identity",
		description: "Identity verification for SpaceBudz",
		language: "Haskell",
		url: "https://github.com/Hebilicious/spacebudz-identity",
		category: "chain"
	}
]
