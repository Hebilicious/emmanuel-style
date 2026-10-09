/**
 * Writes the SDL the Flamme compiler validates documents against.
 *
 * Pothos is the definition; this file is generated from it so there is nothing to
 * keep in sync by hand. `pnpm --filter @emmanuel/schema emit` runs it, and the
 * site's build depends on the output.
 */

import { writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { printSchema } from "graphql"
import schema from "./index.ts"

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(here, "../schema.graphql")

writeFileSync(
	target,
	`# Generated from packages/schema/src/index.ts. Do not edit by hand.\n#\n# \`pnpm --filter @emmanuel/schema emit\` writes it; the site's Flamme compiler\n# validates every document against it.\n\n${printSchema(schema)}\n`
)

console.log(`schema: wrote ${target}`)
