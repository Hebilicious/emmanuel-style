/**
 * The codegen driver the plugin calls from `configureServer` and `buildStart`
 * (`spec/spec.md` §10.2): the same `generate()` entry point the CLI uses, so
 * dev, build and CI write byte-identical trees (REQ-6.3).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CompileError,
  extractProject,
  formatDiagnostics,
  generate,
  hasErrors,
  toPosix,
  walkFiles,
  type CodegenResult,
  type Diagnostic,
  type GenerateOptions,
  type ResolvedConfig,
} from '@flamme/core';
import { planComposition, planRoutes, type RouteComposition } from '@flamme/router/codegen';

/**
 * The per-project state one codegen pass hands the next. It is read off
 * `GenerateOptions` rather than imported by name so this package does not need a
 * second export added to core's barrel for a type it only forwards.
 */
export type GenerateCache = NonNullable<GenerateOptions['cache']>;

import { indexFromCodegen, type ArtifactIndex } from './indexes.js';
import { generateRoutes, type RoutesRun } from './routes.js';

/** What one codegen pass produced. */
export interface CodegenRun {
  /** The core result: artifacts, diagnostics and the files written. */
  readonly result: CodegenResult;
  /** The transform's lookup over the artifacts. */
  readonly index: ArtifactIndex;
  /**
   * The filesystem route generation pass (`research/routing-report.md`). `generate()` reports the
   * artifacts but not the raw documents the route planner needs, so the extraction is repeated
   * through the same `extractProject` entry point: both calls walk the same config, so the document
   * set is identical, and no second scanner can drift from the compiler.
   */
  readonly routes: RoutesRun;
}

/** Options for {@link runCodegen}. */
export interface CodegenOptions {
  /** The resolved project config. */
  readonly config: ResolvedConfig;
  /**
   * The sources that changed since the previous run, as project-relative posix
   * paths. Every other file is served from `cache`, so one edit re-reads one file
   * (the tree still describes the whole project). `undefined` is a full run.
   */
  readonly files?: readonly string[];
  /**
   * The state the previous run left behind, owned by the caller (the plugin
   * state) so it survives across HMR batches. Without it, `files` still selects
   * what to re-emit but nothing can be reused.
   */
  readonly cache?: GenerateCache;
}

/**
 * Plans the route table **without** running artifact codegen, for the one hook that must have
 * `$flamme/routes` on disk before any module resolution happens (`configResolved`).
 *
 * The full pass (`runCodegen`) generates routes from the same extraction; this one exists so a
 * consumer that only runs Vite's `config`/`configResolved` stage - a test runner whose plugin never
 * gets a dev server, a build whose `buildStart` has not run - still finds the generated module.
 *
 * It composes only the records whose composed artifact module **already exists** on disk: this stage
 * runs before any codegen, so a composed loader that named a module no run had written yet would be
 * an unresolvable import (`FLM1017`). After a codegen pass the modules are there, and the table this
 * stage writes matches the one the full pass writes, which is what a dev server started with codegen
 * skipped needs.
 */
export async function planRoutesFor(config: ResolvedConfig): Promise<RoutesRun> {
  const extraction = await extractProject(config, {});
  const composition = await composeRoutes(config, extraction.documents);
  return generateRoutes({
    config,
    documents: extraction.documents,
    artifacts: extraction.documents.map((document) => document.name),
    composition: withExistingArtifacts(composition, config.runtimeDir),
  });
}

/** The composition restricted to the records whose composed artifact module is already on disk. */
function withExistingArtifacts(
  composition: RouteComposition,
  runtimeDir: string,
): RouteComposition {
  if (composition.documents.length === 0) {
    return composition;
  }
  const documents = composition.documents.filter((document) =>
    existsSync(join(runtimeDir, 'artifacts', `${document.name}.ts`)),
  );
  if (documents.length === composition.documents.length) {
    return composition;
  }
  const records = new Map(
    [...composition.records].filter(([record]) =>
      documents.some((document) => document.record === record),
    ),
  );
  return { ...composition, documents, records };
}

/** The error diagnostics of one run, in the `file:line:col` form. */
export function formatDiagnosticList(diagnostics: readonly Diagnostic[]): string {
  return formatDiagnostics(diagnostics);
}

/** The message a failed codegen pass hands to Vite's overlay and the CLI. */
export function formatCompileError(error: CompileError): string {
  return `flamme codegen failed:\n${formatDiagnosticList(error.diagnostics)}`;
}

