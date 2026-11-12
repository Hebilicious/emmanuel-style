/**
 * The faces, cut down for the web.
 *
 * Nabla ships every glyph it has, with an SVG copy of each beside its COLRv1
 * layers: 1.6 MB, all of it precached by the service worker. The site sets Latin
 * text only, and a browser that cannot draw COLRv1 skips Nabla altogether (the
 * `tech(color-COLRv1)` hint in `fonts.css`), so the subset keeps Basic Latin,
 * Latin-1 and the typographic punctuation, drops the SVG table, and keeps both
 * variation axes and every palette. Monaspace is only re-wrapped as WOFF2.
 *
 * The sources live in `assets/fonts`, which is not served; the outputs in
 * `public/fonts` are committed, so a build needs no font tooling. Run by hand
 * when a face changes, with uv on the path:
 *
 *   pnpm --filter @emmanuel/flamme run fonts
 */

import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const here = fileURLToPath(new URL(".", import.meta.url))
const SOURCES = join(here, "..", "assets", "fonts")
const TARGET = join(here, "..", "public", "fonts")

/** Basic Latin, Latin-1, Œœ, the dashes, the quotes, the bullet and ellipsis, primes, guillemets, €, and the arrows. */
const LATIN =
	"U+0020-007E,U+00A0-00FF,U+0152-0153,U+2013-2014,U+2018-201E,U+2022,U+2026,U+2032-2033,U+2039-203A,U+20AC,U+2190,U+2192"

const subset = (source: string, target: string, unicodes: string, extra: string[] = []) => {
	execFileSync(
		"uvx",
		[
			"--from",
			"fonttools[woff]",
			"pyftsubset",
			join(SOURCES, source),
			`--unicodes=${unicodes}`,
			"--layout-features=*",
			"--flavor=woff2",
			...extra,
			`--output-file=${join(TARGET, target)}`
		],
		{ stdio: "inherit" }
	)
	const before = statSync(join(SOURCES, source)).size
	const after = statSync(join(TARGET, target)).size
	console.log(
		`${source.padEnd(30)} ${(before / 1024).toFixed(0).padStart(6)} KB -> ${(after / 1024).toFixed(0).padStart(4)} KB`
	)
}

subset("Nabla[EDPT,EHLT].ttf", "Nabla.woff2", LATIN, ["--drop-tables+=SVG"])
for (const weight of ["Regular", "Medium", "Bold"]) {
	subset(`MonaspaceArgon-${weight}.otf`, `MonaspaceArgon-${weight}.woff2`, "*")
}
