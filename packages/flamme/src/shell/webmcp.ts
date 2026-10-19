/**
 * WebMCP: the site's tools, handed to an in-browser agent.
 *
 * WebMCP lets a page give an agent callable tools through `navigator.modelContext`
 * instead of leaving it to scrape the DOM. The API is an early preview and is
 * usually absent, so everything here is guarded: without it the site behaves
 * exactly as before.
 *
 * The tools mirror the prompt, because the prompt is already the site's real
 * interface: open a section, find and open an article, list the repositories,
 * turn the page, set the theme.
 */
import type { Router } from "vue-router"
import { SECTIONS } from "./sections.js"
import { applyTheme, type Shell } from "./shell.js"
import type { TerminalIndex } from "./terminal.js"

interface ToolResult {
	content: { type: "text"; text: string }[]
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

export const registerWebMcp = (shell: Shell, router: Router, index: () => TerminalIndex): void => {
	// The draft has moved the entry point from `navigator` to `document`; either is accepted.
	const context =
		(document as Document & { modelContext?: ModelContext }).modelContext ??
		(navigator as Navigator & { modelContext?: ModelContext }).modelContext
	if (context === undefined) return

	const tools: WebMcpTool[] = [
		{
			name: "list_sections",
			description: "List the sections of emmanuel.style with their URLs.",
			inputSchema: { type: "object", properties: {} },
			execute: () =>
				text(
					SECTIONS.map((section) => `${section.label} (${section.href}): ${section.dateline}`).join(
						"\n"
					)
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
						enum: SECTIONS.map((section) => section.label),
						description: "Section to open."
					}
				},
				required: ["section"]
			},
			execute: async (args) => {
				const section = SECTIONS.find(
					(candidate) => candidate.label === String(args["section"] ?? "")
				)
				if (section === undefined) return text(`No section named "${String(args["section"])}".`)
				await router.push(section.href)
				return text(`Opened ${section.href}`)
			}
		},
		{
			name: "list_articles",
			description: "List every published article with its slug, date and tags.",
			inputSchema: { type: "object", properties: {} },
			execute: () =>
				text(
					index()
						.articles.map(
							(article) =>
								`${article.slug}  ${article.date}  ${article.title}  [${article.tags.join(", ")}]`
						)
						.join("\n")
				)
		},
		{
			name: "search_articles",
			description: "Search the articles' titles, descriptions, tags and text.",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string", description: "Text to look for." } },
				required: ["query"]
			},
			execute: (args) => {
				const query = String(args["query"] ?? "").toLowerCase()
				const found = index().articles.filter((article) =>
					[
						article.slug,
						article.title,
						article.description,
						article.tags.join(" "),
						...article.body
					]
						.join("\n")
						.toLowerCase()
						.includes(query)
				)
				if (found.length === 0) return text(`Nothing matches "${query}".`)
				return text(
					found
						.map((article) => `${article.slug}  ${article.title}  /blog/${article.slug}`)
						.join("\n")
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
						enum: index().articles.map((article) => article.slug),
						description: "Article slug."
					}
				},
				required: ["slug"]
			},
			execute: async (args) => {
				const article = index().articles.find(
					(candidate) => candidate.slug === String(args["slug"] ?? "")
				)
				if (article === undefined) return text(`No article with slug "${String(args["slug"])}".`)
				await router.push(`/blog/${article.slug}`)
				return text(`Opened ${article.title}`)
			}
		},
		{
			name: "list_repositories",
			description: "List the open source repositories shown in the Library.",
			inputSchema: { type: "object", properties: {} },
			execute: () =>
				text(
					index()
						.repositories.map((repo) => `${repo.name}  ${repo.shelf}  ${repo.url}`)
						.join("\n")
				)
		},
		{
			name: "turn_page",
			description: "Turn the reading pane to the next or the previous page.",
			inputSchema: {
				type: "object",
				properties: { direction: { type: "string", enum: ["next", "previous"] } },
				required: ["direction"]
			},
			execute: async (args) => {
				if (shell.turner === null) return text("This page has nothing to turn.")
				const before = shell.position?.current ?? 1
				shell.turner.turn(args["direction"] === "previous" ? -1 : 1)
				// The turn commits inside a view transition, a frame or two later.
				for (let waited = 0; waited < 800 && shell.position?.current === before; waited += 50) {
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
				const position = shell.position
				return text(position ? `Page ${position.current} of ${position.total}.` : "Turned.")
			}
		},
		{
			name: "set_theme",
			description: "Switch the site between the light and the dark theme.",
			inputSchema: {
				type: "object",
				properties: { theme: { type: "string", enum: ["light", "dark"] } },
				required: ["theme"]
			},
			execute: (args) => {
				const theme = args["theme"]
				if (theme !== "light" && theme !== "dark") return text('theme must be "light" or "dark".')
				applyTheme(shell, theme)
				return text(`Theme set to ${theme}.`)
			}
		}
	]

	try {
		if (typeof context.provideContext === "function") {
			void context.provideContext({ tools })
			return
		}
		if (typeof context.registerTool === "function") {
			for (const tool of tools) void context.registerTool(tool)
		}
	} catch {
		// An early-preview API failing must never break the page.
	}
}
