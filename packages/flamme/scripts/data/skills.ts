/**
 * The Skills section: what Emmanuel is good at, filed the way an agent files a skill.
 *
 * An agent skill is a `SKILL.md`: front matter with a `name`, a `description` that
 * says when to load it and the tools it may use, then the body. The format is the
 * joke; the content is not. People read these to decide whom to hire, so each one
 * is a capability, not a technology, written in the first person.
 *
 * None of it is a list of things built. A list of five projects reads as "these
 * five and no more", which sells ten years short. A skill says what he brings to a
 * company that hires him for it, and what he believes about doing it well: values
 * that belong to the skill, not a description of this website. The proof is beside
 * it and is named as examples: some of the companies where he did it, and some of
 * the projects in the Library.
 *
 * The source is the LinkedIn profile as approved (`~/GitHub/linked-in/profile.md`)
 * and its rules (`decisions.md`): capabilities and outcomes, technology names only
 * as evidence, a plain first-person voice. The order is the order he is hired in:
 * delivering with agents comes first.
 *
 * Shape:
 *   name         kebab-case, the skill's directory (`skills/<name>/SKILL.md`)
 *   title        the heading
 *   description  front matter: when to load it, one sentence, for the smile
 *   summary      the pitch, in a few sentences
 *   offer        what he brings: capabilities and outcomes, one line each
 *   principles   what he believes about the skill, one line each
 *   tools        front matter `allowed-tools`: what he works with
 *   roles        examples of where he did it: companies in the ledger, by name
 *   evidence     examples in the Library, by project name
 */
export interface Skill {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly summary: string
	readonly offer: readonly string[]
	readonly principles: readonly string[]
	readonly tools: readonly string[]
	readonly roles: readonly string[]
	readonly evidence: readonly string[]
}

