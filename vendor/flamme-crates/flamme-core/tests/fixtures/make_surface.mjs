/**
 * Materializes the surface fixture project for the Rust extraction parity test.
 *
 * It mirrors `createSurfaceProject()` in `packages/core/test/fixtures.ts` (a `.vue`
 * with two script blocks, a `.vue` with a tag, a `.ts` with `graphql("…")`, a `.gql`
 * file, an unbound `graphql` local, a `.gql` import from a `.ts`) and extends it
 * with the rest of the extraction surfaces the port must reproduce: template
 * escapes and CRLF, astral characters, `<script src>`, TSX/JSX, `GraphQL<…>`,
 * aliased/namespace/require imports, the `+page.ts`/`+layout.ts` page-module
 * cases (FLM1028/FLM1029/FLM1030) and the SFC error shapes.
 *
 *   node crates/flamme-core/tests/fixtures/make_surface.mjs
 *
 * The fixture is checked in; this script only regenerates it.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const TARGET = join(HERE, 'surface');

const INFO_QUERY = `query Info($id: Int! = 1) @loading {
\tspecies(id: $id, delay: 500) {
\t\tid
\t\tname
\t}
}
`;
const SPRITE_FRAGMENT = `fragment SpriteInfo on Species @loading {
\tname
\tsprites {
\t\tfront
\t}
}
`;
const SPECIES_FRAGMENT = `fragment SpeciesPreview on Species @loading {
\tname
\tid
}
`;
const FAVORITE_FRAGMENT = `fragment FavoritePreview on Species @loading {
\tid
\tname
}
`;
const MOVE_FRAGMENT = `fragment MoveDisplay on SpeciesMove @loading {
\tlearned_at
\tmethod
}
`;
const TOGGLE_MUTATION = `mutation ToggleFavorite($id: Int!) {
\ttoggleFavorite(id: $id) {
\t\tspecies {
\t\t\tid
\t\t}
\t}
}
`;

/** A `.vue` component whose `<script setup>` declares one fragment. */
function componentWithTag(name, document) {
  return `<script setup lang="ts">
import { graphql } from '$flamme'
import { ${name} } from '$flamme'

const document = graphql\`${document}\`
</script>

<template>
  <div>{{ document.name }}</div>
</template>
`;
}

/** The `.ts` file a `.vue`'s `<script src>` block points at (and the walk reads too). */
const SHARED_SCRIPT = `import { graphql } from '$flamme'

export const shared = graphql\`${MOVE_FRAGMENT}\`
`;

const TWO_DOCUMENTS = `import { graphql } from '$flamme'

export const Page = graphql\`query Alpha { favorites { id } }\`
export const Other = graphql\`query Beta { favorites { id } }\`
`;

