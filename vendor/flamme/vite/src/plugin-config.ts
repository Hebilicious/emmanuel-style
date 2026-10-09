/**
 * The route generator as a compiler plugin (REQ-1, REQ-2).
 *
 * `flamme()` writes `$flamme/routes` in its own codegen pass, but the compiler has a second driver:
 * `flamme generate` (the CLI, and `moon run <app>:codegen`) calls `@flamme/core`'s `generate()`
 * directly. A project whose typecheck or CI runs the CLI must get the same generated route table, so
 * the plugin below adds it to that pass:
 *
 * ```ts
 * // flamme.config.ts
 * import { defineConfig } from '@flamme/core'
 * import { flammeRoutesPlugin } from '@flamme/vite'
 *
 * export default defineConfig({
 *   schemaPath: './server/schema.graphql',
 *   plugins: [flammeRoutesPlugin()],
 * })
 * ```
 *
 * `beforeEmit` plans from the **IR documents the pass just compiled** (each carries its
 * `RawDocument`, so no second scan can drift from the compiler) and contributes every generated
 * route module to `context.emit` (the route table, the shim and the per-record modules). The host writes them in the same sorted batch as every other file, so they are
 * never half-written: a failed batch rolls back what it wrote, and the next successful run repairs
 * both. The bag is also what makes check mode read-only, because it is discarded there.
 *
 * `planRoutes` never throws: it collects `RouteWarning`s. They are reported as diagnostics through
 * `context.report()` here, which is the one path the CLI and `flamme check` both read, and the
 * option below decides how loud they are. The planner's findings are warnings by design (a root
 * layout that renders `/` through `meta.layout` is legitimate), so the default, `onError: 'report'`,
 * reports each one with `severity: 'warning'` and still writes the route table; `onError: 'fail'` is
 * the strict setting for a project that wants its page tree clean in CI, and `onError: 'ignore'`
 * reports nothing at all.
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import {
  createDiagnostic,
  toPosix,
  type CompilerPlugin,
  type Diagnostic,
  type DiagnosticSeverity,
  type PluginContext,
  type RawDocument,
  type ResolvedConfig,
  type RouteDocumentResult,
} from '@flamme/core';
import {
  planComposition,
  planRoutes,
  RECORDS_DIRECTORY,
  type RouteComposition,
  type RouteWarning,
} from '@flamme/router/codegen';

import { routeModuleFiles } from './routes.js';

/** What {@link flammeRoutesPlugin} does with the planner's findings. */
export type FlammeRoutesErrorMode = 'report' | 'fail' | 'ignore';

/** Options of {@link flammeRoutesPlugin}. */
export interface FlammeRoutesPluginOptions {
  /**
   * What the planner's warnings do. `report` (the default) reports each one as a warning diagnostic
   * and writes the route table; `fail` reports them as errors, which fails the run before anything
   * is written; `ignore` reports nothing.
   */
  readonly onError?: FlammeRoutesErrorMode;
}

/** A compiler plugin that writes the generated route table next to the artifacts. */
export function flammeRoutesPlugin(options: FlammeRoutesPluginOptions = {}): CompilerPlugin {
  const onError = options.onError ?? 'report';
  const severity: DiagnosticSeverity = onError === 'fail' ? 'error' : 'warning';
  return {
    name: 'flamme:routes',
    // The CLI path (`flamme generate`) has no codegen driver in TypeScript, so composition is
    // planned here: the hook runs after extraction and the composed documents join the very compile
    // that emits their artifacts, exactly as the Vite driver's `routeDocuments` does for the dev
    // and build path. Without it a CLI-generated tree would carry the per-document topology and the
    // two drivers would write different route tables.
    routeDocuments: (input) => routeDocuments(input.config, input.documents),
    beforeEmit: (context: PluginContext) => {
      // A project that does not compile keeps its ordinary diagnostics only: planning a page tree
      // whose documents failed to build would repeat the same problems.
      if (context.hasErrors) {
        return;
      }
      const documents = rawDocumentsOf(context);
      const plan = planRoutes({
        config: context.config,
        projectDir: toPosix(context.config.projectDir),
        runtimeDir: toPosix(context.runtimeDir),
        files: pageFiles(context.config),
        documents,
        artifacts: documents.map((document) => document.name),
      });
      const composition = planComposition({
        plan,
        documents,
        config: context.config,
      });
      if (onError !== 'ignore') {
        for (const warning of plan.warnings) {
          context.report(routeWarningDiagnostic(warning, severity));
        }
        for (const warning of composition.warnings) {
          context.report({ ...warning, severity });
        }
      }
      for (const error of composition.errors) {
        context.report(error);
      }
      if ((onError === 'fail' && plan.warnings.length > 0) || composition.errors.length > 0) {
        // The error diagnostics already stop the write in `emitProject`; contributing the files
        // anyway would only describe a tree that is not written.
        return;
      }
      // The route table, the shim and the per-record `usePageQuery()` modules: the CLI driver has to
      // write the same set the Vite plugin does, because a route component's rewritten
      // `$flamme/records/<record>` import resolves to one of them whichever driver ran.
      for (const [file, content] of routeModuleFiles(plan, composition)) {
        context.emit.set(file, content);
      }
      pruneRecordModules(context);
    },
  };
}

