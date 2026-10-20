/**
 * The prompt's commands, over a small file system made of the site.
 *
 * It speaks the tools a developer already reaches for rather than a command set
 * of its own:
 *
 *   cd <dir>       open a section          ls [dir]      list a directory
 *   cat <file>     print a file            grep <pat>    search everything
 *   open [path]    open a page             pwd           print the directory
 *   theme [l|d]    switch the theme        mouse [on|off] the mouse gate
 *   help · clear · exit
 *
 * The directories are the sections; the files are the articles (`blog/<slug>.md`),
 * the projects (`library/<name>.txt`), the roles (`experience/<id>.txt`) and the
 * skills (`skills/<name>.md`, each printed as the `SKILL.md` it is written as).
 * Everything is answered from the index the layout reads through Flamme, which is
 * the bundle, so the prompt works with the network off.
 *
 * Pure: a command goes in, text and an action come out, and the component carries
 * the action out. That keeps the shell's behaviour testable without a DOM.
 */

export interface IndexArticle {
	readonly slug: string
	readonly title: string
	readonly description: string
	readonly date: string
	readonly tags: readonly string[]
	/** The article's text, one block to a line. */
	readonly body: readonly string[]
}

export interface IndexProject {
	readonly name: string
	readonly title: string
	readonly tagline: string
	readonly language: string
	readonly url: string
	readonly homepage: string | null
	readonly archived: boolean
	readonly shelf: string
}

export interface IndexSkill {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly whenToUse: readonly string[]
	readonly steps: readonly string[]
	readonly evidence: readonly string[]
}

export interface IndexRole {
	readonly id: string
	readonly title: string
	readonly company: string
	readonly start: string
	readonly end: string | null
	readonly summary: string
}

export interface TerminalIndex {
	readonly articles: readonly IndexArticle[]
	readonly projects: readonly IndexProject[]
	readonly roles: readonly IndexRole[]
	readonly skills: readonly IndexSkill[]
}

export type Action =
	| { readonly kind: "go"; readonly href: string }
	| { readonly kind: "open"; readonly url: string }
	| { readonly kind: "theme"; readonly theme: "light" | "dark" | "toggle" }
	| { readonly kind: "mouse"; readonly on: boolean }
	| { readonly kind: "clear" }
	| { readonly kind: "exit" }

export interface Result {
	readonly output: string
	readonly cwd: string
	readonly action?: Action
}

/** The sections, as the top-level directories. */
const DIRECTORIES: Record<string, { href: string; about: string }> = {
	home: { href: "/", about: "the front page" },
	library: { href: "/library", about: "the work, by shelf" },
	blog: { href: "/blog", about: "every article" },
	experience: { href: "/experience", about: "roles and education" },
	skills: { href: "/skills", about: "what can be asked for, as agent skills" }
}

export const COMMANDS = [
	"cd",
	"ls",
	"cat",
	"grep",
	"open",
	"pwd",
	"theme",
	"mouse",
	"help",
	"clear",
	"exit"
] as const

export const HELP = [
	"cd <dir>      open a section           ls [dir]       list a directory",
	"cat <file>    print a file             grep <pat>     search everything",
	"open [path]   open a page              pwd            print the directory",
	"theme [l|d]   switch the theme         mouse [on|off] the mouse gate",
	"help · clear · exit       Tab completes · ↑ ↓ history · Esc closes"
].join("\n")

/** The longest output the prompt shows; the rest is summarised rather than scrolled. */
export const MAX_LINES = 14

/** Normalise a path against the working directory, the way a shell would. */
export const resolvePath = (cwd: string, target: string): string => {
	const parts = target.startsWith("/") ? [] : cwd.split("/").filter(Boolean)
	for (const part of target.split("/")) {
		if (part === "" || part === ".") continue
		if (part === "..") parts.pop()
		else if (part === "~") parts.length = 0
		else parts.push(part)
	}
	return `/${parts.join("/")}`
}

const clip = (lines: readonly string[]): string => {
	if (lines.length <= MAX_LINES) return lines.join("\n")
	const shown = lines.slice(0, MAX_LINES - 1)
	return [...shown, `… ${lines.length - shown.length} more lines`].join("\n")
}

const roleFile = (role: IndexRole) => `${role.id}.txt`

/** The names in a directory, as `ls` prints them. */
const entries = (index: TerminalIndex, directory: string): string[] | null => {
	const clean = directory.replace(/^\/+|\/+$/g, "")
	if (clean === "") return Object.keys(DIRECTORIES).map((name) => `${name}/`)
	if (clean === "home") return []
	if (clean === "blog") return index.articles.map((article) => `${article.slug}.md`)
	if (clean === "library") return index.projects.map((project) => `${project.name}.txt`)
	if (clean === "experience") return index.roles.map(roleFile)
	if (clean === "skills") return index.skills.map((skill) => `${skill.name}.md`)
	return null
}

/**
 * What a path names: a directory, an article, a project, a role, or nothing.
 *
 * A bare file name is looked up in every directory, so `cat cssforge` works from
 * anywhere, the way a reader who has just seen the name would type it.
 */
