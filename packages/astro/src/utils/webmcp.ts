import { go } from "./navigation"
import { pageReady } from "./pageReady"

/**
 * WebMCP.
 *
 * WebMCP lets a page hand an in-browser agent a set of callable tools via
 * `navigator.modelContext`, instead of the agent scraping the DOM. The API is
 * an early preview and is frequently absent, so everything here is guarded:
 * without the API the site behaves exactly as before.
 *
 * The tools mirror what the terminal can do, because the terminal is already
 * the site's real interface: open a section, find and open an article, list
 * what exists, and set the theme.
 */
interface ToolResult {
	content: Array<{ type: "text"; text: string }>
}

interface WebMcpTool {
	name: string
	description: string
	inputSchema: Record<string, unknown>
	execute: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult
}

interface ModelContext {
	provideContext?: (context: { tools: WebMcpTool[] }) => void | Promise<void>
	registerTool?: (tool: WebMcpTool) => void | Promise<void>
}

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] })

interface IndexArticle {
	slug: string
	title: string
	description: string
	tags: string[]
	href: string
}

interface IndexRepository {
	name: string
	description: string
	href: string
}

interface CommandIndex {
	routes: Array<{ label: string; href: string; description: string }>
	articles: IndexArticle[]
	repositories: IndexRepository[]
}

const readIndex = (): CommandIndex => {
	const node = document.getElementById("command-index")
	if (!node?.textContent) return { routes: [], articles: [], repositories: [] }
	try {
		return JSON.parse(node.textContent) as CommandIndex
	} catch {
		return { routes: [], articles: [], repositories: [] }
	}
}

const setTheme = (value: string) => {
	document.documentElement.classList.remove("LightTheme", "DarkTheme")
	document.documentElement.classList.add(value === "dark" ? "DarkTheme" : "LightTheme")
	try {
		localStorage.setItem("vueuse-color-scheme", value)
	} catch {
		// Ignore storage failures.
	}
}

export const registerWebMcpTools = () => {
	pageReady(() => {
		const modelContext = (navigator as Navigator & { modelContext?: ModelContext }).modelContext
		if (!modelContext) return

		const index = readIndex()

		const tools: WebMcpTool[] = [
			{
				name: "list_sections",
				description: "List the sections of emmanuel.style with their URLs.",
				inputSchema: { type: "object", properties: {} },
				execute: () =>
					text(
						index.routes
							.map((route) => `${route.label} (${route.href}): ${route.description}`)
							.join("\n")
					)
			},
			{
				name: "navigate",
				description: "Open a section of the site by name.",
				inputSchema: {
					type: "object",
					properties: {
						section: {
							type: "string",
							enum: index.routes.map((route) => route.label),
							description: "Section to open."
						}
					},
					required: ["section"]
				},
				execute: (args) => {
					const label = String(args.section ?? "")
					const route = index.routes.find((candidate) => candidate.label === label)
					if (!route) return text(`No section named "${label}".`)
					go(route.href)
					return text(`Opened ${route.href}`)
				}
			},
			{
				name: "list_articles",
				description: "List every published article with its slug, date and tags.",
				inputSchema: { type: "object", properties: {} },
				execute: () =>
					text(
						index.articles
							.map((article) => `${article.slug}  ${article.title}  [${article.tags.join(", ")}]`)
							.join("\n")
					)
			},
			{
				name: "search_articles",
				description: "Search articles by title, description or tag.",
				inputSchema: {
					type: "object",
					properties: { query: { type: "string", description: "Text to look for." } },
					required: ["query"]
				},
				execute: (args) => {
					const query = String(args.query ?? "").toLowerCase()
					const found = index.articles.filter((article) =>
						[article.slug, article.title, article.description, article.tags.join(" ")]
							.join(" ")
							.toLowerCase()
							.includes(query)
					)
					if (found.length === 0) return text(`Nothing matches "${query}".`)
					return text(
						found.map((article) => `${article.slug}  ${article.title}  ${article.href}`).join("\n")
					)
				}
			},
			{
				name: "open_article",
				description: "Open an article by its slug.",
				inputSchema: {
					type: "object",
					properties: {
						slug: {
							type: "string",
							enum: index.articles.map((article) => article.slug),
							description: "Article slug."
						}
					},
					required: ["slug"]
				},
				execute: (args) => {
					const slug = String(args.slug ?? "")
					const article = index.articles.find((candidate) => candidate.slug === slug)
					if (!article) return text(`No article with slug "${slug}".`)
					go(article.href)
					return text(`Opened ${article.title}`)
				}
			},
			{
				name: "list_repositories",
				description: "List the open source repositories shown in the Library.",
				inputSchema: { type: "object", properties: {} },
				execute: () =>
					text(index.repositories.map((repo) => `${repo.name}  ${repo.href}`).join("\n"))
			},
			{
				name: "set_theme",
				description: "Switch the site between the light and dark theme.",
				inputSchema: {
					type: "object",
					properties: { theme: { type: "string", enum: ["light", "dark"] } },
					required: ["theme"]
				},
				execute: (args) => {
					const theme = String(args.theme ?? "")
					if (theme !== "light" && theme !== "dark") return text('theme must be "light" or "dark".')
					setTheme(theme)
					return text(`Theme set to ${theme}.`)
				}
			}
		]

		try {
			if (typeof modelContext.provideContext === "function") {
				void modelContext.provideContext({ tools })
				return
			}
			if (typeof modelContext.registerTool === "function") {
				for (const tool of tools) void modelContext.registerTool(tool)
			}
		} catch {
			// An early-preview API failing must never break the page.
		}
	})
}