/**
 * Tombstones the record modules a previous run left behind.
 *
 * `records/` is this driver's own directory: its modules are named after the records the plan
 * declares, so a file the current run did not emit is stale by construction. Without the tombstone a
 * pure `flamme generate` left `records/<old>.ts` on disk, importing an artifact the same run had
 * swept, and the tree stopped type-checking (`TS2307`) until something called `writeRoutes`. The
 * Vite driver's `writeRoutes` prunes the same set for its own runs.
 */
function pruneRecordModules(context: PluginContext): void {
  const prefix = `${RECORDS_DIRECTORY}/`;
  const keep = new Set<string>();
  for (const file of context.emit.paths()) {
    if (file.startsWith(prefix)) {
      keep.add(file.slice(prefix.length));
    }
  }
  let entries: readonly string[];
  try {
    entries = readdirSync(join(context.runtimeDir, RECORDS_DIRECTORY));
  } catch {
    // no `records/` directory: a project with no page records has nothing to prune
    return;
  }
  for (const entry of entries) {
    if (entry.endsWith('.ts') && !keep.has(entry)) {
      context.emit.delete(`${prefix}${entry}`);
    }
  }
}

/**
 * The composed route documents of one CLI run, as the `routeDocuments` hook reports them.
 *
 * The plan is built without artifacts (they do not exist yet at hook time) and the composition from
 * it. The findings travel with the documents, so `generate()` reports them through the run's own
 * diagnostic list.
 */
function routeDocuments(
  config: ResolvedConfig,
  documents: readonly RawDocument[],
): RouteDocumentResult {
  const plan = planRoutes({
    config,
    projectDir: toPosix(config.projectDir),
    runtimeDir: toPosix(config.runtimeDir),
    files: pageFiles(config),
    documents,
  });
  const composition: RouteComposition = planComposition({ plan, documents, config });
  return {
    documents: composition.documents,
    diagnostics: [...composition.warnings, ...composition.errors],
  };
}

/** One planner warning as a compiler diagnostic, at the file the warning names. */
function routeWarningDiagnostic(warning: RouteWarning, severity: DiagnosticSeverity): Diagnostic {
  return createDiagnostic({
    code: warning.code,
    severity,
    message: warning.message,
    location: { file: warning.file, line: 1, column: 1, length: 1 },
  });
}

/**
 * The raw documents of one pass: each IR document carries the `RawDocument` it was built from, so
 * the planner sees the same sources, surfaces and ASTs the artifacts were compiled from.
 */
function rawDocumentsOf(context: PluginContext): readonly RawDocument[] {
  const documents: RawDocument[] = [];
  for (const entry of context.documents) {
    const document = rawDocumentOf(entry);
    if (document !== undefined) {
      documents.push(document);
    }
  }
  return documents;
}

/** The `RawDocument` behind one IR document, or `undefined` for a shape this build does not know. */
function rawDocumentOf(entry: unknown): RawDocument | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const nested: unknown = Reflect.get(entry, 'document');
  if (typeof nested !== 'object' || nested === null) {
    return undefined;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the IR document's `document` member is the RawDocument the compiler extracted
  return nested as RawDocument;
}

/**
 * The page tree as absolute posix path -> source.
 *
 * The hook is synchronous and the pages directory is a convention rather than a compiler input, so
 * the tree is read here directly: every file under `routing.pagesDir` (`walkFiles` does the same in
 * the async path, with the config's globs). An unreadable directory is an empty pages tree, which
 * the planner reports as no routes.
 */
function pageFiles(config: ResolvedConfig): Readonly<Record<string, string>> {
  const routing: unknown = config.routing;
  const configured =
    typeof routing === 'object' && routing !== null ? Reflect.get(routing, 'pagesDir') : undefined;
  const pagesDir =
    typeof configured === 'string' && configured.length > 0 ? configured : 'src/pages';
  const files: Record<string, string> = {};
  walk(join(config.projectDir, pagesDir), files);
  return files;
}

/** Reads one directory tree into `files`, keyed by absolute posix path. */
function walk(directory: string, files: Record<string, string>): void {
  let entries: readonly Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, files);
      continue;
    }
    try {
      if (statSync(absolute).isFile()) {
        files[toPosix(absolute)] = readFileSync(absolute, 'utf8');
      }
    } catch {
      // an unreadable entry contributes no route rather than failing the whole pass
    }
  }
}