const lookup = (index: TerminalIndex, cwd: string, target: string) => {
	const path = resolvePath(cwd, target).replace(/^\/+|\/+$/g, "")
	if (path === "" || path in DIRECTORIES)
		return { kind: "dir" as const, name: path === "" ? "/" : path }
	const parts = path.split("/")
	const name = (parts[parts.length - 1] ?? "").replace(/\.(md|txt)$/, "")
	const directory = parts.length > 1 ? parts[0] : ""
	const anywhere = directory === ""

	const article = index.articles.find((candidate) => candidate.slug === name)
	if (article && (anywhere || directory === "blog")) return { kind: "article" as const, article }
	const project = index.projects.find((candidate) => candidate.name === name)
	if (project && (anywhere || directory === "library")) return { kind: "project" as const, project }
	const skill = index.skills.find((candidate) => candidate.name === name)
	if (skill && (anywhere || directory === "skills")) return { kind: "skill" as const, skill }
	const role = index.roles.find((candidate) => candidate.id === name)
	if (role && (anywhere || directory === "experience")) return { kind: "role" as const, role }
	return null
}

const cat = (index: TerminalIndex, cwd: string, target: string): string => {
	if (target === "") return "cat: missing operand"
	const found = lookup(index, cwd, target)
	if (found === null) return `cat: ${target}: no such file`
	switch (found.kind) {
		case "dir":
			return `cat: ${target}: is a directory`
		case "article": {
			const { article } = found
			return clip([
				`# ${article.title}`,
				`${article.date}  ${article.tags.map((tag) => `#${tag}`).join(" ")}`,
				"",
				article.description,
				"",
				...article.body.slice(0, 6),
				"",
				`open blog/${article.slug}.md to read it`
			])
		}
		case "project": {
			const { project } = found
			return [
				project.title,
				`${project.language} · ${project.shelf}${project.archived ? " · archived" : ""}`,
				"",
				project.tagline,
				"",
				`source   ${project.url}`,
				...(project.homepage ? [`site     ${project.homepage}`] : []),
				"",
				`open library/${project.name}.txt to read it`
			].join("\n")
		}
		case "skill": {
			const { skill } = found
			return clip([
				"---",
				`name: ${skill.name}`,
				`description: ${skill.description}`,
				"---",
				`# ${skill.title}`,
				"## When to use",
				...skill.whenToUse.map((line) => `- ${line}`),
				"## Steps",
				...skill.steps.map((line, number) => `${number + 1}. ${line}`),
				"## Evidence",
				skill.evidence.map((name) => `library/${name}.txt`).join("  ")
			])
		}
		case "role": {
			const { role } = found
			return [
				`${role.title} · ${role.company}`,
				`${role.start} → ${role.end ?? "present"}`,
				"",
				role.summary
			].join("\n")
		}
		default:
			return ""
	}
}

const grep = (index: TerminalIndex, args: readonly string[]): string => {
	const namesOnly = args.includes("-l")
	const pattern = args.filter((arg) => !arg.startsWith("-")).join(" ")
	if (pattern === "") return "usage: grep [-l] <pattern>"
	let expression: RegExp
	try {
		expression = new RegExp(pattern, "i")
	} catch {
		return `grep: ${pattern}: invalid pattern`
	}

	const hits: string[] = []
	for (const article of index.articles) {
		const lines = [article.title, article.description, article.tags.join(" "), ...article.body]
		const matching = lines
			.map((line, number) => ({ line, number }))
			.filter(({ line }) => expression.test(line))
		if (matching.length === 0) continue
		const path = `blog/${article.slug}.md`
		if (namesOnly) hits.push(path)
		else {
			for (const { line, number } of matching.slice(0, 4)) {
				const at = line.search(expression)
				const start = Math.max(0, at - 24)
				const end = start + 64
				const snippet = `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`
				hits.push(`${path}:${number + 1}: ${snippet}`)
			}
		}
	}
	for (const project of index.projects) {
		const text = `${project.name} ${project.title} ${project.tagline} ${project.language} ${project.shelf}`
		if (!expression.test(text)) continue
		hits.push(
			namesOnly ? `library/${project.name}.txt` : `library/${project.name}.txt: ${project.tagline}`
		)
	}
	for (const skill of index.skills) {
		const text = [
			skill.name,
			skill.title,
			skill.description,
			...skill.whenToUse,
			...skill.steps
		].join(" ")
		if (!expression.test(text)) continue
		hits.push(
			namesOnly ? `skills/${skill.name}.md` : `skills/${skill.name}.md: ${skill.description}`
		)
	}
	for (const role of index.roles) {
		if (!expression.test(`${role.title} ${role.company} ${role.summary}`)) continue
		hits.push(
			namesOnly
				? `experience/${roleFile(role)}`
				: `experience/${roleFile(role)}: ${role.title}, ${role.company}`
		)
	}
	return hits.length > 0 ? clip(hits) : `grep: ${pattern}: no matches`
}

