/**
 * The article images, re-encoded for the screen.
 *
 * The sources in `packages/astro/src/assets/images` are print scans of up to five
 * megabytes each, and the service worker precaches every image so an article reads
 * offline: served as they are, the precache was over fifteen megabytes. Each one is
 * written to `public/images` as a WebP no longer than `MAX_EDGE` on its long side,
 * which is sharp on a 2x screen at column width and in the full-screen viewer.
 *
 * This shells out to ImageMagick (`magick`) and is run by hand when an image is
 * added, not on every build: the outputs are committed, so a build needs no image
 * tooling and is the same on every machine.
 *
 *   pnpm --filter @emmanuel/flamme run images
 */

import { execFileSync } from "node:child_process"
import { readdirSync, statSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const SOURCES = join(here, "..", "..", "astro", "src", "assets", "images")
/** The portrait has no copy in the Astro assets; its source is kept beside this package, unserved. */
const PORTRAIT = join(here, "..", "assets", "images", "Profile.png")
const TARGET = join(here, "..", "public", "images")

/** The long edge, in pixels. */
const MAX_EDGE = 2000
const QUALITY = 80

const encode = (source: string, target: string, edge: number) => {
	execFileSync("magick", [
		source,
		"-auto-orient",
		"-strip",
		"-resize",
		`${edge}x${edge}>`,
		"-quality",
		String(QUALITY),
		"-define",
		"webp:method=6",
		target
	])
	const before = statSync(source).size
	const after = statSync(target).size
	console.log(
		`${basename(source).padEnd(44)} ${(before / 1024).toFixed(0).padStart(6)} KB -> ${(after / 1024).toFixed(0).padStart(5)} KB`
	)
}

for (const name of readdirSync(SOURCES).sort()) {
	if (!/\.(jpe?g|png|webp)$/i.test(name)) continue
	const stem = basename(name, extname(name))
	encode(join(SOURCES, name), join(TARGET, `${stem}.webp`), MAX_EDGE)
}

// The front-page portrait is shown at a few hundred pixels at most.
encode(PORTRAIT, join(TARGET, "Profile.webp"), 480)