const files = {
  'flamme.config.json': `${JSON.stringify(
    {
      schemaPath: './server/schema.graphql',
      url: '/graphql',
      include: ['src/**/*.{vue,ts,tsx,js,jsx,graphql,gql}'],
      exclude: ['server/schema.graphql', 'src/other/**'],
      types: { SpeciesMove: { keys: ['name'] } },
    },
    null,
    2,
  )}\n`,
  'server/schema.graphql': await readFile(
    join(REPO, 'apps/pokedex/server/schema.graphql'),
    'utf8',
  ),

  // -- `.gql` documents -------------------------------------------------------
  'src/routes/+page.gql': INFO_QUERY,
  'src/other/Outside.gql': MOVE_FRAGMENT,
  'src/shared/page-query.gql': `query SharedPage {
\tfavorites {
\t\tid
\t}
}
`,
  // A document that fails to parse: at a bad token (with an escape before it, so
  // the position has to map through `sourceOffsets`) and at the file's end.
  'src/broken-tag.ts': `import { graphql } from '$flamme'

export const mid = graphql\`query BrokenMid {
\tfavorites @list(name: "a\\tb") {
\t\t???
\t}
}\`

export const tail = graphql\`query BrokenTail {
\tfavorites {
\t\tid
\t}
\`
`,
  'src/broken.gql': `query BrokenGql {
\tfavorites {
}
`,
  'src/multi.gql': `query First { favorites { id } }\nquery Second { favorites { id } }\n`,
  'src/empty.gql': '\n',

  // -- `.vue` surfaces --------------------------------------------------------
  'src/components/Both.vue': `<script setup lang="ts">
import { graphql } from '$flamme'

const setup = graphql\`${SPRITE_FRAGMENT}\`
</script>

<script lang="ts">
import { graphql } from '$flamme'

export const plain = graphql\`${SPECIES_FRAGMENT}\`
</script>

<template>
  <div />
</template>
`,
  // The plain block comes first in the file: the oracle scans `<script setup>`
  // first, and the two unbound tags make that order observable.
  'src/components/PlainFirst.vue': `<script lang="ts">
const plain = graphql\`query PlainUnbound { nope }\`
</script>

<script setup lang="ts">
const setup = graphql\`query SetupUnbound { nope }\`
</script>

<template>
  <div />
</template>
`,
  'src/components/Tagged.vue': `<script setup lang="ts">
import { graphql } from '$flamme'

const fragment = graphql\`${FAVORITE_FRAGMENT}\`
</script>

<template>
  <div>{{ graphql\`query NotScanned { nope }\` }}</div>
</template>

<style scoped>
div {
  color: red;
}
</style>
`,
  // A `graphql("…")` call inside a `.vue`: the document's surface is `script`.
  'src/components/Called.vue': `<script setup lang="ts">
import { graphql } from '$flamme'

const fragment = graphql(${JSON.stringify(FAVORITE_FRAGMENT)})
</script>

<template>
  <div>{{ fragment.name }}</div>
</template>
`,
  // A block with no `lang`: the compiler's `blockLang` answers `js`.
  'src/components/NoLang.vue': `<script>
import { graphql } from '$flamme'

const fragment = graphql\`${SPECIES_FRAGMENT}\`
</script>

<template>
  <div>{{ fragment.name }}</div>
</template>
`,
  // A `<script>` inside a `<template>` is template content, not a block.
  'src/components/Nested.vue': `<template>
  <div><script>const a = 1</script></div>
</template>

<script setup lang="ts">
import { graphql } from '$flamme'

const fragment = graphql\`${SPECIES_FRAGMENT}\`
</script>
`,
  // Tokenizer-level shapes: an XML declaration outside XML, a duplicate
  // attribute, `<style vars>` and `<template functional>`.
  'src/components/XmlDecl.vue': `<?xml version="1.0"?>

<script setup lang="ts">
const a = 1
</script>
`,
  'src/components/DuplicateAttr.vue': `<script setup lang="ts" lang="js">
const a = 1
</script>
`,
  'src/components/StyleVars.vue': `<style vars>
div {
  color: red;
}
</style>

<script setup lang="ts">
const a = 1
</script>
`,
  'src/components/FunctionalTemplate.vue': `<template functional>
  <div />
</template>

<script setup lang="ts">
const a = 1
</script>
`,
  // A closing tag with nothing open, and a template whose child never closes.
  'src/components/StrayClose.vue': `</div>

<script setup lang="ts">
const a = 1
</script>
`,
  'src/components/UnclosedTemplate.vue': `<template><div></template>

<script setup lang="ts">
const a = 1
</script>
`,
  'src/components/Query.vue': `<script setup lang="ts">
import { graphql } from '$flamme'

const page = graphql\`query ComponentQuery { favorites { id } }\`
</script>

<template>
  <div />
</template>
`,
  'src/components/SrcScript.vue': `<script lang="ts" src="../shared/script.ts"></script>

<template>
  <div />
</template>
`,
  'src/components/Empty.vue': `<script setup lang="ts">
</script>

<template>
  <div />
</template>
`,
  'src/components/NoScript.vue': `<template>
  <div />
</template>
`,
  'src/components/Broken.vue': `<script setup lang="ts">
const a = 1
`,
  'src/components/SetupSrc.vue': `<script setup lang="ts" src="../shared/script.ts"></script>

<template>
  <div />
</template>
`,
  'src/components/MultipleScripts.vue': `<script lang="ts">
const a = 1
</script>

<script lang="ts">
const b = 2
</script>

<template>
  <div />
</template>
`,
  'src/components/Unbound.vue': `<script setup lang="ts">
const fragment = graphql\`query UnboundInComponent { nope }\`
</script>

<template>
  <div />
</template>
`,

  // -- `.ts` surfaces ---------------------------------------------------------
  'src/mutations/toggle.ts': `import { graphql } from '$flamme'\n\nexport const ToggleFavorite = graphql(${JSON.stringify(TOGGLE_MUTATION)})\n`,
  'src/unbound.ts':
    'const graphql = (value: string): string => value\n\nexport const notADocument = graphql(`query Local { nope }`)\n\nexport const tag = graphql`query AlsoLocal { nope }`\n',
  'src/outside-import.ts': "import Outside from './other/Outside.gql'\nimport Missing from './outside/Outside.gql'\n\nexport const both = [Outside, Missing]\n",
  'src/alias.ts': `import { graphql as gql } from '$flamme'

export const aliased = gql\`${SPECIES_FRAGMENT}\`

export const shadowed = graphql\`query Shadowed { nope }\`
`,
  'src/require.ts': `const { graphql } = require('$flamme')

export const required = graphql\`${SPECIES_FRAGMENT}\`
`,
  'src/namespace.ts': `import * as flamme from '$flamme'

export const namespace = flamme.graphql\`query Namespaced { favorites { id } }\`
`,
  'src/other-import.ts': `import { graphql } from 'somewhere-else'

export const foreign = graphql\`query Foreign { nope }\`
`,
  'src/wrapped.ts': `import { graphql } from '$flamme'
import type { DocumentNode } from 'graphql'

export const plain = graphql\`${SPECIES_FRAGMENT}\`
export const asserted = graphql\`${SPECIES_FRAGMENT}\` as DocumentNode
export const satisfied = graphql\`${SPECIES_FRAGMENT}\` satisfies DocumentNode
export const parenthesized = (graphql\`${SPECIES_FRAGMENT}\`)
export const called = (graphql)(${JSON.stringify(SPECIES_FRAGMENT)})
export const annotated: DocumentNode = graphql\`${SPECIES_FRAGMENT}\`
`,
  'src/graphql-type.ts': `import type { DocumentNode } from 'graphql'

interface Props {
  fragment: GraphQL<\`${SPECIES_FRAGMENT}\`>
}

type Alias = GraphQL<\`${SPECIES_FRAGMENT}\`>
type Bare = GraphQL

export type { Props, Alias, Bare }
`,
  // Every shape of `graphql(…)` that is not one static string.
  'src/bad-call.ts': `import { graphql } from '$flamme'

const name = 'x'

export const none = graphql()
export const two = graphql('a', 'b')
export const notStatic = graphql(name)
export const dynamic = graphql(\`query Dynamic { \${name} }\`)
`,
  'src/nested.ts': `import { graphql } from '$flamme'

export const nested = {
  deep: [() => ({ value: graphql\`${SPECIES_FRAGMENT}\` })],
}

export function make() {
  return graphql\`query Made { favorites { id } }\`
}
`,
  'src/emoji.ts': `// 🐙 a comment before the tag shifts UTF-16 offsets from byte offsets
import { graphql } from '$flamme'

export const emoji = graphql\`query Emoji { favorites @list(name: "🐙") { id } }\`
`,
  // The file carries the escapes verbatim: `\t`/`\u0041`/`\x42`/`\$` cook to
  // TAB/A/B/$, `\\\\` cooks to a GraphQL `\\` escape and `` \` `` cooks to a
  // backtick. The second tag is a line-continuation test.
  'src/escapes.ts': `import { graphql } from '$flamme'

export const escaped = graphql\`query Escaped {
\tfavorites @list(name: "a\\tb\\\\\\\\c\\\`d\\u0041\\x42\\$e") {
\t\tid
\t}
}\`

export const continued = graphql\`query Continued { \\
\tfavorites { id } \\
}\`
`,
  'src/crlf.ts': [
    "import { graphql } from '$flamme'",
    '',
    'export const crlf = graphql`query Crlf {',
    '\tfavorites {',
    '\t\tid',
    '\t}',
    '}`',
    '',
  ].join('\r\n'),

  // -- `.tsx` / `.js` ---------------------------------------------------------
  'src/tsx/Component.tsx': `import { graphql } from '$flamme'

const fragment = graphql\`${SPECIES_FRAGMENT}\`

export function Component() {
  return <div>{fragment.name}</div>
}
`,
  'src/plain.js': `import { graphql } from '$flamme'

export const plain = graphql\`${SPECIES_FRAGMENT}\`
`,

  // -- the `+page.ts` / `+layout.ts` surface ----------------------------------
  'src/shared/script.ts': SHARED_SCRIPT,
  'src/shared/two.ts': TWO_DOCUMENTS,
  'src/pages/ok/+page.ts': `import { graphql } from '$flamme'

export const Page = graphql\`query OkPage { favorites { id } }\`
`,
  'src/pages/alias/+page.ts': `import { graphql } from '$flamme'

const Doc = graphql\`query AliasPage { favorites { id } }\`
const Also = Doc

export const Page = Also
`,
  'src/pages/wrapped/+page.ts': `import { graphql } from '$flamme'

export const Page = (graphql\`query WrappedPage { favorites { id } }\`)
`,
  'src/pages/imported/+page.ts': "import { Page } from '../../shared/page-query.gql'\n\nexport { Page }\n",
  // No extension: the specifier probes `.ts`, `.tsx`, … in order.
  'src/pages/probed/+page.ts': "import { Page } from '../../shared/script'\n\nexport { Page }\n",
  // Outside the pages directory: the convention does not apply, so no diagnostic.
  'src/elsewhere/+page.ts': 'export const notPage = 1\n',
  'src/pages/named/+page.ts': "import { AlphaDocument } from '../../shared/two'\n\nexport { AlphaDocument as Page }\n",
  'src/pages/ambiguous/+page.ts': "import { Nope } from '../../shared/two'\n\nexport const Page = Nope\n",
  'src/pages/missing/+page.ts': "export const notPage = 1\n",
  'src/pages/bad/+page.ts': 'export const Page = 42\n',
  'src/pages/reexport/+page.ts': "export { Page } from '../../shared/page-query.gql'\n",
  'src/pages/typed/+page.ts': `import { graphql } from '$flamme'
import type { DocumentNode } from 'graphql'

export const Page = graphql\`query TypedPage { favorites { id } }\` satisfies DocumentNode
`,
  'src/pages/collide/+page.ts': 'export const notPage = 1\n',
  'src/pages/collide/+page.gql': 'query CollidePage { favorites { id } }\n',
  'src/pages/layout/+layout.ts': 'export const notPage = 1\n',
  'src/pages/layout/+layout.gql': 'query LayoutPage { favorites { id } }\n',
};

await rm(TARGET, { recursive: true, force: true });
for (const [relative, content] of Object.entries(files)) {
  const absolute = join(TARGET, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}
process.stdout.write(`wrote ${Object.keys(files).length} files to ${TARGET}\n`);
