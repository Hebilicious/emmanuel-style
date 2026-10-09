/**
 * Materializes the PoC fixture project for the Rust tests.
 *
 * The documents are the ones `packages/core/test/fixtures.ts` defines (they are the
 * PoC example's seven documents, `research/pokedex-example-spec.md` C), and the
 * schema is `apps/pokedex/server/schema.graphql`. The script extracts the literals
 * from the TypeScript fixture so the two cannot drift: rerun it after a fixture
 * change and the Rust tests compile the same inputs the oracle test does.
 *
 *   node crates/flamme-core/tests/fixtures/make_poc.mjs
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE = join(REPO, 'packages/core/test/fixtures.ts');
const TARGET = join(HERE, 'poc');

const NAMES = [
  'INFO_QUERY',
  'FAVORITES_QUERY',
  'TOGGLE_FAVORITE_MUTATION',
  'SPRITE_INFO_FRAGMENT',
  'SPECIES_PREVIEW_FRAGMENT',
  'MOVE_DISPLAY_FRAGMENT',
  'FAVORITE_PREVIEW_FRAGMENT',
  'POC_CONFIG',
];

/** Evaluates the `export const NAME = <literal>;` declarations of the fixture module. */
function extractLiterals(text) {
  const values = {};
  for (const name of NAMES) {
    const match = new RegExp(`export const ${name} = (\`(?:[^\`\\\\]|\\\\.)*\`);`, 's').exec(text);
    if (match === null) {
      throw new Error(`fixture literal ${name} not found in ${SOURCE}`);
    }
    // eslint-disable-next-line no-eval -- the fixture is a first-party test file
    values[name] = eval(match[1]);
  }
  return values;
}

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

const values = extractLiterals(await readFile(SOURCE, 'utf8'));
const schema = await readFile(join(REPO, 'apps/pokedex/server/schema.graphql'), 'utf8');

const files = {
  'flamme.config.json': `${JSON.stringify(
    {
      schemaPath: './server/schema.graphql',
      url: '/graphql',
      include: ['src/**/*.{vue,ts,graphql,gql}'],
      exclude: ['server/schema.graphql'],
      types: { SpeciesMove: { keys: ['name'] } },
    },
    null,
    2,
  )}\n`,
  'server/schema.graphql': schema,
  'src/routes/[[id]]/+page.gql': values.INFO_QUERY,
  'src/routes/+layout.gql': values.FAVORITES_QUERY,
  'src/mutations/ToggleFavorite.ts': `import { graphql } from '$flamme'\n\nexport const ToggleFavorite = graphql\`${values.TOGGLE_FAVORITE_MUTATION}\`\n`,
  'src/components/Sprite.vue': componentWithTag('SpriteInfo', values.SPRITE_INFO_FRAGMENT),
  'src/components/SpeciesPreview.vue': componentWithTag(
    'SpeciesPreview',
    values.SPECIES_PREVIEW_FRAGMENT,
  ),
  'src/components/MoveDisplay.vue': componentWithTag('MoveDisplay', values.MOVE_DISPLAY_FRAGMENT),
  'src/components/FavoritePreview.vue': `<script setup lang="ts">
import { graphql } from '$flamme'

const fragment = graphql\`${values.FAVORITE_PREVIEW_FRAGMENT}\`
</script>

<template>
  <div>{{ fragment.name }}</div>
</template>
`,
};

await rm(TARGET, { recursive: true, force: true });
for (const [relative, content] of Object.entries(files)) {
  const absolute = join(TARGET, relative);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}
process.stdout.write(`wrote ${Object.keys(files).length} files to ${TARGET}\n`);
