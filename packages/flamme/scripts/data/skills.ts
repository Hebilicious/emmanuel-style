/**
 * The Skills section: what Emmanuel is good at, filed the way an agent files a skill.
 *
 * An agent skill is a `SKILL.md`: front matter with a `name`, a `description` that
 * says when to load it and the tools it may use, then the body. The format is the
 * joke; the content is not. People read these to decide whom to hire, so each one
 * is written in the first person and says what he does, what he has done with it,
 * with the numbers, and how he goes about it. Nothing here is a promise: every
 * line of `record` is in the Library, and every skill cites the projects that are
 * its evidence, by name. The content check refuses a name that is not there.
 *
 * Shape:
 *   name         kebab-case, the skill's directory (`skills/<name>/SKILL.md`)
 *   title        the heading
 *   description  front matter: when to load it, one sentence, for the smile
 *   summary      what he does, in two or three sentences
 *   record       what he has done with it: facts, one line each
 *   practice     how he works, one line each
 *   tools        front matter `allowed-tools`: what he works with
 *   evidence     Library project names
 */
export interface Skill {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly summary: string
	readonly record: readonly string[]
	readonly practice: readonly string[]
	readonly tools: readonly string[]
	readonly evidence: readonly string[]
}

export const skills: readonly Skill[] = [
	{
		name: "edge-native-backends",
		title: "Backends on the edge",
		description:
			"Load when the API should answer from the city the request came from and cost nothing while everyone is asleep.",
		summary:
			"I build backends that run on Cloudflare's edge rather than in one region: Workers for the code, Durable Objects for the state that has to be shared, R2 for the files. I decide how fresh each piece of data must be before I write any of it, and cache to that.",
		record: [
			"Agris: a federated GraphQL API on Workers where every field has its own freshness window, from seconds for an order book to days for an item's name",
			"This site: pages answered from the bundle and readable offline, with favourites and star counts in Durable Objects behind the same cache",
			"bot-drop: a private report store on one Worker and one R2 bucket, with no database, that fails closed when half configured",
			"Nineteen pull requests merged into Nitro, most of them where it meets the platforms it deploys to: Cloudflare Pages, AWS and Netlify Lambda"
		],
		practice: [
			"State that has to be shared lives in a Durable Object, not in a database someone has to run",
			"I batch the calls upstream and cache at the edge, field by field",
			"I check the access token again inside the Worker, even when the platform already did"
		],
		tools: ["Cloudflare Workers", "Durable Objects", "R2", "Cloudflare Access", "Nitro", "h3"],
		evidence: ["agris", "emmanuel-style", "bot-drop", "wrangler-builds", "nitro", "h3"]
	},
	{
		name: "nuxt-and-vue-internals",
		title: "Nuxt & Vue, from the inside",
		description:
			"Load when the framework does not do the thing yet and somebody has to open its source.",
		summary:
			"I know Vue and Nuxt from their source, not only from their documentation. When an application needs something the framework does not ship, I write it as a module; when the framework is wrong, I fix the framework.",
		record: [
			"Auth.js for Nuxt: authentication that runs on edge runtimes, listed on nuxt.com and the most starred module I have written",
			"Form Actions for Nuxt: form actions and server loaders, so a form works before the JavaScript does",
			"Server Block: a `<server>` block in a page component, compiled into an API handler, with a Volar extension for its types",
			"In Nuxt itself: `addTypeTemplate` in Nuxt Kit, the bot that asks an issue for a reproduction, and a run of documentation"
		],
		practice: [
			"I read the framework's code before I trust its documentation",
			"Every module ships with a playground, a documentation site and its tests",
			"What belongs upstream goes upstream, with the test that proves it"
		],
		tools: ["Vue", "Nuxt", "Nuxt Kit", "Nitro", "Vite", "Volar", "TanStack Query"],
		evidence: [
			"authjs-nuxt",
			"form-actions-nuxt",
			"server-block-nuxt",
			"vue-query-nuxt",
			"dom-snapshot-nuxt",
			"nuxt"
		]
	},
	{
		name: "graphql-systems",
		title: "GraphQL, schema to cache",
		description:
			"Load when five sources of data have to read as one typed graph, and the client keeps asking for the same thing twice.",
		summary:
			"I design GraphQL systems from both ends: the schema and the services behind a gateway, and the client and its cache. I start from the screens that will read the data, and I let resolvers look at what was actually asked for.",
		record: [
			"Agris: undocumented, positional, Huffman-compressed rows from a game's trade servers, turned into a typed schema and federated behind Hive Gateway",
			"ungraphql-parse-info: a resolve-info parser that runs on edge runtimes, so a resolver fetches only the fields selected",
			"This site: every page is a GraphQL document, answered from the bundle through a normalised cache, over a Pothos schema",
			"Zeko: a range query for zkApp commands, merged into Mina's archive API"
		],
		practice: [
			"The schema is written for its clients, not copied from the database",
			"Every object gets a cache key, so two documents share what they read",
			"Services are federated behind a gateway rather than stitched together by hand"
		],
		tools: ["GraphQL", "GraphQL Federation", "Hive Gateway", "Pothos", "Houdini"],
		evidence: [
			"agris",
			"ungraphql-parse-info",
			"graphql-crawler",
			"emmanuel-style",
			"zeko",
			"patches"
		]
	},
	{
		name: "forecasting-pipelines",
		title: "Forecasts that run themselves",
		description:
			"Load when the question needs a probability, and the probability has to still be right next Tuesday with nobody at the controls.",
		summary:
			"I build statistical pipelines end to end: collecting and checking the data, the model, the backtest that says whether to believe it, and the automation that keeps it published. I write the model in Rust and I can replay it at any past date.",
		record: [
			"France 2027: a forecast of the French presidential election, refitted every hour by a pipeline no person is part of",
			"A Kalman filter aggregates the polls by political bloc; a two-round Monte Carlo turns that into each candidate's chances",
			"Backtested on the 2017 and 2022 elections, with its error settings fitted from replays of 2002 to 2022",
			"A poll counts only once a second, blind run of the collector agrees on every number"
		],
		practice: [
			"Every source is validated on the way in, and what fails is set aside with the reason",
			"A forecast for a past date uses only what had been published by that date",
			"Every decision the pipeline takes is logged with its source"
		],
		tools: ["Rust", "Kalman filters", "Monte Carlo", "GitHub Actions", "Cloudflare Workers", "Vue"],
		evidence: ["fr2027-forecaster"]
	},
	{
		name: "agent-native-interfaces",
		title: "Software that agents can use",
		description:
			"Load when an agent should be able to do everything the interface can, without reading the screen to find the button.",
		summary:
			"I build applications that agents operate as well as people do. A capability is described once, with its input, its output and its failures, and every surface is generated from that description: the command line, the MCP server, the tools in the page, the typed API.",
		record: [
			"AcidCat: a language-neutral specification for that one catalog, with bindings for TypeScript, Python, Go and Rust",
			"heb-stack: a starter where one Effect computation is served to a page, WebMCP, a CLI, MCP and an RPC API",
			"xiaomi-aircon: an air conditioner driven from the terminal, from Claude over MCP, or from the desktop bar",
			"This site registers WebMCP tools, so an agent in the page can search it and turn its pages"
		],
		practice: [
			"The catalog is checked at build time, so a surface cannot drift from the code behind it",
			"A capability's lifecycle is a state machine, not a set of flags",
			"Agents get the same keyboard-first paths that people get"
		],
		tools: ["MCP", "WebMCP", "Effect", "XState", "capnweb", "Agent skills", "JSON Schema"],
		evidence: ["acidcat", "heb-stack", "xiaomi-aircon", "emmanuel-style", "ataski", "skills"]
	},
	{
		name: "zero-knowledge-applications",
		title: "Zero-knowledge applications",
		description:
			"Load when the application proves things on Mina and the proof takes a minute nobody wants to wait.",
		summary:
			"I build what a zero-knowledge application needs around its contracts: the SDK developers call, the infrastructure that serves compiled circuits, the signers, the indexers and the explorer. Most of this work is on Mina and the rollups built on it.",
		record: [
			"Lumina DEX: seventy-six pull requests from the first commit of the monorepo, including the SDK published to npm and running on mainnet",
			"A versioned CDN for the compiled contracts, so they are compiled once instead of in every browser",
			"The signer service, first on Cloudflare containers, then rolled out to each network with NixOS",
			"Zeko: the rollup's explorer, from the design spikes to the NATS event schemas and the SurrealDB read model"
		],
		practice: [
			"Wallets and transactions are state machines in XState, because that is what they are",
			"Compile once, prove one after another, and serve the artefacts from a CDN",
			"Infrastructure is declared, per environment, and rolled out the same way everywhere"
		],
		tools: ["o1js", "Mina", "XState", "NATS JetStream", "SurrealDB", "NixOS", "OCaml"],
		evidence: ["lumina", "zeko", "nats-ml"]
	},
	{
		name: "developer-tooling",
		title: "Tools for the people who build",
		description: "Load when half the failures in CI are somebody's local version of Node.",
		summary:
			"I fix the day-to-day of a team: toolchains pinned in the repository, releases that run from one command, and the review comment everyone keeps writing turned into a check. When the problem is the tool, I write a plugin for it or fix it.",
		record: [
			"proto plugins: OCaml as a Rust plugin compiled to WebAssembly, Nushell and hk as TOML plugins, all three in proto's own registry",
			"Gommage: an authorship policy for git history, enforced in commit hooks, in CI and in pull request checks",
			"wrangler-builds: Cloudflare's build triggers kept in step with a file in the repository",
			"Reproduire: a GitHub Action that asks an incomplete issue for a reproduction, which Nuxt runs on its own tracker"
		],
		practice: [
			"The pinned version in the repository is the only way to get a tool",
			"A rule nobody enforces is a comment; I make it a check",
			"Monorepos run on moon, with every tool pinned by proto"
		],
		tools: ["proto", "moon", "pnpm", "GitHub Actions", "Rust", "WebAssembly"],
		evidence: [
			"proto-plugins",
			"proto",
			"gommage",
			"wrangler-builds",
			"reproduire",
			"nuxt-module-template"
		]
	},
	{
		name: "design-systems-in-code",
		title: "Interfaces, designed in code",
		description:
			"Load when dark mode is a second stylesheet that nobody has opened since it was written.",
		summary:
			"I design in the browser. The visual language is a schema of tokens that generates the CSS, type and space scale fluidly between screen sizes, colours are chosen in OKLCH, and the keyboard path is designed before the pointer's.",
		record: [
			"CSS Forge: design tokens to CSS custom properties at build time, with nothing shipped at run time",
			"This site: every colour, size and gap is a CSS Forge token, and a theme is a swap of values",
			"A paper that never scrolls: a pager measures each block and packs it into pages, and every move is a View Transition",
			"Read from the keyboard like a terminal, with a prompt for everything else"
		],
		practice: [
			"Fluid scales between two screen sizes, rather than a jump at each breakpoint",
			"A colour ramp is built in OKLCH so that its steps look even",
			"If it cannot be reached from the keyboard, it is not finished"
		],
		tools: ["CSS Forge", "OKLCH", "CSS custom properties", "View Transitions", "Vue", "SVG"],
		evidence: ["cssforge", "emmanuel-style"]
	},
	{
		name: "upstream-fixes",
		title: "Fixing it upstream",
		description:
			"Load when the bug is three dependencies down, in code that belongs to somebody else.",
		summary:
			"When a dependency is broken I do not patch around it: I find the bug, reproduce it in the smallest repository I can, and send the maintainers a fix they can merge. I have had pull requests merged across the Nuxt and UnJS ecosystem and beyond it.",
		record: [
			"Nitro, nineteen: deploy presets, the prerenderer, cookies and binary bodies on Lambda",
			"h3, seven in one month: `readFormData`, `event.method` and `event.headers`, `set-cookie` handled correctly",
			"UnJS: batching in unstorage, libSQL in db0, `retryDelay` in ofetch",
			"And single fixes in Vike, Houdini, Postgres.js, the Vercel AI SDK, VueUse, Vize and Lucia"
		],
		practice: [
			"A reproduction comes first, in a repository with nothing else in it",
			"I read the project's contribution guide and write in its style",
			"The fix arrives with its test and the documentation it changes"
		],
		tools: ["git", "GitHub", "Vitest", "TypeScript", "Rust", "OCaml"],
		evidence: ["nitro", "nuxt", "h3", "unjs", "proto", "lucia", "patches"]
	}
]
