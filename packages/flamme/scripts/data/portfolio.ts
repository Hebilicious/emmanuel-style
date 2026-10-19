/**
 * The Library: the work, shelf by shelf, and the pieces it leads with.
 *
 * Curated by hand from the GitHub account and from the pull requests merged into
 * other people's repositories. Every public repository that is a project in its
 * own right is here; forks, reproductions of bugs, demos and one-off experiments
 * are left out. A repository that is private is left out too, because a visitor
 * could not open it.
 *
 * Shape:
 *   name       the entry's address, `/library/<name>`
 *   title      the name it is known by
 *   tagline    one line: what it is
 *   body       what it does and why, a paragraph each
 *   points     what is worth knowing about it, one line each
 *   shelf      which shelf it sits on
 *   language   the main language
 *   stack      what it is built with
 *   url        the repository, or the list of merged pull requests for outside work
 *   homepage   the project's site, when it has one
 *   archived   whether it is finished with
 *   repo       the repository under Hebilicious, for the star count; none for outside work
 *   started    the year it began
 *   ended      the year it stopped, or none while it is maintained
 *   featured   its place on the Library's front page, or none
 *   links      the pull requests (or pages) worth reading, for outside work
 *   cover      the picture its cover draws (`components/Cover.vue`)
 */
import { merged } from "./contributions.ts"

export interface PortfolioLink {
	readonly label: string
	readonly url: string
	readonly date?: string
}

export interface PortfolioEntry {
	readonly name: string
	readonly title: string
	readonly tagline: string
	readonly body: readonly string[]
	readonly points: readonly string[]
	readonly shelf: Shelf
	readonly language: string
	readonly stack: readonly string[]
	readonly url: string
	readonly homepage?: string
	readonly archived?: boolean
	readonly repo?: string
	readonly started: number
	readonly ended?: number
	readonly featured?: number
	readonly links?: readonly PortfolioLink[]
	/** The months of the merged pull requests, for outside work. */
	readonly activity?: readonly string[]
	readonly cover: string
}

export type Shelf = "projects" | "nuxt" | "tools" | "upstream" | "work"

/** The shelves, in the order the Library reads them, each with the line under its title. */
export const shelves: readonly { slug: Shelf; label: string; blurb: string }[] = [
	{
		slug: "projects",
		label: "Projects",
		blurb:
			"Systems built end to end: a forecaster, a market API, a specification and the stacks on top of it."
	},
	{
		slug: "nuxt",
		label: "Nuxt & Vue",
		blurb: "Modules for Nuxt and components for Vue, several of them listed on nuxt.com."
	},
	{
		slug: "tools",
		label: "Tools",
		blurb: "Design tokens, release hygiene, build plugins, agent skills and a few libraries."
	},
	{
		slug: "upstream",
		label: "Upstream",
		blurb: "Pull requests merged into the frameworks and libraries the work above is built on."
	},
	{
		slug: "work",
		label: "Work",
		blurb: "Public codebases written for clients and employers, read through their pull requests."
	}
]

const GH = "https://github.com/Hebilicious"
const pulls = (repository: string) =>
	`https://github.com/${repository}/pulls?q=is%3Apr+author%3AHebilicious+is%3Amerged`
const pr = (repository: string, number: number, label: string, date: string): PortfolioLink => ({
	label,
	url: `https://github.com/${repository}/pull/${number}`,
	date
})