/** Run one line. */
export const run = (line: string, cwd: string, index: TerminalIndex): Result => {
	const [head = "", ...rest] = line.trim().split(/\s+/)
	const arg = rest.join(" ")

	switch (head) {
		case "":
			return { output: "", cwd }
		case "pwd":
			return { output: cwd, cwd }
		case "ls": {
			const target = resolvePath(cwd, arg || ".")
			const names = entries(index, target)
			if (names === null) {
				const found = lookup(index, cwd, arg)
				return { output: found ? arg : `ls: ${arg}: no such file or directory`, cwd }
			}
			return {
				output: names.length === 0 ? "" : clip([...names].sort((a, b) => a.localeCompare(b))),
				cwd
			}
		}
		case "cd": {
			if (arg === "") return { output: "→ /", cwd: "/", action: { kind: "go", href: "/" } }
			const target = resolvePath(cwd, arg)
			const name = target.replace(/^\/+|\/+$/g, "")
			if (name === "" || name === "home")
				return { output: "→ /", cwd: "/", action: { kind: "go", href: "/" } }
			const directory = DIRECTORIES[name]
			if (directory === undefined) {
				return {
					output: lookup(index, cwd, arg)
						? `cd: ${arg}: not a directory`
						: `cd: ${arg}: no such directory`,
					cwd
				}
			}
			return {
				output: `→ ${directory.href}`,
				cwd: target,
				action: { kind: "go", href: directory.href }
			}
		}
		case "cat":
			return { output: cat(index, cwd, arg), cwd }
		case "grep":
			return { output: grep(index, rest), cwd }
		case "open": {
			const found = lookup(index, cwd, arg || ".")
			if (found === null) return { output: `open: ${arg}: nothing to open`, cwd }
			switch (found.kind) {
				case "dir": {
					const href = found.name === "/" ? "/" : (DIRECTORIES[found.name]?.href ?? "/")
					return { output: `→ ${href}`, cwd, action: { kind: "go", href } }
				}
				case "article":
					return {
						output: `→ /blog/${found.article.slug}`,
						cwd,
						action: { kind: "go", href: `/blog/${found.article.slug}` }
					}
				case "project":
					return {
						output: `→ /library?open=${found.project.name}`,
						cwd,
						action: { kind: "go", href: `/library?open=${found.project.name}` }
					}
				case "role":
					return { output: "→ /experience", cwd, action: { kind: "go", href: "/experience" } }
				case "skill":
					return { output: "→ /skills", cwd, action: { kind: "go", href: "/skills" } }
				default:
					return { output: "", cwd }
			}
		}
		case "theme": {
			const choice = arg.startsWith("l") ? "light" : arg.startsWith("d") ? "dark" : "toggle"
			return {
				output: choice === "toggle" ? "theme switched" : `theme → ${choice}`,
				cwd,
				action: { kind: "theme", theme: choice }
			}
		}
		case "mouse": {
			const on = arg === "" ? true : !["off", "no", "0", "false"].includes(arg)
			return {
				output: on ? "mouse on for this visit" : "mouse off: keyboard only",
				cwd,
				action: { kind: "mouse", on }
			}
		}
		case "help":
			return { output: HELP, cwd }
		case "clear":
			return { output: "", cwd, action: { kind: "clear" } }
		case "exit":
		case "q":
			return { output: "", cwd, action: { kind: "exit" } }
		case "whoami":
			return { output: "a reader of emmanuel.style", cwd }
		case "date":
			return { output: new Date().toString(), cwd }
		default:
			return { output: `${head}: command not found. Try help.`, cwd }
	}
}

/**
 * Completion candidates for a partial line.
 *
 * The first word completes a command; later words complete a path, and the paths
 * offered depend on the command: `cd` and `ls` want directories, `cat` and `open`
 * want files too.
 */
export const complete = (line: string, cwd: string, index: TerminalIndex): string[] => {
	const words = line.split(/\s+/)
	const head = words[0] ?? ""
	const last = words[words.length - 1] ?? ""
	if (words.length === 1)
		return COMMANDS.filter((command) => command.startsWith(head) && command !== head)

	const directories = Object.keys(DIRECTORIES).map((name) => `${name}/`)
	const files = [
		...index.articles.map((article) => `blog/${article.slug}.md`),
		...index.projects.map((project) => `library/${project.name}.txt`),
		...index.roles.map((role) => `experience/${roleFile(role)}`),
		...index.skills.map((skill) => `skills/${skill.name}.md`)
	]
	const here = cwd.replace(/^\/+|\/+$/g, "")
	const local =
		here === ""
			? []
			: files
					.filter((file) => file.startsWith(`${here}/`))
					.map((file) => file.slice(here.length + 1))

	let pool: string[] = []
	if (head === "cd" || head === "ls") pool = [...directories, ".."]
	else if (head === "cat" || head === "open") pool = [...local, ...directories, ...files]
	else if (head === "theme") pool = ["light", "dark"]
	else if (head === "mouse") pool = ["on", "off"]

	return [...new Set(pool)].filter((item) => item.startsWith(last) && item !== last).slice(0, 8)
}
