/**
 * The build, then the precache manifest the service worker reads.
 *
 * One script rather than a chain, because the manifest has to list what `vite build`
 * produced and nothing else can know that: the chunk names are content-hashed, so a
 * manifest written before the build would name files that no longer exist.
 *
 * Routes are prerendered as a directory each so any static host serves them, which is
 * also what lets the worker answer a navigation from the cache by path.
 *
 * Run with `pnpm --filter @emmanuel/flamme run build`.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite"

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, "..")
const dist = join(appDir, "dist")

/** Every file under `dir`, as paths relative to it. */
const walk = async (dir: string): Promise<string[]> => {
	const entries = await readdir(dir, { withFileTypes: true })
	const found: string[] = []
	for (const entry of entries) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) found.push(...(await walk(full)))
		else found.push(relative(dist, full))
	}
	return found
}

/**
 * The routes to prerender, one directory each.
 *
 * The article routes come from the generated content module itself, so a new post is
 * prerendered without this list changing. Reading the module rather than scanning its
 * text matters: a regex over the file also matches a shelf's slug, which produced
 * `/blog/modules` and friends, routes that do not exist.
 */
const routes = async (): Promise<string[]> => {
	const content = (await import("../.content/content.ts")) as {
		posts: readonly { slug: string }[]
	}
	return [
		"/",
		"/library",
		"/blog",
		"/experience",
		...content.posts.map((post) => `/blog/${post.slug}`)
	]
}

const main = async (): Promise<void> => {
	await build({ root: appDir, configFile: join(appDir, "vite.config.ts") })

	/*
	 * Every route gets its own `index.html`.
	 *
	 * The app is a single-page app, so `vite build` writes one document. It is copied
	 * into a directory per route, which is what makes a deep link work on a static
	 * host and what the service worker matches a navigation against.
	 */
	const shell = await readFile(join(dist, "index.html"), "utf8")
	const all = await routes()
	for (const route of all) {
		// `/` is `dist/index.html` itself; removing `dist` here would delete the assets
		// the rest of the build just wrote.
		if (route === "/") continue
		const target = join(dist, route)
		await rm(target, { recursive: true, force: true })
		await mkdir(target, { recursive: true })
		await writeFile(join(target, "index.html"), shell)
	}

	const files = await walk(dist)
	const urls = files.map((file) => `/${file}`).filter((url) => url !== "/precache-manifest.json")

	/*
	 * The cache name carries a hash of the file list, so a new build installs a new
	 * cache and the activate step deletes the previous one. Without it a returning
	 * reader keeps last build's HTML against this build's chunks.
	 */
	const { createHash } = await import("node:crypto")
	const cache = `emmanuel-${createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12)}`

	await writeFile(
		join(dist, "precache-manifest.json"),
		`${JSON.stringify({ cache, urls }, null, "\t")}\n`
	)

	const total = (await Promise.all(files.map(async (file) => (await stat(join(dist, file))).size)))
		.reduce((sum, size) => sum + size, 0)

	console.log(
		`prerendered ${all.length} routes, precached ${urls.length} files ` +
			`(${(total / 1024 / 1024).toFixed(2)} MB) as ${cache}`
	)
}

await main()
