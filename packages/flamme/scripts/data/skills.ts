/**
 * The Skills section: what Emmanuel is good at, filed the way an agent files a skill.
 *
 * An agent skill is a `SKILL.md`: front matter with a `name`, a `description` that
 * says when to load it and the tools it may use, then the body. The format is the
 * joke; the content is not. People read these to decide whom to hire, so each one
 * is a capability, not a technology: frontend, backend, architecture, delivering
 * with agents, security, infrastructure, open source, zero knowledge, leading a
 * team, video and 3D. Each is written in the first person and says what he does,
 * what he has done with it and where, and how he goes about it.
 *
 * The source is the LinkedIn profile as approved (`~/GitHub/linked-in/profile.md`)
 * and its rules (`decisions.md`): capabilities and outcomes, technology names only
 * as evidence, a plain first-person voice. Nothing here is a promise. Every line of
 * `record` is a role in the ledger or a project in the Library, and every skill
 * cites both by name; the content check refuses a name that is not there.
 *
 * Shape:
 *   name         kebab-case, the skill's directory (`skills/<name>/SKILL.md`)
 *   title        the heading
 *   description  front matter: when to load it, one sentence, for the smile
 *   summary      what he does, in a few sentences
 *   record       what he has done with it: facts, one line each
 *   practice     how he works, one line each
 *   tools        front matter `allowed-tools`: what he works with
 *   roles        where he did it: companies in the ledger, by name
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
	readonly roles: readonly string[]
	readonly evidence: readonly string[]
}

export const skills: readonly Skill[] = [
	{
		name: "frontend-engineering",
		title: "Frontend, from the pixel to the framework",
		description:
			"Load when the interface has to feel right on a phone, on a laptop and from the keyboard, and stay fast when the data grows.",
		summary:
			"I have built interfaces for a living since 2015: intranets, fintech dashboards, PWAs, a video learning platform, the bridge of a rollup. I work in whichever framework the product is in, Vue, React or Svelte, and I have worked on one from the inside, on the Nuxt core team. I care about how it feels: the keyboard path, the loading states, what happens offline.",
		record: [
			"Zeko: the bridge, the faucet, the leaderboard and the documentation site, designed and written alone, for desktop and mobile",
			"Zeno: a gamified, interactive video learning platform in SvelteKit, most of the core codebase",
			"DeepCrawl: a React application replacing a legacy AngularJS one, across several frontend teams",
			"Cognitive Credit and Tigerspike: Vue PWAs and React applications on GraphQL APIs",
			"This paper: nothing scrolls, every move is a page turn, it reads from the keyboard and works offline"
		],
		practice: [
			"The keyboard path is designed first; the pointer follows it",
			"Something that is in one state at a time is a state machine, not a set of flags",
			"Design tokens generate the CSS, so a theme is a swap of values",
			"Tested where it matters: unit, integration and end to end"
		],
		tools: ["Vue", "Nuxt", "React", "Svelte", "TypeScript", "CSS", "Vite", "Cypress"],
		roles: ["Zeko", "Zeno", "DeepCrawl", "Cognitive Credit", "Cohda"],
		evidence: [
			"emmanuel-style",
			"zeko",
			"cssforge",
			"form-actions-nuxt",
			"dom-snapshot-nuxt",
			"vue-switch-match"
		]
	},
	{
		name: "backend-engineering",
		title: "Backends, APIs and data",
		description:
			"Load when the API has to stay correct under load, cost little when idle, and make sense to the next person who opens it.",
		summary:
			"I design and run the server side: APIs, data models, queues, pipelines and the services between them. GraphQL and REST, Postgres and key-value stores, serverless on AWS and on Cloudflare's edge. I have run a fault-tolerant pipeline for an energy provider's devices and the indexers of a blockchain, and I decide how fresh each piece of data has to be before I write any of it.",
		record: [
			"Tigerspike: an IoT platform for one of the UK's main energy providers, with device data over MQTT through a fault-tolerant pipeline on SQS and Kinesis, behind a GraphQL API",
			"Zeko: the indexers, APIs and proxies behind the bridge and the leaderboard",
			"Zeno: GraphQL on Workers and Durable Objects, with Postgres, Redis and KV",
			"Yo-Da: an Express API built test-first on Postgres, in an overhaul of the whole architecture",
			"Agris: undocumented, positional rows from a game's trade servers, turned into a typed and federated GraphQL API"
		],
		practice: [
			"The schema is written for its clients, not copied from the database",
			"Every field has a freshness window, and the cache follows it",
			"State that has to be shared has one owner"
		],
		tools: [
			"Node.js",
			"GraphQL",
			"Postgres",
			"Redis",
			"Cloudflare Workers",
			"Durable Objects",
			"AWS Lambda",
			"Rust"
		],
		roles: ["Zeko", "Zeno", "DeepCrawl", "Tigerspike", "Yo-Da (your data)"],
		evidence: ["agris", "zeko", "ungraphql-parse-info", "graphql-crawler", "bot-drop", "unjs"]
	},
	{
		name: "software-architecture",
		title: "Architecture, and owning a product end to end",
		description:
			"Load when one person has to hold the whole system in their head, or design it so that nobody needs to.",
		summary:
			"Across the stack I can own a product end to end: the web app, the API and data layer, the infrastructure it runs on, and the SDKs other developers build with. I have done it as the only web engineer of a rollup, as head of engineering at a startup and as the founder of a company. I design codebases with one source of truth, typed boundaries and guardrails enforced in CI.",
		record: [
			"Zeko: designed, wrote and ran the entire web platform, in a team of three engineers",
			"Zeno: designed the architecture and wrote most of the core codebase",
			"Yo-Da: led an overhaul of the whole architecture",
			"Cohda: an intranet built from nothing and run for three years, from renting the servers to the user experience",
			"AcidCat: a specification where an application says what it can do once, and every surface is generated from that"
		],
		practice: [
			"One source of truth, and everything else generated from it",
			"Boundaries are typed, and the types are checked when it builds",
			"A rule nobody enforces is a comment; I make it a check"
		],
		tools: ["TypeScript", "Rust", "Go", "Python", "OCaml", "GraphQL", "XState", "moon"],
		roles: ["Zeko", "Zeno", "Obelisk Auditing", "Yo-Da (your data)", "Cohda"],
		evidence: ["acidcat", "heb-stack", "zeko", "lumina", "emmanuel-style"]
	},
	{
		name: "agentic-delivery",
		title: "Delivering with agents",
		description:
			"Load when the team wants coding agents to ship work it can trust, on a budget it can afford.",
		summary:
			"The job has moved from writing correct code to designing the systems that produce correct code: specs, context, architecture, tests, verification and review that let coding agents ship work a company can trust. I know what correct code looks like because I spent a decade writing it, reviewing it and fixing it in production. That is what I do now, and what I help companies do.",
		record: [
			"Zeko: led the team's move to agentic development, with Linear-based workflows from issue to merged PR, shared agent context, verification and review",
			"A lean, token-efficient delivery process for small teams: agents working in parallel, verified with evidence, reviewed where it matters",
			"Agentic systems that do real work: home automation, trading bots, a personal finance manager, data pipelines and forecasting",
			"France 2027: an election forecast refitted every hour by a pipeline with nobody in it",
			"AcidCat: one description of what an application can do, served to people and to agents alike"
		],
		practice: [
			"Agents work in codebases built for them: one source of truth, typed boundaries, guardrails in CI",
			"Work is verified with evidence before anyone calls it done",
			"People review where it matters, not everywhere"
		],
		tools: ["Coding agents", "MCP", "WebMCP", "Agent skills", "Linear", "GitHub Actions"],
		roles: ["Self-employed", "Zeko"],
		evidence: ["fr2027-forecaster", "acidcat", "heb-stack", "ataski", "skills", "xiaomi-aircon"]
	},
	{
		name: "security",
		title: "Security: contracts, infrastructure, agents",
		description:
			"Load when something of value is exposed: money in a contract, a network, or an agent holding the keys.",
		summary:
			"I founded a smart contract auditing firm and led it through more than 50 audits, and I started my career running networks and servers. The same habits apply to agents now: MCP servers, tool permissions, sandboxing, prompt injection and secrets.",
		record: [
			"Obelisk Auditing: taught myself Solidity, audited EVM smart contracts on my own, then grew a remote team of 12 that audited more than 50 Web3 projects",
			"A monitoring tool that detects blockchain state changes",
			"Ityka: the infrastructure of a call centre end to end, from cabling and routers to Linux, nginx and iptables",
			"bot-drop: a private store that checks the access token again inside the Worker, so a half-configured deployment fails closed",
			"Gommage: an authorship policy for git history, enforced in hooks, in CI and in pull request checks"
		],
		practice: [
			"A half-configured system refuses, it does not allow",
			"An agent gets the permissions the task needs and nothing else",
			"A secret never passes through a context or a log"
		],
		tools: [
			"Solidity",
			"Foundry",
			"Hardhat",
			"EVM",
			"Linux",
			"iptables",
			"Cloudflare Access",
			"MCP"
		],
		roles: ["Obelisk Auditing", "Ityka", "Self-employed"],
		evidence: ["bot-drop", "gommage", "authjs-nuxt", "lucia", "mnemonic-to-private-key"]
	},
	{
		name: "cloud-infrastructure",
		title: "Cloud and infrastructure",
		description: "Load when it has to run somewhere, stay up, and not send a surprising invoice.",
		summary:
			"I have put products on AWS and on Cloudflare for ten years, with the infrastructure written as code and an environment for every pull request. I started as a system administrator, so I know what is under the abstraction.",
		record: [
			"Zeko: designed the infrastructure and migrated it to Cloudflare, with Sentry error reporting and a bug triage loop",
			"Tigerspike: serverless on AWS in the CDK, with a throwaway environment for every pull request",
			"Yo-Da: ECS Fargate, Aurora and CloudFront, defined as code with Terraform and CloudFormation",
			"Nitro: its integration with AWS, Azure, Cloudflare, Vercel and Netlify, on the Nuxt core team",
			"Lumina: a signer service on Cloudflare containers, then rolled out to each network with NixOS"
		],
		practice: [
			"Infrastructure is code, and it is reviewed like code",
			"Every branch gets an environment of its own",
			"Errors are reported, triaged and tied to the board from the first deploy"
		],
		tools: [
			"Cloudflare",
			"AWS",
			"AWS CDK",
			"Terraform",
			"NixOS",
			"GitHub Actions",
			"Sentry",
			"Linux"
		],
		roles: ["Zeko", "Zeno", "Tigerspike", "Yo-Da (your data)", "Ityka"],
		evidence: ["nitro", "wrangler-builds", "lumina", "zeko", "proto-plugins"]
	},
	{
		name: "open-source",
		title: "Open source, at framework level",
		description:
			"Load when the bug is three dependencies down, in code that belongs to somebody else.",
		summary:
			"I am on the Nuxt core team, where most of my work is on Nitro, the server engine that Nuxt and several other frameworks run on. Work at that level reaches millions of developers and users. When a dependency is broken I do not patch around it: I reproduce it, fix it where it lives, and wait for the release.",
		record: [
			"Pull requests merged into twenty-five open source projects, from Nitro, Nuxt and h3 to Houdini, VueUse and Vize",
			"Nitro: nineteen of them, on deploy presets, the prerenderer, cookies and runtime config",
			"Community modules for Nuxt that I author and maintain: Auth.js, Vue Query, form actions and server blocks",
			"Plugins for the proto toolchain manager, in its own registry, and a NATS client for OCaml on opam"
		],
		practice: [
			"A reproduction comes first, in a repository with nothing else in it",
			"I read the project's contribution guide and write in its style",
			"The fix arrives with its test and the documentation it changes"
		],
		tools: ["Nuxt", "Nitro", "h3", "Vue", "Vite", "TypeScript", "Rust", "OCaml"],
		roles: ["Nuxt"],
		evidence: [
			"nitro",
			"nuxt",
			"h3",
			"unjs",
			"authjs-nuxt",
			"form-actions-nuxt",
			"server-block-nuxt",
			"vue-query-nuxt",
			"vize"
		]
	},
	{
		name: "smart-contracts-and-zero-knowledge",
		title: "Smart contracts and zero knowledge",
		description:
			"Load when the application proves things on a chain, and the proof takes a minute nobody wants to wait.",
		summary:
			"I have worked in Web3 since 2021: auditing and writing EVM smart contracts, then building what a zero-knowledge rollup needs around its protocol. That means the SDKs, the bridge, the indexers and the signers, and some of the protocol itself, in OCaml and in circuits.",
		record: [
			"Zeko: the SDKs and CLIs developers use to bridge to and build on the rollup, and work on OCaml protocol code, smart contracts and ZK circuits",
			"Lumina DEX: seventy-six pull requests, from the SDK on mainnet to a versioned CDN for compiled contracts and the signer service",
			"Obelisk: more than 50 audits, and trading bots, DeFi applications and smart contracts built for clients",
			"The Plutus Pioneer Program, on Cardano"
		],
		practice: [
			"Wallets and transactions are state machines, because that is what they are",
			"Compile once, prove one after another, and serve the artefacts from a CDN",
			"An audit reads the contract the way an attacker would"
		],
		tools: ["Solidity", "Foundry", "Viem", "o1js", "OCaml", "ZK circuits", "XState", "NATS"],
		roles: ["Zeko", "dcSpark", "Obelisk Auditing"],
		evidence: [
			"lumina",
			"zeko",
			"nats-ml",
			"spacebudz-identity",
			"plutus-guide",
			"mnemonic-to-private-key"
		]
	},
	{
		name: "leading-teams",
		title: "Leading a team, hands-on",
		description:
			"Load when the team needs someone who runs the room and still writes the core of the system.",
		summary:
			"I have led as a founder, as a head of engineering and as the senior engineer of a small team. Each time hands-on: I write the core of the system, and I run the reviews, the hiring and the process around it.",
		record: [
			"Obelisk Auditing: founded the company and grew it into a remote team of 12, with new clients every month",
			"Zeno: led the team, ran code and performance reviews, mentored junior developers and hired",
			"Zeko: brought in the workflows the team ships with, from issue to merged PR, and the bug triage loop",
			"The M Industries and Stack Industries: my own contracting companies, in London and in France"
		],
		practice: [
			"I write the core myself, and review the rest",
			"A process is the smallest thing that keeps the work moving",
			"A review teaches as much as it catches"
		],
		tools: ["Code review", "Hiring", "Mentoring", "Linear", "Sentry", "GitHub"],
		roles: ["Obelisk Auditing", "Zeno", "Zeko", "The M Industries", "Stack Industries"],
		evidence: ["ataski", "reproduire", "gommage", "nuxt-module-template"]
	},
	{
		name: "video-and-3d",
		title: "Video and 3D, made with agents",
		description: "Load when a brief should go in and finished visual work should come out.",
		summary:
			"I build pipelines where agents take a brief to finished visual work: films made entirely in code, and real-time 3D on the web with three.js and WebGPU. Agents operate Blender, DaVinci Resolve, FFmpeg and FreeCAD the way an editor or a designer would. Some of it ends up on my 3D printer.",
		record: [
			"Films generated entirely in code",
			"Real-time 3D for the web, on three.js and WebGPU",
			"Agents working in Blender, DaVinci Resolve and FreeCAD",
			"This paper's press: ink simulated on WebGPU, emblems modelled and rendered in Blender from a script, a portrait printed in relief, and a deck drawn from live HTML where the browser can"
		],
		practice: [
			"The brief is the interface: words go in, finished work comes out",
			"Every asset can be made again from a script in the repository",
			"Agents use the tools a professional uses, not a simpler copy of them"
		],
		tools: ["three.js", "WebGPU", "Blender", "DaVinci Resolve", "FFmpeg", "FreeCAD"],
		roles: ["Self-employed"],
		evidence: ["emmanuel-style"]
	}
]
