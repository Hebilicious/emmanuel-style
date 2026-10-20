/**
 * The Skills section: what can be asked for, written as agent skills.
 *
 * An agent skill is a `SKILL.md`: front matter with a `name` and a `description`
 * that says when to load it, then what to do once it is loaded. An agent reads the
 * descriptions alone to choose; these are written to be read the same way, by
 * someone deciding whom to hire. Every skill cites the projects in the Library
 * that are its evidence, by name, and the content check refuses a name that is not
 * there.
 *
 * Shape:
 *   name         kebab-case, the skill's directory (`skills/<name>/SKILL.md`)
 *   title        the heading
 *   description  "Use when …", one sentence
 *   whenToUse    the situations to call it for
 *   steps        how it runs, in order
 *   tools        what it works with
 *   evidence     Library project names
 *   example      a request it answers, as someone would write it
 */
export interface Skill {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly whenToUse: readonly string[]
	readonly steps: readonly string[]
	readonly tools: readonly string[]
	readonly evidence: readonly string[]
	readonly example: string
}

export const skills: readonly Skill[] = [
	{
		name: "edge-native-backends",
		title: "Edge-native backends",
		description:
			"Use when an API or a site has to answer close to its readers on Cloudflare, cost nothing while idle, and keep working when the network does not.",
		whenToUse: [
			"An API that is slow far from its one region, or expensive while nobody uses it",
			"Shared state (counters, caches, queues) without a database server to run",
			"A site that has to read offline after the first visit"
		],
		steps: [
			"Write down how fresh each piece of data must be, from seconds to days",
			"Put the API on Workers, the shared state in Durable Objects, the files in R2",
			"Cache at the edge field by field, and batch the calls upstream",
			"Read through a durable cache on the client, so a page renders with the network off",
			"Ship every branch to a preview of its own"
		],
		tools: [
			"Cloudflare Workers",
			"Durable Objects",
			"R2",
			"Cloudflare Access",
			"Nitro",
			"h3",
			"Service workers"
		],
		evidence: ["agris", "emmanuel-style", "bot-drop", "wrangler-builds", "nitro", "h3"],
		example: "Our GraphQL API is slow outside Europe and costs the same at 3am as at noon."
	},
	{
		name: "nuxt-and-vue-internals",
		title: "Nuxt & Vue, from the inside",
		description:
			"Use when a Vue or Nuxt application needs what the framework does not ship: a module, a compiler-level feature, or a fix that belongs upstream.",
		whenToUse: [
			"A pattern from another framework (form actions, server loaders, snapshots) that Nuxt lacks",
			"A module that has to work on the edge as well as on Node",
			"A framework bug blocking a release"
		],
		steps: [
			"Read the framework's source before its documentation",
			"Prototype as a module, with a playground that reproduces the real case",
			"Ship it with documentation and examples, and list it where people look",
			"Send upstream what belongs upstream, with the tests"
		],
		tools: ["Vue", "Nuxt", "Nuxt Kit", "Nitro", "Vite", "Volar", "TanStack Query"],
		evidence: [
			"form-actions-nuxt",
			"authjs-nuxt",
			"server-block-nuxt",
			"vue-query-nuxt",
			"nuxt",
			"unjs"
		],
		example: "We want forms that post before the JavaScript loads, in Nuxt, typed end to end."
	},
	{
		name: "graphql-systems",
		title: "GraphQL systems",
		description:
			"Use when data from several sources has to become one typed graph: a schema designed for its clients, federation behind a gateway, resolvers that look ahead, and a client cache.",
		whenToUse: [
			"An upstream that answers with undocumented rows, to be turned into named, typed fields",
			"Several services that should read as one schema",
			"A client that fetches the same data from five places"
		],
		steps: [
			"Design the schema from the screens that will read it",
			"Federate the services behind a gateway rather than merging them by hand",
			"Let resolvers look at the selection, so they fetch only what was asked",
			"Give every object a cache key, so documents share what they read"
		],
		tools: ["GraphQL", "GraphQL Federation", "Hive Gateway", "Pothos", "Houdini"],
		evidence: ["agris", "ungraphql-parse-info", "graphql-crawler", "patches", "zeko"],
		example:
			"The market data is a mess of positional arrays. Our app needs prices, names and history in one query."
	},
	{
		name: "forecasting-pipelines",
		title: "Forecasting pipelines",
		description:
			"Use when a question needs a probability that keeps itself up to date: data and signals in, a model that is backtested, a published forecast that runs with nobody at the controls.",
		whenToUse: [
			"Polls, markets or attention data to be combined into one forecast",
			"A model that has to be replayed at any past date to be trusted",
			"A forecast that should publish itself on a schedule"
		],
		steps: [
			"Validate every source on the way in, and quarantine what fails, with the reason",
			"Fit a model that can be replayed with only the data published by a given date",
			"Backtest it against past events and report what each layer adds",
			"Run collection and refits on a schedule, and log every decision and source"
		],
		tools: ["Rust", "Kalman filters", "Monte Carlo", "GitHub Actions", "Cloudflare Workers", "Vue"],
		evidence: ["fr2027-forecaster"],
		example:
			"We want our own election forecast, updated every hour, that we can defend line by line."
	},
	{
		name: "agent-native-interfaces",
		title: "Agent-native interfaces",
		description:
			"Use when an application should be as usable by agents as by people: one catalog of capabilities, served as a command line, MCP tools, WebMCP in the page and a typed API.",
		whenToUse: [
			"A product that agents should operate without screen-scraping it",
			"The same feature written four times, for the UI, the CLI, the API and the bot",
			"A device or a service to put in reach of Claude or another agent"
		],
		steps: [
			"Describe each capability once: its input, its output, its failures",
			"Generate every surface from that description instead of writing each by hand",
			"Check the catalog at build time, so a surface cannot drift from the code",
			"Give agents the same keyboard-first paths people get"
		],
		tools: ["AcidCat", "MCP", "WebMCP", "Effect", "XState", "capnweb", "Agent skills"],
		evidence: ["acidcat", "heb-stack", "xiaomi-aircon", "emmanuel-style", "ataski", "skills"],
		example:
			"Our support agent should be able to do everything our admin panel does, and nothing more."
	},
	{
		name: "zero-knowledge-applications",
		title: "Zero-knowledge applications",
		description:
			"Use when an application runs on Mina or a zero-knowledge rollup: an SDK over the contracts, compiled circuits served from a CDN, signers, indexers and an explorer.",
		whenToUse: [
			"A decentralised exchange or bridge that needs its SDK and its infrastructure",
			"Proofs that are too slow to compile in every browser",
			"An explorer that has to correlate events across two layers"
		],
		steps: [
			"Wrap the contracts in an SDK with the wallet and transaction lifecycles as state machines",
			"Compile once and serve the artefacts from a versioned CDN",
			"Run signers per environment, rolled out declaratively",
			"Index the chain into a read model the explorer can page through"
		],
		tools: ["o1js", "Mina", "XState", "NATS JetStream", "SurrealDB", "NixOS"],
		evidence: ["lumina", "zeko"],
		example: "Our zkApp takes a minute to prove in the browser and our signer is a laptop."
	},
	{
		name: "developer-tooling",
		title: "Developer tooling",
		description:
			"Use when a team loses its days to its tools: toolchains to pin, releases to automate, a commit policy to enforce, CI that should explain itself.",
		whenToUse: [
			"Every machine has a different version of every tool",
			"Releases are a checklist somebody follows by hand",
			"The same review comment, written on every pull request"
		],
		steps: [
			"Pin every tool in the repository, and make the pin the only way to get it",
			"Turn each repeated review comment into a check that runs before the review",
			"Automate the release from a single command, changelog included",
			"Fix the tool upstream when the problem is the tool"
		],
		tools: ["proto", "moon", "GitHub Actions", "Rust", "WebAssembly", "pnpm"],
		evidence: [
			"proto-plugins",
			"proto",
			"gommage",
			"reproduire",
			"wrangler-builds",
			"nuxt-module-template"
		],
		example: "Half our CI failures are someone's local Node version."
	},
	{
		name: "design-systems-in-code",
		title: "Design systems in code",
		description:
			"Use when a product needs a visual language that lives in code: tokens generated at build time, fluid type and space, colours in OKLCH, and interfaces that read with the keyboard.",
		whenToUse: [
			"Colours and spacing copied between a design file and three codebases",
			"An interface that has to work as well with the keyboard as with the mouse",
			"A brand that should feel like something, not like a template"
		],
		steps: [
			"Write the tokens as one schema, and generate the CSS from it",
			"Scale type and space fluidly between two screen sizes, not at breakpoints",
			"Choose colours in OKLCH, so a ramp is even and a theme is a swap",
			"Design the keyboard path first; the pointer follows it"
		],
		tools: ["CSS Forge", "OKLCH", "CSS custom properties", "View Transitions", "Vue"],
		evidence: ["cssforge", "emmanuel-style"],
		example: "Our dark mode is a second stylesheet nobody maintains."
	},
	{
		name: "upstream-fixes",
		title: "Upstream fixes",
		description:
			"Use when the bug is in somebody else's code: find it, reproduce it in the smallest repository possible, and land a pull request the maintainers will merge.",
		whenToUse: [
			"A dependency that breaks on your platform (an edge runtime, a bundler, a new Node)",
			"A missing feature that every user of the library works around",
			"An issue tracker drowning in reports without reproductions"
		],
		steps: [
			"Reproduce it in a repository with nothing else in it",
			"Read the project's contribution guide and match its style",
			"Send the fix with its test, and the documentation it changes",
			"Keep the fork out of your own code; wait for the release"
		],
		tools: ["git", "GitHub", "Vitest", "StackBlitz"],
		evidence: ["nitro", "nuxt", "h3", "unjs", "proto", "lucia", "patches"],
		example: "Our deploy breaks because of a cookie bug three dependencies down."
	}
]
