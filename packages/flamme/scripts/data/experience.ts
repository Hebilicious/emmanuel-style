/**
 * Experience entries.
 *
 * Taken from the LinkedIn profile as approved and applied on 28 October 2026
 * (`~/GitHub/linked-in/profile.md`), which is the source of truth: a role's title,
 * dates, place and text are the profile's, with its bullets as the highlights. The
 * stack of each role is the technology its text names. When the profile changes,
 * change this file to match; nothing here is written from memory.
 *
 * What the profile does not say is filled in as little as possible, and marked:
 * Ityka's end is given as the year 2015, and June is used, the month before the
 * next role starts; Supinfo is given as 2013 to 2015, set here as school years;
 * neither has a place on the profile, so both say France.
 */
export interface Role {
	company: string
	title: string
	/** ISO month, `YYYY-MM`. */
	start: string
	/** ISO month, or null when the role is current. */
	end: string | null
	location: string
	summary: string
	highlights: string[]
	stack: string[]
	/** The Library projects that came out of the role, by name. */
	library?: string[]
}

export const roles: Role[] = [
	{
		company: "Self-employed",
		title: "Independent Engineer",
		start: "2026-06",
		end: null,
		location: "Remote",
		summary:
			"Building agentic systems, mostly closed source: home automation, trading bots, a personal finance manager, data pipelines and forecasting, all designed, built and operated with coding agents.",
		highlights: [
			"Developing a lean, token-efficient agentic delivery process for small teams.",
			"Agent-driven pipelines for video and 3D, where a brief goes in and finished work comes out: films generated entirely in code, and real-time 3D for the web on three.js and WebGPU.",
			"Agents working in Blender, DaVinci Resolve and FreeCAD like an editor or a designer would. Some of it ends up on my 3D printer.",
			"Open source on GitHub, and in the Library of this paper."
		],
		stack: [
			"TypeScript",
			"Rust",
			"Coding agents",
			"MCP",
			"three.js",
			"WebGPU",
			"Blender",
			"Cloudflare"
		],
		library: ["fr2027-forecaster", "acidcat", "agris", "heb-stack", "xiaomi-aircon", "bot-drop"]
	},
	{
		company: "Zeko",
		title: "Principal Engineer",
		start: "2024-11",
		end: "2026-06",
		location: "Remote",
		summary:
			"Zero-knowledge rollup settling on Ethereum. A team of three engineers, each owning a large part of the stack. I designed, wrote and ran the entire web platform.",
		highlights: [
			"Built the web apps, backends and APIs end to end.",
			"Wrote and published the SDKs and CLIs developers use to bridge to and build on Zeko.",
			"Designed the infrastructure and migrated it to Cloudflare.",
			"Led the team's move to agentic development: Linear-based workflows from issue to merged PR, shared agent context, verification and review.",
			"Set up Sentry error reporting and the bug triage loop.",
			"Worked on OCaml protocol code, smart contracts and ZK circuits."
		],
		stack: ["TypeScript", "Nuxt", "Cloudflare", "OCaml", "ZK circuits", "Sentry", "Linear"],
		library: ["zeko"]
	},
	{
		company: "dcSpark",
		title: "Senior Software Engineer",
		start: "2024-08",
		end: "2025-01",
		location: "Remote · Contract",
		summary: "Joined as a contractor. My main mission was Zeko, where I then moved full time.",
		highlights: [],
		stack: []
	},
	{
		company: "Zeno",
		title: "Head of Engineering",
		start: "2023-11",
		end: "2024-08",
		location: "Dubai · Remote",
		summary:
			"Head of engineering at an early-stage startup building a gamified, interactive video learning platform. Hands-on: I designed the architecture and wrote most of the core codebase.",
		highlights: [
			"SvelteKit and GraphQL on Cloudflare (Pages, Workers, Durable Objects), with Postgres, Redis and KV.",
			"Video delivery through Bunny Stream, and a custom CI on GitHub Actions and Fly.io.",
			"Led the team, ran code and performance reviews, mentored junior developers and hired."
		],
		stack: ["SvelteKit", "GraphQL", "Cloudflare", "Postgres", "Redis", "Bunny Stream", "Fly.io"]
	},
	{
		company: "Nuxt",
		title: "Core Team",
		start: "2023-03",
		end: null,
		location: "Remote · Part-time",
		summary:
			"Nuxt core team. Most of my work is on Nitro, the server engine that Nuxt and several other frameworks run on, and its integration with AWS, Azure, Cloudflare, Vercel and Netlify.",
		highlights: [
			"Work at framework level reaches millions of developers and users.",
			"I also author and maintain community modules for Auth.js, Vue Query, form actions and server blocks."
		],
		stack: ["Nuxt", "Nitro", "Vue", "TypeScript"],
		library: [
			"nitro",
			"nuxt",
			"h3",
			"unjs",
			"authjs-nuxt",
			"form-actions-nuxt",
			"server-block-nuxt",
			"vue-query-nuxt"
		]
	},
	{
		company: "Obelisk Auditing",
		title: "Founder, Lead Engineer",
		start: "2021-03",
		end: "2024-08",
		location: "Worldwide",
		summary:
			"I started Obelisk to protect people from the security risks in crypto. I taught myself Solidity and began auditing EVM smart contracts on my own, and others soon joined. It grew into a remote team of 12 that audited more than 50 Web3 projects.",
		highlights: [
			"Led the audits and the team, with new clients every month.",
			"Built the company's web platform myself: website, blog and a monitoring tool that detects blockchain state changes.",
			"Alongside the audits, built trading bots, Discord bots, DeFi applications and smart contracts for clients."
		],
		stack: [
			"Solidity",
			"Foundry",
			"Hardhat",
			"Viem",
			"Rust",
			"React",
			"Vue",
			"Cloudflare Workers",
			"GraphQL",
			"Postgres"
		]
	},
	{
		company: "DeepCrawl",
		title: "Senior Software Engineer",
		start: "2020-08",
		end: "2021-04",
		location: "London",
		summary:
			"Technical SEO platform. Senior engineer across a TypeScript and GraphQL stack, working across several frontend teams.",
		highlights: [
			"A React application replacing a legacy AngularJS one.",
			"A Node.js backend on AWS, managed with the AWS CDK.",
			"A strong testing culture: Testing Library, Cypress, and Cucumber for BDD."
		],
		stack: ["TypeScript", "GraphQL", "React", "Node.js", "AWS CDK", "Cypress"]
	},
	{
		company: "POWSTER",
		title: "Full Stack Engineer",
		start: "2019-11",
		end: "2019-12",
		location: "London · Contract",
		summary: "Agency work for well-known brands.",
		highlights: [
			"The main project was a React application with an embedded WebAR game, backed by Node.js and Firebase, with queueing and email microservices, deployed to AWS with Terraform.",
			"I also built a REST layer on AWS API Gateway over an internal API, Twilio automations and production web work."
		],
		stack: ["React", "WebAR", "Node.js", "Firebase", "AWS", "Terraform", "Twilio"]
	},
	{
		company: "Tigerspike",
		title: "Full Stack Engineer",
		start: "2019-03",
		end: "2019-11",
		location: "London",
		summary: "Digital consultancy. Two projects, both serverless on AWS.",
		highlights: [
			"An IoT platform for one of the UK's main energy providers: device data over MQTT through AWS IoT Core, a fault-tolerant pipeline on SQS and Kinesis, a GraphQL API on Lambda and Apollo, a React frontend, and analytics in QuickSight.",
			"A Vue PWA with Lambda and Fargate microservices on DynamoDB, and a phone IVR built on Amazon Connect and Lex.",
			"Infrastructure in the AWS CDK, with a throwaway environment for every pull request."
		],
		stack: [
			"AWS Lambda",
			"AWS IoT Core",
			"Kinesis",
			"GraphQL",
			"React",
			"Vue",
			"DynamoDB",
			"AWS CDK"
		]
	},
	{
		company: "Yo-Da (your data)",
		title: "Full Stack Engineer",
		start: "2019-02",
		end: "2019-04",
		location: "London",
		summary:
			"Startup building a service that sends GDPR requests on a user's behalf. I led an overhaul of the whole architecture.",
		highlights: [
			"A TypeScript and Express API built test-first, with Postgres through Prisma.",
			"A React frontend, and Cognito for auth.",
			"Everything on AWS (ECS Fargate, Aurora, CloudFront), defined as code with Terraform and CloudFormation."
		],
		stack: ["TypeScript", "Express", "Postgres", "Prisma", "React", "AWS", "Terraform"]
	},
	{
		company: "The M Industries",
		title: "Full Stack Engineer",
		start: "2018-11",
		end: "2022-03",
		location: "London",
		summary:
			"My contracting company in London. Through it I delivered full-stack and cloud work for startups, agencies and consultancies, including Tigerspike, Powster and Yo-Da, each listed separately.",
		highlights: [],
		stack: []
	},
	{
		company: "Cognitive Credit",
		title: "Front-End Engineer",
		start: "2018-06",
		end: "2018-12",
		location: "London",
		summary:
			"Fintech startup using machine learning to read financial documents and turn them into structured data.",
		highlights: [
			"I built the main web app, a Vue PWA on a GraphQL and Postgres API.",
			"And a React back-office, inside a containerised AWS pipeline."
		],
		stack: ["Vue", "React", "GraphQL", "Postgres", "AWS"]
	},
	{
		company: "Stack Industries",
		title: "Full Stack Engineer",
		start: "2015-12",
		end: "2018-12",
		location: "Bordeaux",
		summary:
			"My contracting company in France. Through it I delivered full-stack web work for clients in and around Bordeaux, including Cohda, listed separately.",
		highlights: [],
		stack: []
	},
	{
		company: "Cohda",
		title: "Full Stack Developer",
		start: "2015-07",
		end: "2018-05",
		location: "Bordeaux",
		summary:
			"Built the company's intranet from nothing and ran it for three years, from renting and setting up the servers to the user experience. Used every day across the company.",
		highlights: [
			"Laravel REST APIs behind Vue and React frontends.",
			"Node.js realtime services over WebSockets.",
			"Integrations with Google APIs."
		],
		stack: ["Laravel", "Vue", "React", "Node.js", "WebSockets", "Linux"]
	},
	{
		company: "Ityka",
		title: "System Administrator",
		start: "2013-06",
		end: "2015-06",
		location: "France",
		summary:
			"Started as an internship during my studies. Ran the infrastructure of a small call centre end to end.",
		highlights: [
			"Cabling, switches, routers and servers.",
			"Linux, nginx and iptables configuration.",
			"The Asterisk phone system, with PHP."
		],
		stack: ["Linux", "nginx", "iptables", "Asterisk", "PHP"]
	}
]

