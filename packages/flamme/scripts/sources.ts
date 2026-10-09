/**
 * Front matter, and the images the markdown points at.
 *
 * Both are file-system concerns rather than rendering ones, so they live away
 * from the splitter: the splitter only ever sees a tree and a string.
 */

import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"

/** Resolve a relative path against a directory, not the process's cwd. */
export const relativeTo = (from: string, ...segments: string[]) => resolve(from, ...segments)

export interface FrontMatter {
	title: string
	description: string
	publishDate: string
	tags: string[]
	draft: boolean
}

/**
 * Split `---` delimited YAML from the markdown body.
 *
 * Only what the content model reads is required; anything else in the block is
 * carried along untouched so a new key in an article does not break the build.
 */
export const parseFrontMatter = (source: string): { data: Record<string, unknown>; body: string } => {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
	if (!match) throw new Error("markdown file has no front matter block")

	const data = parseYaml(match[1] ?? "") as Record<string, unknown> | null
	if (!data || typeof data !== "object") throw new Error("front matter is not a YAML mapping")

	return { data, body: source.slice(match[0].length) }
}

export const readFrontMatter = (data: Record<string, unknown>): FrontMatter => {
	const string = (key: string, fallback = ""): string => {
		const value = data[key]
		if (value === undefined || value === null) return fallback
		if (value instanceof Date) return value.toISOString().slice(0, 10)
		return String(value)
	}

	const tags = data.tags
	return {
		title: string("title"),
		description: string("description"),
		publishDate: string("publishDate"),
		tags: Array.isArray(tags) ? tags.map(String) : [],
		draft: data.draft === true
	}
}

/** The last segment of a path, without its extension: `hyper-anabasis`. */
export const slugOf = (file: string) => basename(file).replace(/\.md$/, "")

/**
 * The images a markdown file references, keyed by the relative path it wrote.
 *
 * The article writes `../../assets/images/x.jpg`, which is a path relative to the
 * markdown file and means nothing to a browser. The site serves the same files
 * from `/images`, so the rewrite is a basename lookup, and a file that is not
 * there is a build failure rather than a broken image on a page. `publicDir` is
 * the directory the URL resolves to, so callers pass `public/images`.
 */
export const resolveImages = (markdown: string, imagesDir: string): Map<string, string> => {
	const rewrites = new Map<string, string>()
	const pattern = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
	const missing: string[] = []

	for (const match of markdown.matchAll(pattern)) {
		// `noUncheckedIndexedAccess` types a capture group as possibly absent, so it is
		// read with a fallback rather than assumed.
		const source = match[1] ?? ""
		if (source === "") continue
		if (/^[a-z]+:\/\//i.test(source) || source.startsWith("data:")) continue
		if (rewrites.has(source)) continue

		const name = basename(source)
		const target = join(imagesDir, name)
		if (!existsSync(target)) {
			missing.push(`${source} (looked for ${target})`)
			continue
		}
		rewrites.set(source, `/images/${name}`)
	}

	if (missing.length > 0) {
		throw new Error(`markdown references images that are not served:\n  ${missing.join("\n  ")}`)
	}

	return rewrites
}

/** Read a file as UTF-8, with the path in the error when it is not there. */
export const readText = async (path: string) => {
	try {
		return await readFile(path, "utf8")
	} catch (cause) {
		throw new Error(`cannot read ${path}`, { cause })
	}
}

/** Everything under `dir` whose name ends in `.md`, sorted. */
export const markdownFiles = async (dir: string): Promise<string[]> => {
	const entries = await readdir(dir, { withFileTypes: true })
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => join(dir, entry.name))
		.sort()
}