export const portfolio: readonly PortfolioEntry[] = [
	/* ---------------------------------------------------------------- projects */
	{
		name: "fr2027-forecaster",
		title: "France 2027",
		tagline: "A probabilistic forecast of the 2027 French presidential election that runs itself.",
		body: [
			"The polls are the backbone: a Kalman filter aggregates them by political bloc, and a two-round Monte Carlo turns the aggregate into each candidate's chances of reaching and winning the second round. Other signals move the forecast at weights the owner sets: spikes of news and Wikipedia attention widen a candidate's uncertainty, momentum in attention and in support on X tilts the first round, and prediction markets inform who will be on the ballot.",
			"No person is in the loop. A Cloudflare Worker's cron starts a GitHub Actions pipeline every hour that collects, refits when the polls or the configuration change, commits the data and publishes the site. Grok Bot routines send in new polls, events and measurements; a poll counts only once a second, blind run of the routine agrees on every number."
		],
		points: [
			"Backtested on the 2017 and 2022 elections, with the error settings fitted from replays of 2002 to 2022",
			"33 polls from April to October 2026, 32 checked against the pollster's own notice",
			"Rust for the model, the collectors and the CLI; Vue for the site, in French and thirteen other languages",
			"Replays any date: `fr2027 forecast --as-of 2026-09-01` uses only the polls published by then"
		],
		shelf: "projects",
		language: "Rust",
		stack: ["Rust", "TypeScript", "Vue", "Cloudflare Workers", "GitHub Actions", "moon", "proto"],
		url: `${GH}/fr2027-forecaster`,
		homepage: "https://fr2027.hebilicious.workers.dev/",
		repo: "fr2027-forecaster",
		started: 2026,
		featured: 1,
		cover: "polls"
	},
	{
		name: "acidcat",
		title: "AcidCat",
		tagline:
			"One catalog, every surface: describe what an application can do once, serve it everywhere.",
		body: [
			"AcidCat is a language-neutral specification. An application writes one catalog, a JSON document listing its capabilities with their inputs, outputs and failures, and the targets that may use each one. Bindings turn the catalog into each surface: a command line, an MCP server, WebMCP tools for agents in the page, HTTP endpoints, and typed functions in the application's own language.",
			"The catalog is checked at build time and never read at run time, so the surfaces cannot drift from one another or from the code that implements them."
		],
		points: [
			"Bindings for TypeScript, Python, Go and Rust, with the schema in JSON Schema 2020-12 and Pkl",
			"`aircon.temperature.set` becomes a CLI command, an MCP tool, a WebMCP tool and a POST route from one entry",
			"Published on npm as `@acid-cat/cli`; the specification is a 0.1 draft"
		],
		shelf: "projects",
		language: "TypeScript",
		stack: ["TypeScript", "Python", "Go", "Rust", "Pkl", "JSON Schema", "MCP"],
		url: `${GH}/acidcat`,
		repo: "acidcat",
		started: 2026,
		featured: 2,
		cover: "catalog"
	},
	{
		name: "agris",
		title: "Agris",
		tagline: "The Black Desert Online Central Market as a federated GraphQL API you run yourself.",
		body: [
			"Pearl Abyss's trade servers answer with undocumented positional rows, some of them Huffman-compressed, and know items only by number. Agris gives them a typed GraphQL schema: prices, stock, order books, price history, hot items and the registration queue for every market region, joined with item names in twelve languages and a search by name.",
			"It deploys to your own Cloudflare account with no API key and nobody else's traffic. Each field has its own freshness window at the edge, from seconds for an order book to much longer for an item's name, and many items, regions and histories are batched into one upstream round."
		],
		points: [
			"GraphQL Federation v2 behind Hive Gateway, on Cloudflare Workers",
			'`searchItems(query: "memory frag")` matches part of a name, ignoring case and accents',
			"A public demo API and a documentation site"
		],
		shelf: "projects",
		language: "TypeScript",
		stack: [
			"TypeScript",
			"GraphQL Federation",
			"Hive Gateway",
			"Effect",
			"XState",
			"Cloudflare Workers"
		],
		url: `${GH}/agris`,
		homepage: "https://agris-docs.hebilicious.workers.dev",
		repo: "agris",
		started: 2026,
		featured: 3,
		cover: "market"
	},
	{
		name: "heb-stack",
		title: "heb-stack",
		tagline: "One AcidCat catalog served to a Vue Vapor page, WebMCP, a CLI, MCP and capnweb.",
		body: [
			"A starter for an Effect application on Cloudflare. A capability is written once, as an Effect Schema input, output and failure plus one Effect computation, and its owner runs the lifecycle in an XState machine. AcidCat then serves it to every surface: the page over capnweb, an agent in the page through WebMCP, a terminal, an MCP client, and code through a typed RPC API.",
			"The demo is a prime checker in Rust compiled to WebAssembly, kept as small as the wiring allows, so what is left to read is the wiring."
		],
		points: [
			"Effect 4, XState 6, Vue 3.6 Vapor, Rust to WebAssembly, moon",
			"A live preview with `/mcp` and `/rpc` beside the page",
			'"A fence that makes the shortcut the wrong path"'
		],
		shelf: "projects",
		language: "TypeScript",
		stack: [
			"Effect",
			"XState",
			"Vue Vapor",
			"capnweb",
			"Rust",
			"WebAssembly",
			"Cloudflare Workers"
		],
		url: `${GH}/heb-stack`,
		homepage: "https://heb-stack-preview.hebilicious.workers.dev",
		repo: "heb-stack",
		started: 2026,
		cover: "surfaces"
	},
	{
		name: "emmanuel-style",
		title: "emmanuel.style",
		tagline: "This paper: a terminal folded into a broadsheet, read a spread at a time.",
		body: [
			"The site is built on Flamme, a compiler-first GraphQL client for Vue. Every page is a GraphQL document answered from the bundle, so the paper reads with the network off; the favourites and the star counts come from a Cloudflare Worker and its Durable Objects through the same cache.",
			"Nothing scrolls. A pager measures every block off screen and packs it into pages, and every move through the paper, a page or a section, is a View Transition that turns a leaf."
		],
		points: [
			"Vue, Vite and Vize, with the design tokens generated by CSS Forge",
			"Driven from the keyboard like a pager in a terminal, with a prompt for the rest",
			"Offline after the first visit"
		],
		shelf: "projects",
		language: "TypeScript",
		stack: ["Vue", "Flamme", "GraphQL", "Pothos", "Cloudflare Workers", "View Transitions"],
		url: `${GH}/emmanuel-style`,
		homepage: "https://emmanuel.style",
		repo: "emmanuel-style",
		started: 2020,
		cover: "paper"
	},
	{
		name: "xiaomi-aircon",
		title: "xiaomi-aircon",
		tagline:
			"A Xiaomi air conditioner run from the terminal, from an agent, or from the desktop bar.",
		body: [
			"A CLI for every control the Mi Home app has, and the readings it hides: room and outdoor temperature, energy use, compressor speed and fault codes. The same controls are an MCP server, so an agent can run the air conditioner, and a panel in the Omarchy bar with sliders and toggles.",
			"Control stays on the local network, over miIO on UDP. Xiaomi's cloud is used once, to fetch the device's token."
		],
		points: [
			"Static binaries for Linux x86_64 and macOS on Apple silicon",
			"`aircon mcp` exposes the controls to Claude and other agents"
		],
		shelf: "projects",
		language: "Rust",
		stack: ["Rust", "miIO", "MCP", "Omarchy"],
		url: `${GH}/xiaomi-aircon`,
		repo: "xiaomi-aircon",
		started: 2026,
		cover: "signal"
	},
	{
		name: "bot-drop",
		title: "bot-drop",
		tagline: "A private drop box for the reports bots write, on one Worker and one R2 bucket.",
		body: [
			"Bots upload self-contained HTML reports of up to 25 MB over an API; a person opens a web page to browse and read them. Cloudflare Access guards the whole hostname, and the Worker checks the Access token again before it touches the bucket, so a half-configured deployment fails closed."
		],
		points: ["No database, no build step, no runtime dependencies"],
		shelf: "projects",
		language: "JavaScript",
		stack: ["Cloudflare Workers", "R2", "Cloudflare Access"],
		url: `${GH}/bot-drop`,
		repo: "bot-drop",
		started: 2026,
		cover: "box"
	},

	/* ------------------------------------------------------------- nuxt & vue */
	{
		name: "authjs-nuxt",
		title: "Auth.js for Nuxt",
		tagline: "Edge-compatible authentication for Nuxt, on the Auth.js core.",
		body: [
			"A Nuxt module over the Auth.js core implementation that runs wherever Nuxt does, edge runtimes such as Cloudflare Workers included.",
			"It is finished with now, and its readme points to the modules that took its place."
		],
		points: [
			"The most starred module on the shelf",
			"Listed on nuxt.com/modules",
			"A documentation site and a repository of examples"
		],
		shelf: "nuxt",
		language: "TypeScript",
		stack: ["Nuxt", "Auth.js", "Nitro", "h3"],
		url: `${GH}/authjs-nuxt`,
		homepage: "https://authjs-nuxt.pages.dev/",
		archived: true,
		repo: "authjs-nuxt",
		started: 2023,
		ended: 2025,
		featured: 4,
		cover: "lock"
	},
	{
		name: "form-actions-nuxt",
		title: "Form Actions for Nuxt",
		tagline:
			"Form actions and server loaders for Nuxt: forms that work before the JavaScript does.",
		body: [
			"Form actions send data to the server with native HTML forms, and enhance them progressively once the page is interactive. Server loaders load type-safe data from the server into a page or a component without writing an API route to fetch it from."
		],
		points: ["Listed on nuxt.com/modules", "A documentation site and a repository of examples"],
		shelf: "nuxt",
		language: "TypeScript",
		stack: ["Nuxt", "Nitro", "h3", "Vue"],
		url: `${GH}/form-actions-nuxt`,
		homepage: "https://form-actions-nuxt.pages.dev/",
		repo: "form-actions-nuxt",
		started: 2023,
		featured: 5,
		cover: "form"
	},
	{
		name: "server-block-nuxt",
		title: "Server Block",
		tagline:
			"`<server>` blocks in Nuxt page components: the API handler next to the page that calls it.",
		body: [
			"A Nuxt module that lets a page component carry its own server code in a `<server>` block, compiled into an API handler. A Volar extension, installed with the module, gives the block types and completion in the editor."
		],
		points: ["Experimental, and listed on nuxt.com/modules"],
		shelf: "nuxt",
		language: "TypeScript",
		stack: ["Nuxt", "Vite", "Volar"],
		url: `${GH}/server-block-nuxt`,
		repo: "server-block-nuxt",
		started: 2023,
		cover: "block"
	},
	{
		name: "vue-query-nuxt",
		title: "Vue Query for Nuxt",
		tagline: "TanStack Query in Nuxt with no configuration.",
		body: [
			"A light Nuxt module that installs and configures Vue Query and auto-imports its composables. It needs no configuration, and every option of Vue Query is still there for an application that needs one."
		],
		points: ["Listed on nuxt.com/modules", "Installable with `nuxi module add vue-query`"],
		shelf: "nuxt",
		language: "TypeScript",
		stack: ["Nuxt", "TanStack Query"],
		url: `${GH}/vue-query-nuxt`,
		repo: "vue-query-nuxt",
		started: 2023,
		cover: "cache"
	},
	{
		name: "dom-snapshot-nuxt",
		title: "DOM Snapshot",
		tagline: "Keep what the reader typed when they navigate away and come back.",
		body: [
			"Ephemeral DOM state, the content of a form or the scroll of a sidebar, is lost when a reader follows a link and then presses back. After SvelteKit's snapshots, this module takes a snapshot of that state on the way out and restores it on the way back."
		],
		points: [],
		shelf: "nuxt",
		language: "TypeScript",
		stack: ["Nuxt", "Vue Router"],
		url: `${GH}/dom-snapshot-nuxt`,
		repo: "dom-snapshot-nuxt",
		started: 2023,
		cover: "snapshot"
	},
	{
		name: "vue-switch-match",
		title: "Vue Switch Match",
		tagline: "`<Switch>` and `<Match>` components for Vue and Nuxt, after Solid's.",
		body: [
			"Pattern matching in a template: the first `<Match>` whose condition holds renders, and `<Fallback>` renders when none does. Packaged for Vue and as a Nuxt module."
		],
		points: [],
		shelf: "nuxt",
		language: "TypeScript",
		stack: ["Vue", "Nuxt"],
		url: `${GH}/vue-switch-match`,
		repo: "vue-switch-match",
		started: 2024,
		cover: "switch"
	},
	{
		name: "nuxtpress",
		title: "Nuxtpress",
		tagline: "Markdown files as Nuxt pages.",
		body: [
			"A Nuxt module over `vite-plugin-vue-markdown`, with all its options, that turns markdown files into pages."
		],
		points: [],
		shelf: "nuxt",
		language: "TypeScript",
		stack: ["Nuxt", "Vite", "Markdown"],
		url: `${GH}/nuxtpress`,
		repo: "nuxtpress",
		started: 2023,
		ended: 2025,
		cover: "pages"
	},
	{
		name: "nuxt-module-template",
		title: "Nuxt Module Template",
		tagline: "The template the modules on this shelf started from.",
		body: [
			"A pnpm monorepo for a Nuxt module with its documentation and its tests: the module built with the Nuxt module builder as valid ESM and CommonJS, documentation in VitePress, tests in Vitest, continuous integration, releases and a changelog from one command."
		],
		points: [],
		shelf: "nuxt",
		language: "TypeScript",
		stack: ["Nuxt", "pnpm", "Bun", "VitePress", "Vitest"],
		url: `${GH}/nuxt-module-template`,
		repo: "nuxt-module-template",
		started: 2023,
		cover: "template"
	},

	{
		name: "vueflare",
		title: "Vueflare",
		tagline: "A proof of concept: Vue 3 streamed as HTML from Cloudflare Workers, with islands.",
		body: [
			"An edge-rendered Vue micro-framework: the page streams from a Worker with Vue's web stream renderer, and only the components in `islands/` hydrate in the browser."
		],
		points: [],
		shelf: "nuxt",
		language: "TypeScript",
		stack: ["Vue", "Vite", "Cloudflare Workers"],
		url: `${GH}/vueflare`,
		repo: "vueflare",
		started: 2022,
		ended: 2022,
		cover: "signal"
	},

	/* ------------------------------------------------------------------ tools */
	{
		name: "cssforge",
		title: "CSS Forge",
		tagline: "Design tokens to CSS custom properties at build time, with nothing at run time.",
		body: [
			"The tokens are one serialisable schema: palettes, gradients and themes converted to OKLCH, fluid typography and spacing in the manner of Utopia, durations and easing curves checked against motion guidelines. CSS Forge writes them out as plain CSS, TypeScript or JSON, so it fits any framework or none.",
			"Every colour, size and gap on this site is a CSS Forge token."
		],
		points: ["Fluid type and space scales", "Colours in OKLCH", "A documentation site"],
		shelf: "tools",
		language: "TypeScript",
		stack: ["TypeScript", "CSS", "OKLCH"],
		url: `${GH}/cssforge`,
		homepage: "https://cssforge.hebilicious.workers.dev/",
		repo: "cssforge",
		started: 2025,
		featured: 6,
		cover: "palette"
	},
	{
		name: "gommage",
		title: "Gommage",
		tagline: "Authorship policy for git history: keep AI co-authors out of it, in CI and in hooks.",
		body: [
			"A CLI and a GitHub Action that check commits against a policy in `.gommage.yml`: AI co-author trailers, blocked patterns and domains, the number of authors. It runs where the work already happens, in commit hooks, in CI and in pull request checks, and it can clean up a history that already has them."
		],
		points: ["Published as `@gommage/cli`"],
		shelf: "tools",
		language: "TypeScript",
		stack: ["TypeScript", "GitHub Actions"],
		url: `${GH}/gommage`,
		repo: "gommage",
		started: 2026,
		cover: "erase"
	},
	{
		name: "wrangler-builds",
		title: "wrangler-builds",
		tagline: "Cloudflare Workers Builds triggers kept in sync with a file in the repository.",
		body: [
			"Each Worker's build triggers are written in a checked-in `workers-build.jsonc`, and the tool syncs them to Cloudflare or shows what Cloudflare has. It never creates or deletes a trigger during a sync: a trigger missing on Cloudflare fails the run, so drift stays visible."
		],
		points: ["Published as `@hebilicious/wrangler-builds`"],
		shelf: "tools",
		language: "TypeScript",
		stack: ["TypeScript", "Cloudflare API"],
		url: `${GH}/wrangler-builds`,
		repo: "wrangler-builds",
		started: 2026,
		cover: "sync"
	},
	{
		name: "proto-plugins",
		title: "proto plugins",
		tagline: "Plugins for the proto toolchain manager: OCaml, Nushell and hk.",
		body: [
			"A moon monorepo of plugins for proto. Tools that ship prebuilt releases use proto's TOML plugin format; OCaml, which needs a real install, is a Rust plugin compiled to WebAssembly. The plugins are in proto's own registry."
		],
		points: ["OCaml as a Rust WASM plugin", "Nushell and hk as TOML plugins"],
		shelf: "tools",
		language: "Rust",
		stack: ["Rust", "WebAssembly", "proto", "moon"],
		url: `${GH}/proto-plugins`,
		repo: "proto-plugins",
		started: 2026,
		cover: "plug"
	},
	{
		name: "nats-ml",
		title: "NATS for OCaml",
		tagline: "A lean NATS client for OCaml, built on Async.",
		body: [
			"A small protocol core with its codecs and an Async runtime on top: publishing with headers, subscriptions, request and reply, keepalive and reconnection with backoff. Released to opam as `nats-client` and `nats-client-async`."
		],
		points: ["Published on opam"],
		shelf: "tools",
		language: "OCaml",
		stack: ["OCaml", "Async", "NATS", "dune"],
		url: `${GH}/nats-ml`,
		repo: "nats-ml",
		started: 2026,
		cover: "signal"
	},
	{
		name: "ungraphql-parse-info",
		title: "ungraphql-parse-info",
		tagline: "An edge-compatible, ESM GraphQL resolve-info parser.",
		body: [
			"A port of Benjie Gillam's `graphql-parse-resolve-info` that runs on the edge: it parses a resolver's info into the tree of fields being asked for, so a resolver can look ahead and fetch only what the query needs."
		],
		points: ["Published on JSR"],
		shelf: "tools",
		language: "TypeScript",
		stack: ["TypeScript", "GraphQL"],
		url: `${GH}/ungraphql-parse-info`,
		homepage: "https://jsr.io/@hebilicious/ungraphql-parse-info",
		repo: "ungraphql-parse-info",
		started: 2024,
		cover: "tree"
	},
	{
		name: "reproduire",
		title: "Reproduire",
		tagline: "A GitHub Action that asks incomplete issues for a reproduction.",
		body: [
			"When an issue is labelled as needing a reproduction, the action comments with a message the repository writes in markdown. With a stale action beside it, issues that never get one close themselves. Nuxt runs it on its own issue tracker."
		],
		points: [],
		shelf: "tools",
		language: "JavaScript",
		stack: ["GitHub Actions"],
		url: `${GH}/reproduire`,
		repo: "reproduire",
		started: 2023,
		cover: "hook"
	},
	{
		name: "ataski",
		title: "Ataski",
		tagline:
			"An agent skill for project work as files: tasks, dependencies, worktrees, sub-agents.",
		body: [
			"Tasks are markdown files with front matter in `todo`, `in-progress` and `done`, with dependencies declared as `blockedBy`. The skill is opinionated: red-green test-driven development, a git worktree and a sub-agent per task by default."
		],
		points: ["Installable with `npx skills add Hebilicious/ataski`"],
		shelf: "tools",
		language: "Markdown",
		stack: ["Agent skills", "git worktrees"],
		url: `${GH}/ataski`,
		repo: "ataski",
		started: 2026,
		cover: "list"
	},
	{
		name: "skills",
		title: "Skills",
		tagline: "A curated collection of agent skills, vendored and pinned.",
		body: [
			"Favourite agent skills gathered in one repository, each installable on its own. The upstream ones are tracked with vendir and pinned in a lock file, so an update is a reviewed diff."
		],
		points: [],
		shelf: "tools",
		language: "Markdown",
		stack: ["Agent skills", "vendir"],
		url: `${GH}/skills`,
		repo: "skills",
		started: 2026,
		cover: "list"
	},
	{
		name: "serverless-esbuild-template",
		title: "Serverless esbuild",
		tagline: "A template for the Serverless framework in TypeScript, bundled with esbuild.",
		body: [
			"A slightly opinionated starting point for AWS Lambda behind API Gateway, with esbuild doing the bundling, tests, and one command to deploy."
		],
		points: [],
		shelf: "tools",
		language: "TypeScript",
		stack: ["Serverless", "esbuild", "AWS Lambda"],
		url: `${GH}/serverless-esbuild-template`,
		repo: "serverless-esbuild-template",
		started: 2020,
		ended: 2023,
		cover: "template"
	},
	{
		name: "gatsby-remark-component",
		title: "gatsby-remark-component",
		tagline: "Custom components in Gatsby markdown.",
		body: [
			"A gatsby-transformer-remark plugin that lets custom components sit in markdown, by giving them a div for a parent. Archived since MDX made it unnecessary."
		],
		points: [],
		shelf: "tools",
		language: "JavaScript",
		stack: ["Gatsby", "remark"],
		url: `${GH}/gatsby-remark-component`,
		archived: true,
		repo: "gatsby-remark-component",
		started: 2018,
		ended: 2020,
		cover: "block"
	},
	{
		name: "mnemonic-to-private-key",
		title: "mnemonic-to-private-key",
		tagline: "A seed phrase to a private key and an address, from `npx`.",
		body: [
			"A small package that generates a seed phrase, or converts one, into a master private key, a public address and a keystore."
		],
		points: [],
		shelf: "tools",
		language: "JavaScript",
		stack: ["Node.js", "Ethereum"],
		url: `${GH}/mnemonic-to-private-key`,
		repo: "mnemonic-to-private-key",
		started: 2021,
		ended: 2023,
		cover: "lock"
	},

	{
		name: "graphql-crawler",
		title: "GraphQL crawler",
		tagline: "A crawler for one domain, driven and watched over GraphQL, that builds sitemaps.",
		body: [
			"Start a crawl with a mutation, limit its speed so it never takes the site down, and follow it live through a subscription: the page being crawled and the count so far. The pages run in parallel, and the URLs come back by query to build a sitemap from."
		],
		points: [],
		shelf: "tools",
		language: "TypeScript",
		stack: ["TypeScript", "GraphQL", "Subscriptions"],
		url: `${GH}/graphql-crawler`,
		repo: "graphql-crawler",
		started: 2020,
		ended: 2020,
		cover: "tree"
	},
	{
		name: "spacebudz-identity",
		title: "SpaceBudz Identity",
		tagline: "A nickname and an identity for a SpaceBudz NFT, on Cardano.",
		body: [
			"A library to give a SpaceBud an identity, written on chain as identity tokens with Lucid, and to read it back."
		],
		points: ["Published on npm as `@spacebudz/spacebudz-identity`"],
		shelf: "tools",
		language: "TypeScript",
		stack: ["Cardano", "Lucid", "Plutus"],
		url: `${GH}/spacebudz-identity`,
		repo: "spacebudz-identity",
		started: 2022,
		ended: 2022,
		cover: "lock"
	},
	{
		name: "plutus-guide",
		title: "Plutus guide",
		tagline: "Notes and links for writing Plutus smart contracts on Cardano.",
		body: [
			"A working guide to the Plutus toolchain: setting up the environment, the official and developer documentation, and the IOG repositories worth knowing."
		],
		points: [],
		shelf: "tools",
		language: "Haskell",
		stack: ["Plutus", "Cardano", "Haskell", "Docker"],
		url: `${GH}/plutus-guide`,
		repo: "plutus-guide",
		started: 2022,
		ended: 2022,
		cover: "pages"
	},

	/* --------------------------------------------------------------- upstream */
	{
		name: "nitro",
		title: "Nitro",
		tagline:
			"The server engine under Nuxt: deploy presets, prerendering, cookies and runtime config.",
		body: [
			"Nineteen pull requests from May to October 2023, mostly where Nitro meets the platforms it deploys to: the static Cloudflare Pages preset and its detection, export conditions for workers, binary bodies and cookies on AWS and Netlify Lambda, cookies split correctly, retries and redirects in the prerenderer, and the documentation and tests for runtime config and environment variables."
		],
		points: [],
		shelf: "upstream",
		language: "TypeScript",
		stack: ["Nitro", "Cloudflare", "AWS Lambda", "Netlify"],
		url: pulls("nitrojs/nitro"),
		homepage: "https://nitro.build",
		started: 2023,
		ended: 2023,
		links: [
			pr("nitrojs/nitro", 1534, "Prerender: support retry and retryDelay", "2023-10"),
			pr("nitrojs/nitro", 1683, "AWS and Netlify Lambda: binary body v2 and cookies v1", "2023-09"),
			pr("nitrojs/nitro", 1659, "Cloudflare Pages: detect the static preset", "2023-08"),
			pr("nitrojs/nitro", 1401, "Support exportConditions, with defaults for workers", "2023-07"),
			pr("nitrojs/nitro", 1452, "Split cookie headers", "2023-07"),
			pr("nitrojs/nitro", 1448, "Prerender: skip redirects", "2023-07"),
			pr("nitrojs/nitro", 1310, "Add the cloudflare-pages-static preset", "2023-06"),
			pr("nitrojs/nitro", 1550, "Document runtime config and environment variables", "2023-08")
		],
		activity: merged.nitro,
		cover: "timeline"
	},
	{
		name: "nuxt",
		title: "Nuxt",
		tagline:
			"The framework itself: a kit helper, the reproduction bot, documentation, and the modules list.",
		body: [
			"`addTypeTemplate` in Nuxt Kit, for modules to register type templates; less reliance on `event.node`; the bot that asks issues for a reproduction; and a run of documentation, from the experimental features to styling. In the modules list, the entries for the modules on the Nuxt shelf."
		],
		points: [],
		shelf: "upstream",
		language: "TypeScript",
		stack: ["Nuxt", "Nuxt Kit"],
		url: pulls("nuxt/nuxt"),
		homepage: "https://nuxt.com",
		started: 2023,
		ended: 2024,
		links: [
			pr("nuxt/nuxt", 21331, "Kit: addTypeTemplate, with auto-registration", "2023-06"),
			pr("nuxt/nuxt", 22539, "Reduce the usage of event.node", "2023-08"),
			pr("nuxt/nuxt", 22495, "Add the issue reproduction bot", "2023-08"),
			pr("nuxt/nuxt", 21617, "Document the experimental features", "2023-06"),
			pr("nuxt/nuxt", 21525, "Document styling", "2023-06"),
			pr("nuxt/nuxt", 21228, "Tell $fetch from the fetch composables", "2023-05"),
			pr("nuxt/modules", 668, "List authjs-nuxt on nuxt.com", "2023-06"),
			pr("nuxt/modules", 703, "List server-block-nuxt on nuxt.com", "2023-07")
		],
		activity: merged.nuxt,
		cover: "timeline"
	},
	{
		name: "h3",
		title: "h3",
		tagline: "The HTTP framework under Nitro: form data, headers and cookies on web responses.",
		body: [
			"Seven pull requests in July 2023: `readFormData`, `event.method` and `event.headers`, utilities to remove and clear response headers, `set-cookie` values split and appended correctly on web responses, and the readme split into sections with the missing helpers documented."
		],
		points: [],
		shelf: "upstream",
		language: "TypeScript",
		stack: ["h3"],
		url: pulls("h3js/h3"),
		homepage: "https://h3.dev",
		started: 2023,
		ended: 2023,
		links: [
			pr("h3js/h3", 421, "Add readFormData", "2023-07"),
			pr("h3js/h3", 429, "Add event.method and event.headers", "2023-07"),
			pr("h3js/h3", 427, "Add removeResponseHeader and clearResponseHeaders", "2023-07"),
			pr("h3js/h3", 453, "Append set-cookie headers in web responses", "2023-07"),
			pr("h3js/h3", 445, "Split set-cookie values in web responses", "2023-07")
		],
		activity: merged.h3,
		cover: "timeline"
	},
	{
		name: "unjs",
		title: "UnJS",
		tagline: "unstorage, db0, ofetch and unenv: batching, libSQL, retries and headers.",
		body: [
			"Experimental operation batching and a fix for R2's metadata in unstorage, libSQL support in db0, `retryDelay` in ofetch, and numeric headers preserved in unenv."
		],
		points: [],
		shelf: "upstream",
		language: "TypeScript",
		stack: ["unstorage", "db0", "ofetch", "unenv"],
		url: "https://github.com/search?q=org%3Aunjs+author%3AHebilicious+is%3Apr+is%3Amerged&type=pullrequests",
		homepage: "https://unjs.io",
		started: 2023,
		ended: 2023,
		links: [
			pr("unjs/unstorage", 240, "unstorage: experimental operation batching", "2023-07"),
			pr("unjs/db0", 25, "db0: add libSQL support", "2023-07"),
			pr("unjs/ofetch", 262, "ofetch: support retryDelay", "2023-08"),
			pr("unjs/unstorage", 272, "unstorage: R2 binding for getMeta", "2023-07"),
			pr("unjs/unenv", 119, "unenv: keep numeric header types in setHeader", "2023-08")
		],
		activity: merged.unjs,
		cover: "timeline"
	},
	{
		name: "proto",
		title: "proto",
		tagline: "The toolchain manager: the OCaml and Nushell plugins in its registry.",
		body: [
			"The plugins on the Tools shelf, entered in proto's registry so that `proto install ocaml` works out of the box, and their locators kept current as they moved to the TOML format."
		],
		points: [],
		shelf: "upstream",
		language: "Rust",
		stack: ["proto", "moon"],
		url: pulls("moonrepo/proto"),
		homepage: "https://moonrepo.dev/proto",
		started: 2026,
		links: [
			pr("moonrepo/proto", 976, "Add the OCaml plugin to the registry", "2026-04"),
			pr("moonrepo/proto", 1013, "Add the Nushell plugin to the registry", "2026-05"),
			pr("moonrepo/proto", 1142, "Move the hk and Nushell locators to TOML plugins", "2026-10")
		],
		activity: merged.proto,
		cover: "timeline"
	},
	{
		name: "lucia",
		title: "Lucia",
		tagline: "The authentication library: an unstorage adapter, then expiry for it.",
		body: [
			"An adapter that stores Lucia's sessions in any unstorage driver, and time-to-live support for it."
		],
		points: [],
		shelf: "upstream",
		language: "TypeScript",
		stack: ["Lucia", "unstorage"],
		url: pulls("lucia-auth/lucia"),
		started: 2023,
		ended: 2023,
		links: [
			pr("lucia-auth/lucia", 662, "Add the unstorage adapter", "2023-07"),
			pr("lucia-auth/lucia", 970, "unstorage: add TTL support", "2023-09")
		],
		activity: merged.lucia,
		cover: "timeline"
	},
	{
		name: "patches",
		title: "Patches",
		tagline: "Single fixes and features across the ecosystem, from Vike and Houdini to Vize.",
		body: [
			"Where a tool in use needed one change: a config helper in Vike, `using` declarations in Houdini, streaming in the Vercel AI SDK's Nuxt example, export conditions in Postgres.js, the cache directory in Vize's Vite plugin, a fix in VueUse, releases of the NATS client on opam, and, in 2017, Rogue profiles and APL tweaks for SimulationCraft."
		],
		points: [],
		shelf: "upstream",
		language: "TypeScript",
		stack: ["Vike", "Houdini", "Vercel AI", "Postgres.js", "Vize", "VueUse", "SimulationCraft"],
		url: "https://github.com/search?q=author%3AHebilicious+is%3Apr+is%3Amerged+-user%3AHebilicious&type=pullrequests",
		started: 2015,
		links: [
			pr("ubugeeei-prod/vize", 8618, "Vize: find optimised Vue under Vite's cacheDir", "2026-10"),
			pr("vikejs/vike", 1157, "Vike: add defineVikeConfig", "2023-10"),
			pr("HoudiniGraphql/houdini", 1286, "Houdini: support the using keyword", "2024-03"),
			pr("vercel/ai", 295, "Vercel AI: streaming in the Nuxt example", "2023-08"),
			pr("porsager/postgres", 819, "Postgres.js: update the export conditions", "2024-04"),
			pr("vueuse/vueuse", 1541, "VueUse: update useElementBounding on mount", "2022-05"),
			pr("ocaml/opam-repository", 29816, "opam: release nats-client 0.0.10", "2026-04"),
			pr("simulationcraft/simc", 3471, "SimulationCraft: Rogue APL tweaks", "2017-01")
		],
		activity: merged.patches,
		cover: "timeline"
	},

	/* ------------------------------------------------------------------- work */
	{
		name: "lumina",
		title: "Lumina DEX",
		tagline:
			"A decentralised exchange on Mina: its SDK, its CDN of compiled contracts, its signers.",
		body: [
			"Seventy-six pull requests from the first commit of the monorepo onwards. The SDK and its publication to npm; a CDN, then a versioning system, for the compiled zero-knowledge contracts; the pool and token services; the wallet and transaction state machines in XState; contracts compiled once and proved one after another; and the signer service, deployed on Cloudflare containers and then rolled out with NixOS to each network.",
			"Along the way, the monorepo moved to moon, and the documentation gained an `llms.txt`."
		],
		points: [],
		shelf: "work",
		language: "TypeScript",
		stack: ["TypeScript", "o1js", "Mina", "XState", "React", "Cloudflare", "NixOS", "moon"],
		url: pulls("Lumina-DEX/lumina"),
		homepage: "https://luminadex.com",
		started: 2024,
		ended: 2026,
		links: [
			pr("Lumina-DEX/lumina", 1, "Prepare the monorepo", "2024-11"),
			pr("Lumina-DEX/lumina", 49, "A versioning system for the contract CDN", "2025-03"),
			pr("Lumina-DEX/lumina", 71, "Pools, the token service and the CDN", "2025-05"),
			pr("Lumina-DEX/lumina", 90, "Create and deploy the signer service", "2025-07"),
			pr("Lumina-DEX/lumina", 133, "Idiomatic XState and React", "2025-10"),
			pr("Lumina-DEX/lumina", 137, "Prove sequentially, compile once", "2025-10"),
			pr("Lumina-DEX/lumina", 152, "The SDK on mainnet", "2025-12"),
			pr("Lumina-DEX/lumina", 181, "A signer server per environment, and SDK routing", "2026-03")
		],
		activity: merged.lumina,
		cover: "timeline"
	},
	{
		name: "zeko",
		title: "Zeko",
		tagline:
			"A zero-knowledge rollup on Mina: its explorer, its event stream, a zkVerify proof of concept.",
		body: [
			"The explorer, from the spikes that settled its design (bridge correlation between the layers, zkApp state and events, cursor pagination, the L1 watcher, data-availability attestations) to the monorepo, the shared NATS event schemas and the SurrealDB read model. In the protocol, the JetStream publish contract the explorer reads from; beside it, a zkVerify pipeline with a Nuxt proof explorer, and a range query for zkApp commands in Mina's archive API."
		],
		points: [],
		shelf: "work",
		language: "TypeScript",
		stack: ["TypeScript", "OCaml", "NATS JetStream", "SurrealDB", "Nuxt", "Mina"],
		url: "https://github.com/search?q=org%3Azeko-labs+author%3AHebilicious+is%3Apr+is%3Amerged&type=pullrequests",
		homepage: "https://zeko.io",
		started: 2025,
		links: [
			pr("zeko-labs/zeko-explorer", 9, "Scaffold the explorer monorepo", "2026-05"),
			pr("zeko-labs/zeko-explorer", 11, "Shared NATS event schemas", "2026-05"),
			pr("zeko-labs/zeko-explorer", 12, "The SurrealDB read model", "2026-05"),
			pr("zeko-labs/zeko-explorer", 1, "Spike: bridge correlation between L1 and L2", "2026-04"),
			pr("zeko-labs/zeko", 407, "Implement the JetStream publish contract", "2026-05"),
			pr("zeko-labs/zk-verify-poc", 1, "zkVerify: the end-to-end pipeline", "2026-02"),
			pr(
				"o1-labs/Archive-Node-API",
				162,
				"Archive API: a range query for zkApp commands",
				"2026-09"
			)
		],
		activity: merged.zeko,
		cover: "timeline"
	}
]
