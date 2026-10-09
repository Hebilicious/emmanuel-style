/**
 * One benchmark child: loads the built compiler, resolves a project, runs one
 * `generate` and prints `{ms, maxRssKb, files, compiled, written, diagnostics}`.
 *
 * Run by `native-bench.mjs`; not useful on its own except for debugging:
 *
 *   node packages/core/bench/native-bench-runner.mjs '{"project":{"root":"apps/pokedex"},"mode":"full"}'
 *
 * A one-edit run warms the runtime directory and the incremental cache with an
 * untimed full run first, because that is the state the edit run actually starts
 * from; only the second run is measured. `edit: true` (the benchmark's default, also
 * spelled `--edit`) rewrites the changed source between the two, so the measured run
 * has one document to rebuild rather than none.
 */

import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const spec = JSON.parse(process.argv[2]);

const { loadConfig, resolveConfig, generate } = await import('../dist/index.js');

const root = spec.project.root.startsWith('/') ? spec.project.root : join(REPO, spec.project.root);

const config = spec.project.configFile
  ? await loadConfig(root)
  : resolveConfig(JSON.parse(await readFile(join(root, 'flamme.config.json'), 'utf8')), root);

// A scratch generated directory per corpus: gitignored, and on the same filesystem
// as the checkout so the write numbers are not a network mount's.
const runtimeDir = join(REPO, 'target/bench-runtime', `${spec.corpus}-${spec.mode}`);
const cache = spec.cache === true ? {} : undefined;
const resolved = { ...config, runtimeDir };

// `--edit` makes the scenario a real edit. The source is restored before this child
// exits, so a benchmark never leaves a checked-in document modified.
let restore;
if (spec.mode === 'one-edit') {
  await generate(resolved, { update: true, ...(cache === undefined ? {} : { cache }) });
  if (spec.edit === true) {
    // A comment line in the changed source moves its document text. Both modes
    // then have to recompile exactly that one document (and leave the other 399
    // alone). Without `edit` the change set names an unedited file and the measured
    // run rebuilds nothing, which the table now shows as `compiled 0, written 0`.
    const target = join(root, spec.project.changed);
    const original = await readFile(target, 'utf8');
    restore = async () => writeFile(target, original, 'utf8');
    await writeFile(target, `${original}\n# edited\n`, 'utf8');
  }
} else {
  // A full run starts from an empty generated directory: the run then pays
  // the same write cost and the comparison is not about what is already on disk.
  await rm(runtimeDir, { recursive: true, force: true });
}

/** Every phase the driver reported, so the table can explain the total. */
const phases = {};
let result;
let ms;
try {
  const started = performance.now();
  result = await generate(resolved, {
    update: true,
    ...(spec.mode === 'one-edit' ? { files: [spec.project.changed] } : {}),
    ...(cache === undefined ? {} : { cache }),
    onPhase: (timing) => {
      phases[timing.phase] = (phases[timing.phase] ?? 0) + timing.ms;
    },
  });
  ms = performance.now() - started;
} finally {
  // The edited source goes back before this child exits, whatever the run did.
  await restore?.();
}

process.stdout.write(
  `${JSON.stringify({
    ms,
    maxRssKb: process.resourceUsage().maxRSS,
    files: await countFiles(runtimeDir),
    compiled: result.compiled.length,
    written: result.written.length,
    phases,
    diagnostics: result.diagnostics.length,
  })}\n`,
);

/** The generated tree's file count. */
async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- the walk recurses one entry at a time
      count += await countFiles(`${directory}/${entry.name}`);
    } else if (entry.isFile()) {
      count += 1;
    }
  }
  return count;
}
