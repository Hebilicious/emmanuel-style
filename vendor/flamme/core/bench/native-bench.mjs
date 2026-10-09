/**
 * Compiler benchmarks: full run and one-edit run, wall time and peak RSS, for the
 * Rust compiler.
 *
 *   node packages/core/bench/native-bench.mjs [--runs 3] [--corpus pokedex,synthetic] [--no-edit]
 *
 * Each measurement runs in a fresh child process (`native-bench-runner.mjs`), so a
 * run cannot inherit a warm module cache or another run's heap. The child reports
 * the wall time around the `generate` call itself and `process.resourceUsage().maxRSS`
 * for the whole process (kilobytes on Linux; the number includes the Node runtime
 * and the loaded native module), plus `CodegenResult.compiled` and
 * `CodegenResult.written`, which the table prints as counts so a row can be audited.
 *
 * One-edit runs take the incremental path the Vite plugin uses, with a warm
 * `GenerateCache` and `files: [<one changed source>]`: the caller names the changed
 * file (the watcher's own list) and the compiler re-uses every other file and every
 * unchanged document from the cache, so only the documents the change set can affect
 * are rebuilt. The full row is there so the reader can separate the compiler's own
 * cost from the work the change set skips.
 *
 * The default one-edit run rewrites the changed source between the warm-up and the
 * measured run, so the change set names a file with a real edit and the row measures
 * one document rebuilt (`compiled 1`). Without the edit the change set is a cache
 * hit: `compiled 0`, `written 0`, a row that times the walk and reports nothing about
 * incremental rebuild cost, which is how an earlier revision produced a default
 * "one edit" number that did not reproduce under `--edit`. `--edit` is the default,
 * and `--no-edit` restores the old no-op change set on purpose.
 *
 * A full run also goes through the cache when one is supplied, so the `full` row
 * shows the walk, read and emit; `one edit (incremental)` is the same pipeline with a
 * change set, which is where the skipped work shows up.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const RUNNER = join(HERE, 'native-bench-runner.mjs');

const args = process.argv.slice(2);
const runs = Number(argumentValue('--runs') ?? '3');
const corpora = (argumentValue('--corpus') ?? 'pokedex,synthetic').split(',');
// `--edit` is the default: the changed source is rewritten between the warm-up and
// the measured one-edit run, so that run has one document to rebuild. `--no-edit`
// keeps the source untouched, which measures a cache hit rather than a rebuild.
const edit = !args.includes('--no-edit');

function argumentValue(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** The number of documents the synthetic corpus carries (roughly 400). */
const SYNTHETIC_DOCUMENTS = 400;