/**
 * Runs one codegen pass and throws `CompileError` when any error diagnostic
 * exists, so the Vite build fails instead of serving a half-generated tree.
 */
export async function runCodegen(options: CodegenOptions): Promise<CodegenRun> {
  // The extraction happens once, here, because route composition needs the documents **before** the
  // compile: a record's composed document is a synthetic input, so it has to be in the compile that
  // produces its artifact (`research/route-composition-design.md` §4.1). The options mirror the
  // call `generate()` would make itself, so an incremental pass still parses only what changed.
  const extraction =
    options.cache?.extraction === undefined
      ? await extractProject(
          options.config,
          options.files === undefined ? {} : { files: options.files },
        )
      : await extractProject(options.config, {
          ...(options.files === undefined ? {} : { files: options.files }),
          previous: options.cache.extraction,
        });
  const composition = await composeRoutes(options.config, extraction.documents);
  if (composition.errors.length > 0) {
    // FLM1032: a composed name collides with a document. The composed document is not compiled, and
    // the run fails rather than shipping a module that imports an artifact nobody emitted.
    throw new CompileError(composition.errors);
  }
  const result = await generate(options.config, {
    extraction,
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(composition.documents.length === 0 ? {} : { routeDocuments: composition.documents }),
  });
  if (hasErrors(result.diagnostics)) {
    throw new CompileError(result.diagnostics);
  }
  const diagnostics = mergeDiagnostics(result.diagnostics, composition.warnings);
  // The route table is generated in the same pass as the artifacts, from the same extraction and
  // the same artifact names, so a route's loader can only ever name a document that exists.
  const routes = await generateRoutes({
    config: options.config,
    documents: extraction.documents,
    artifacts: result.artifacts.map((artifact) => artifact.name),
    composition,
  });
  return {
    result: { ...result, diagnostics },
    index: indexFromCodegen(result),
    routes,
  };
}

/**
 * Plans the project's composed route documents, or nothing when the project composes per document.
 *
 * The route table is planned **without** artifacts here (they do not exist yet); `generateRoutes`
 * plans it again with them, which is what reports `FLM3002`. `planRoutes` is pure and cheap, so
 * planning twice is the cheapest way to keep the compile single-pass.
 */
export async function composeRoutes(
  config: ResolvedConfig,
  documents: readonly Parameters<typeof planRoutes>[0]['documents'][number][],
): Promise<RouteComposition> {
  const routing = config.routing;
  const compose =
    typeof routing === 'object' && routing !== null
      ? Reflect.get(routing, 'compose')
      : undefined;
  if (compose === 'document') {
    return { documents: [], records: new Map(), warnings: [], errors: [] };
  }
  const files = await pageFileSources(config);
  const plan = planRoutes({
    config,
    projectDir: config.projectDir,
    runtimeDir: config.runtimeDir,
    files,
    documents,
  });
  return planComposition({ plan, documents, config });
}

/** The pages tree, as absolute posix path -> source; the planner reads it for the record set. */
async function pageFileSources(config: ResolvedConfig): Promise<Readonly<Record<string, string>>> {
  const routing = config.routing;
  const configured =
    typeof routing === 'object' && routing !== null ? Reflect.get(routing, 'pagesDir') : undefined;
  const pagesDir =
    typeof configured === 'string' && configured.length > 0 ? configured : 'src/pages';
  const discovered = await walkFiles(
    config.projectDir,
    [pagesDir === '' ? '**/*' : `${pagesDir}/**/*`],
    config.exclude,
    [],
    'flamme.config.ts',
  );
  const files: Record<string, string> = {};
  await Promise.all(
    discovered.map(async (entry) => {
      const source = await readFile(entry.absolute, 'utf8').catch(() => undefined);
      if (source !== undefined) {
        files[toPosix(entry.absolute)] = source;
      }
    }),
  );
  return files;
}

/**
 * The composition warnings appended to the run's diagnostics.
 *
 * Reported through `CodegenResult.diagnostics`, which is the one list the Vite plugin logs
 * (`reportWarnings`) and the CLI prints, so a fallen-back route is visible in dev, in `flamme
 * generate` and in `flamme check`.
 */
function mergeDiagnostics(
  diagnostics: readonly Diagnostic[],
  composition: readonly Diagnostic[],
): readonly Diagnostic[] {
  if (composition.length === 0) {
    return diagnostics;
  }
  return [...diagnostics, ...composition];
}