export const skills: readonly Skill[] = [
	{
		name: "agentic-delivery",
		title: "Delivering with agents",
		description:
			"Load when the team wants coding agents to ship work it can trust, on a budget it can afford.",
		summary:
			"Software engineering has moved from writing correct code to designing the systems that produce it. I build those systems: the specs, context, architecture, tests, verification and review that let coding agents ship work a company can trust, on a token budget a small team can afford. I can tell when an agent's work is right because I spent a decade writing, reviewing and fixing production code by hand.",
		offer: [
			"A delivery process from issue to merged pull request, with agents working in parallel and people reviewing where it matters",
			"Codebases agents can work in safely: one source of truth, typed boundaries and guardrails enforced in CI",
			"Agentic systems that do real work for a business: automation, data pipelines, trading, finance and forecasting",
			"A team taken from its first workflow to agents across everything it ships",
			"Costs kept in check: the right model for each task, and context that is not paid for twice"
		],
		principles: [
			"An agent is only as good as the system around it. I design the system and let the agent do the typing.",
			"Trust is earned with evidence. Work is done when it has been shown to work, not when the agent says so.",
			"Judgment is the scarce resource. People should spend theirs on the decisions that matter, and on nothing else.",
			"Speed without correctness is debt at a higher interest rate."
		],
		tools: ["Coding agents", "MCP", "WebMCP", "Agent skills", "Linear", "GitHub Actions"],
		roles: ["Self-employed", "Zeko"],
		evidence: ["fr2027-forecaster", "acidcat", "heb-stack", "ataski", "skills", "xiaomi-aircon"]
	},
	{
		name: "software-architecture",
		title: "Architecture, and owning a product end to end",
		description:
			"Load when one person has to hold the whole system in their head, or design it so that nobody needs to.",
		summary:
			"I can own a product across the whole stack: the web app, the API and data layer, the infrastructure it runs on, and the SDKs other developers build with. I have done it as a principal engineer, as a head of engineering and as a founder. I design systems that stay simple as they grow, so that the next engineer, or the next agent, can change them without fear.",
		offer: [
			"A product taken from an empty repository to production, and run once it is there",
			"An architecture sized to the team that has to live with it",
			"Legacy systems replaced piece by piece while they keep serving their users",
			"Technical decisions explained in terms the business can weigh",
			"SDKs and developer tools that other teams build on"
		],
		principles: [
			"Simplicity is the hard part. Anyone can add; the skill is in what you leave out.",
			"One source of truth. Everything else is derived from it, or it will drift.",
			"Make the wrong thing hard to write. A boundary that is typed and checked needs no meeting.",
			"Architecture is for the people who change the system after me."
		],
		tools: ["TypeScript", "Rust", "Go", "Python", "OCaml", "GraphQL", "XState", "moon"],
		roles: ["Zeko", "Zeno", "Obelisk Auditing", "Yo-Da (your data)", "Cohda"],
		evidence: ["acidcat", "heb-stack", "zeko", "lumina", "emmanuel-style"]
	},
	{
		name: "frontend-engineering",
		title: "Frontend, from the pixel to the framework",
		description:
			"Load when the interface has to feel right on a phone, on a laptop and from the keyboard, and stay fast when the data grows.",
		summary:
			"I have built interfaces for a living since 2015, for startups, agencies, fintech and Web3, in Vue, React and Svelte. I have also worked on a framework from the inside, on the Nuxt core team, so I know what happens under the components. I care about how a product feels: fast on a bad connection, usable from the keyboard, clear when something goes wrong.",
		offer: [
			"Interfaces designed and built end to end, for desktop and mobile, with or without a designer",
			"Complex, data-heavy applications that stay fast as the data grows",
			"Design systems and component libraries a team can build on",
			"Performance, accessibility and offline behaviour treated as features",
			"Whichever framework the product is in, and a migration path when it needs another"
		],
		principles: [
			"The interface is the product. Users never see the architecture, they see how it feels.",
			"Every state deserves design: loading, empty, error and offline, not only the happy path.",
			"Performance is respect for the person on the other side of the screen.",
			"The platform first. What the browser already does, it does for everyone."
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
			"I design and run the server side: APIs, data models, queues, pipelines and the services between them. I have built them for fintech, IoT, e-learning and blockchains, on serverless platforms and at the edge. I build backends that are correct under load, cheap when idle, and readable by the next person who opens them.",
		offer: [
			"APIs designed for the clients that use them, in GraphQL or REST",
			"Data models that survive the product changing its mind",
			"Event-driven pipelines that tolerate failure and can be replayed",
			"Real-time systems, caching, and the trade-offs of freshness",
			"Serverless and edge architectures that scale down to zero as well as up"
		],
		principles: [
			"Correctness first. A fast wrong answer is still wrong.",
			"Data outlives code. I model it with care because it is the part that stays.",
			"Everything fails eventually, so the failure path is designed, not discovered.",
			"Boring technology where it carries the load, new technology where it earns its place."
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
		name: "security",
		title: "Security: contracts, infrastructure, agents",
		description:
			"Load when something of value is exposed: money in a contract, a network, or an agent holding the keys.",
		summary:
			"I founded a smart contract auditing firm and led it through more than 50 audits, and I started my career running networks and servers. I bring the same habits to agents: MCP servers, tool permissions, sandboxing, prompt injection and secrets. I think like the attacker, so that the system does not meet one unprepared.",
		offer: [
			"Smart contract audits, and contracts written to pass one",
			"Agent security: what an agent may touch, what it may run, and what it must never see",
			"Infrastructure and network hardening, from the firewall to the access policy",
			"Threat modelling early, while changing the design is still cheap",
			"Secrets, authentication and authorisation done properly"
		],
		principles: [
			"Security is a property of the design, not a layer added before launch.",
			"Fail closed. A system that is unsure should refuse.",
			"Least privilege, for people and for agents alike.",
			"Assume the attacker is patient and has read the code."
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
			"I have run products on AWS and on Cloudflare for ten years, with the infrastructure written as code and an environment for every change. I started as a system administrator, so I know what is under the abstraction, down to the cabling. I build platforms that stay up, scale without drama and do not send surprising invoices.",
		offer: [
			"Infrastructure as code, reviewed and versioned like the application",
			"Serverless and edge platforms, and migrations from one cloud to another",
			"Delivery pipelines with a preview environment for every pull request",
			"Observability: errors reported, triaged and tied to the work",
			"A bill that stays in proportion to the usage"
		],
		principles: [
			"If it is not in code, it does not exist. A click in a console is a decision nobody can review.",
			"Environments are cheap. Production incidents are not.",
			"You cannot fix what you cannot see. Observability comes with the first deploy.",
			"The best infrastructure is the one the team forgets about."
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
			"I am on the Nuxt core team, where most of my work is on Nitro, the server engine that Nuxt and several other frameworks run on. Work at that level reaches millions of developers and users. I have had more than 300 pull requests merged into other people's projects, and I author and maintain modules of my own.",
		offer: [
			"Bugs fixed where they live, in the dependency, instead of patched around",
			"Framework-level knowledge of the tools your product is built on",
			"Libraries and modules designed, documented, released and maintained",
			"Work with maintainers and communities, in public and across timezones",
			"An open source practice for a company: what to publish, how, and how to keep it alive"
		],
		principles: [
			"Fix it upstream. A workaround helps one team once, a fix helps everyone for good.",
			"Read the source. The documentation is what was intended, the code is what happens.",
			"Public work is the most honest CV. Anyone can read how I write, review and disagree.",
			"Maintenance is the real contribution. Shipping is the easy day."
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
			"I have worked in Web3 since 2021: auditing and writing smart contracts, then building what a zero-knowledge rollup needs around its protocol. That means the SDKs, the bridges, the indexers and the signers, and some of the protocol itself. I make cryptography usable, by the developers who build on it and by the people who never want to hear about it.",
		offer: [
			"Smart contracts written, tested and audited",
			"SDKs and CLIs that developers use to build on a chain",
			"Bridges, indexers and the web applications around a protocol",
			"Zero-knowledge applications where the proof is slow and the experience is not",
			"DeFi applications and trading systems"
		],
		principles: [
			"Code that holds money deserves paranoia. There is no patch after the exploit.",
			"A protocol is only as good as the tools around it. Developers adopt what is easy to build on.",
			"Hide the cryptography, not the guarantees.",
			"Verify, do not trust, and that includes my own code."
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
			"I have led as a founder, as a head of engineering and as the senior engineer of a small team. Always hands-on: I write the core of the system, and I run the reviews, the hiring and the process around it. I grew a company from myself alone to a remote team of twelve.",
		offer: [
			"Technical leadership that still ships code",
			"Hiring, mentoring and performance reviews",
			"A delivery process sized to the team, from the issue to production",
			"Remote teams run across timezones, mostly in writing",
			"A bridge between engineering and the rest of the business"
		],
		principles: [
			"Lead from the code. I do not ask for what I would not do myself.",
			"Process is a cost. I keep the smallest amount that keeps the work moving.",
			"A review teaches as much as it catches.",
			"Hire people you can trust, then trust them."
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
			"I build pipelines where agents take a brief to finished visual work: films made entirely in code, and real-time 3D on the web. Agents operate the tools a professional uses, Blender, DaVinci Resolve, FFmpeg and FreeCAD, the way an editor or a designer would. Some of it ends up on my 3D printer.",
		offer: [
			"Video produced from a brief, generated and edited in code",
			"Real-time 3D and shaders for the web, on three.js and WebGPU",
			"3D assets modelled and rendered by script, repeatable on demand",
			"Creative tooling automated end to end, from the brief to the export",
			"A visual identity for a product that cannot afford a studio"
		],
		principles: [
			"Creative work can be engineered. A film is a build, and a build can be repeated.",
			"Taste is the part that cannot be automated, so that is where I spend my time.",
			"Use the professional's tools. The ceiling of the tool is the ceiling of the work.",
			"If it cannot be made again from the repository, it was luck."
		],
		tools: ["three.js", "WebGPU", "Blender", "DaVinci Resolve", "FFmpeg", "FreeCAD"],
		roles: ["Self-employed"],
		evidence: ["emmanuel-style"]
	}
]
