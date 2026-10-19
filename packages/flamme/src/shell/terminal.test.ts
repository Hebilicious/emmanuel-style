import { describe, expect, it } from "vitest"
import { complete, resolvePath, run, type TerminalIndex } from "./terminal.ts"

const index: TerminalIndex = {
	articles: [
		{
			slug: "hyper-anabasis",
			title: "How Europe Falters",
			description: "Philosophy and science.",
			date: "2025-10-25",
			tags: ["philosophy"],
			body: ["Plato provides a key example.", "Newton's clockwork universe."]
		}
	],
	repositories: [
		{
			name: "cssforge",
			description: "Generate CSS variables from design tokens.",
			language: "TypeScript",
			url: "https://github.com/Hebilicious/cssforge",
			homepage: null,
			archived: false,
			shelf: "Tooling"
		}
	],
	roles: [
		{
			id: "acme-2020-01",
			title: "Engineer",
			company: "Acme",
			start: "2020-01",
			end: null,
			summary: "Built things."
		}
	]
}

describe("terminal", () => {
	it("resolves paths like a shell", () => {
		expect(resolvePath("/blog", "..")).toBe("/")
		expect(resolvePath("/", "blog/./x.md")).toBe("/blog/x.md")
		expect(resolvePath("/library", "/blog")).toBe("/blog")
	})

	it("lists directories and opens sections", () => {
		expect(run("ls", "/", index).output).toBe("blog/\nexperience/\nhome/\nlibrary/")
		expect(run("ls blog", "/", index).output).toBe("hyper-anabasis.md")
		expect(run("cd library", "/", index)).toMatchObject({
			cwd: "/library",
			action: { kind: "go", href: "/library" }
		})
		expect(run("cd nowhere", "/", index).output).toBe("cd: nowhere: no such directory")
	})

	it("prints files and finds them by bare name", () => {
		expect(run("cat cssforge", "/", index).output).toContain("Generate CSS variables")
		expect(run("cat hyper-anabasis.md", "/blog", index).output).toContain("# How Europe Falters")
		expect(run("cat blog", "/", index).output).toBe("cat: blog: is a directory")
	})

	it("opens an article through the router and a repository in a new tab", () => {
		expect(run("open blog/hyper-anabasis.md", "/", index).action).toEqual({
			kind: "go",
			href: "/blog/hyper-anabasis"
		})
		expect(run("open cssforge", "/", index).action).toEqual({
			kind: "open",
			url: "https://github.com/Hebilicious/cssforge"
		})
	})

	it("searches article text, repositories and roles", () => {
		expect(run("grep clockwork", "/", index).output).toBe(
			"blog/hyper-anabasis.md:5: Newton's clockwork universe."
		)
		expect(run("grep -l tokens", "/", index).output).toBe("library/cssforge.txt")
		expect(run("grep zzz", "/", index).output).toBe("grep: zzz: no matches")
	})

	it("completes commands, then paths", () => {
		expect(complete("gr", "/", index)).toEqual(["grep"])
		expect(complete("cd li", "/", index)).toEqual(["library/"])
		expect(complete("cat blog/h", "/", index)).toEqual(["blog/hyper-anabasis.md"])
		expect(complete("cat h", "/blog", index)).toEqual(["hyper-anabasis.md", "home/"])
	})
})