/** Builds the synthetic corpus once and returns its project directory. */
async function syntheticProject() {
  const root = join(REPO, 'target/bench-corpus');
  const schema = [
    'type Query {',
    '  species(id: Int!): Species',
    '  pokemon(first: Int, after: String): SpeciesConnection!',
    '}',
    'type Species {',
    '  id: Int!',
    '  name: String!',
    '  pokedexNumber: Int!',
    '  flavor_text: String!',
    '  favorite: Boolean!',
    '  sprites: SpeciesSprites!',
    '  evolution_chain: [Species!]!',
    '}',
    'type SpeciesSprites { front: String! back: String! }',
    'type SpeciesConnection { edges: [SpeciesEdge!]! pageInfo: PageInfo! totalCount: Int! }',
    'type SpeciesEdge { cursor: String node: Species }',
    'type PageInfo { endCursor: String hasNextPage: Boolean! hasPreviousPage: Boolean! }',
  ].join('\n');
  await mkdir(join(root, 'server'), { recursive: true });
  await writeFile(join(root, 'server/schema.graphql'), `${schema}\n`);
  await writeFile(
    join(root, 'flamme.config.json'),
    `${JSON.stringify(
      {
        schemaPath: './server/schema.graphql',
        include: ['src/**/*.{gql,ts,vue}'],
        exclude: ['server/schema.graphql'],
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(
    join(root, 'src/fragments.gql'),
    'fragment SpeciesFields on Species { id name pokedexNumber favorite sprites { front back } }\n',
  );
  const documents = [];
  for (let index = 0; index < SYNTHETIC_DOCUMENTS; index += 1) {
    documents.push(
      `query Species${index}($id: Int! = ${index + 1}) {\n  species(id: $id) {\n    ...SpeciesFields\n    evolution_chain { id name }\n  }\n}\n`,
    );
  }
  await mkdir(join(root, 'src/documents'), { recursive: true });
  await Promise.all(
    documents.map((document, index) =>
      writeFile(join(root, `src/documents/Species${index}.gql`), document),
    ),
  );
  return { root, changed: 'src/documents/Species0.gql' };
}

/** One measured scenario. */
function measure(label, project, options) {
  const { corpus } = options;
  const times = [];
  const rss = [];
  let files = 0;
  let diagnostics = 0;
  let compiled = 0;
  let written = 0;
  let phases = {};
  for (let run = 0; run < runs; run += 1) {
    const output = execFileSync(
      process.execPath,
      [RUNNER, JSON.stringify({ project, corpus, ...options })],
      { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    const result = JSON.parse(output);
    times.push(result.ms);
    rss.push(result.maxRssKb);
    files = result.files;
    diagnostics = result.diagnostics;
    compiled = result.compiled;
    written = result.written;
    phases = result.phases;
  }
  times.sort((a, b) => a - b);
  rss.sort((a, b) => a - b);
  return {
    label,
    medianMs: times[Math.floor(times.length / 2)],
    minMs: times[0],
    medianRssMb: rss[Math.floor(rss.length / 2)] / 1024,
    files,
    compiled,
    written,
    diagnostics,
    phases,
  };
}

const results = [];
for (const corpus of corpora) {
  const project =
    corpus === 'pokedex'
      ? {
          root: join(REPO, 'apps/pokedex'),
          changed: 'src/documents/Favorites.gql',
          configFile: true,
        }
      : // oxlint-disable-next-line eslint/no-await-in-loop -- the synthetic corpus is built once per corpus
        { ...(await syntheticProject()), configFile: false };
  const scenarios = [
    ['full', { mode: 'full' }],
    ['one edit (incremental)', { mode: 'one-edit', cache: true }],
  ];
  for (const [label, options] of scenarios) {
    results.push({ corpus, ...measure(label, project, { ...options, corpus, edit }) });
  }
}

const header = [
  'corpus',
  'scenario',
  'median ms',
  'min ms',
  'peak RSS MB',
  'tree files',
  'compiled',
  'written',
  'diagnostics',
  'phases ms',
];
const rows = results.map((result) => [
  result.corpus,
  result.label,
  result.medianMs.toFixed(1),
  result.minMs.toFixed(1),
  result.medianRssMb.toFixed(1),
  String(result.files),
  String(result.compiled),
  String(result.written),
  String(result.diagnostics),
  Object.entries(result.phases ?? {})
    .map(([phase, ms]) => `${phase} ${ms.toFixed(1)}`)
    .join(', '),
]);
const widths = header.map((cell, index) =>
  Math.max(cell.length, ...rows.map((row) => row[index].length)),
);
const render = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');
process.stdout.write(`${render(header)}\n${render(widths.map((width) => '-'.repeat(width)))}\n`);
for (const row of rows) {
  process.stdout.write(`${render(row)}\n`);
}
process.stdout.write(
  `\nruns per scenario: ${runs}; peak RSS is process.resourceUsage().maxRSS of the measurement child, Node runtime included.\n` +
    `compiled is the number of documents the run rebuilt; written is the number of files it wrote.\n` +
    (edit
      ? 'one-edit runs rewrite the changed source between the warm-up and the measured run.\n'
      : 'one-edit runs --no-edit: the change set names an unedited file, so the row measures a cache hit.\n'),
);