export const education = [
	{
		school: "Supinfo",
		degree: "Computer science",
		start: "2013-09",
		end: "2015-06",
		location: "France",
		summary:
			"Computer science. My first job in the trade, at Ityka, started as an internship during these two years."
	}
]

/**
 * The year and month of a `YYYY-MM` string.
 *
 * Split here rather than destructured at the call: `noUncheckedIndexedAccess` types an
 * indexed element as possibly absent, so a destructure of `split("-")` gives
 * `number | undefined` for both halves and every use of them has to be guarded. One
 * parse with a fallback keeps the arithmetic below plain.
 */
const yearMonth = (value: string): { year: number; month: number } => {
	const [year, month] = value.split("-").map(Number)
	return { year: year ?? 0, month: month ?? 1 }
}

/** Months between two `YYYY-MM` strings, inclusive of the start month. */
export const monthsBetween = (start: string, end: string | null) => {
	const from = yearMonth(start)
	const to = yearMonth(end ?? currentMonth())
	return (to.year - from.year) * 12 + (to.month - from.month) + 1
}

export const currentMonth = () => {
	const now = new Date()
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
}

/** Whole years and leftover months, for labels like `4 yrs 2 mos`. */
export const formatDuration = (months: number) => {
	const years = Math.floor(months / 12)
	const rest = months % 12
	const parts: string[] = []
	if (years > 0) parts.push(`${years} yr${years === 1 ? "" : "s"}`)
	if (rest > 0) parts.push(`${rest} mo${rest === 1 ? "" : "s"}`)
	return parts.join(" ") || "1 mo"
}

/** `2022-03` as `Mar 2022`. */
export const formatMonth = (value: string | null) => {
	if (!value) return "Present"
	const { year, month } = yearMonth(value)
	return new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(
		new Date(year, month - 1, 1)
	)
}
