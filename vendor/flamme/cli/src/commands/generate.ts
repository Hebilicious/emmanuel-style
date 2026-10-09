/**
 * `flamme generate`: load config → compile → write the tree, once or on
 * every change in `--watch` mode.
 */

import { rm } from 'node:fs/promises';
import { relative } from 'node:path';

import {
  CompileError,
  ConfigError,
  createDiagnostic,
  generate,
  toPosix,
  type ResolvedConfig,
} from '@flamme/core';

import { errorText } from '../errors.js';

import type { ExitCode } from '../exit-codes.js';
import type { ResolvedIo } from '../io.js';
import { createPipelineLock } from '../pipeline.js';
import { watchDirectory } from '../watch.js';
import { reportResult } from './report.js';
import { loadProjectConfig } from './project.js';

/** Everything `generate` needs from the parsed command line. */
export interface GenerateContext {
  /** Resolved output sinks and working directory. */
  readonly io: ResolvedIo;
  /** Explicit `--config` path, if any. */
  readonly configFile: string | undefined;
  /** `--watch`. */
  readonly watch: boolean;
  /** `--force`. */
  readonly force: boolean;
  /** `--silent`. */
  readonly silent: boolean;
  /** `--persisted`: also write `<runtimeDir>/persisted.json`. */
  readonly persisted: boolean;
  /** Aborts a watch session; `undefined` watches until the process is killed. */
  readonly signal: AbortSignal | undefined;
}

/** True when a watched path belongs to the generated tree or to git metadata. */
export function isIgnoredWatchPath(file: string, runtimeDir: string): boolean {
  return file === runtimeDir || file.startsWith(`${runtimeDir}/`) || file.startsWith('.git/');
}

/**
 * Deletes the generated directory for `--force`, so the next emit rewrites every
 * file. Refuses to touch anything outside the project directory. A directory
 * that cannot be cleared (a read-only tree, a full disk) is reported as the same
 * `FLM2003` write diagnostic the emitter uses, never as an internal error (A3).
 */
async function clearRuntimeDir(config: ResolvedConfig): Promise<void> {
  const relativeDir = toPosix(relative(config.projectDir, config.runtimeDir));
  if (relativeDir === '' || relativeDir.startsWith('..')) {
    throw new ConfigError(
      'FLM2001',
      `refusing to --force a runtimeDir outside the project directory: "${config.runtimeDir}"`,
    );
  }
  try {
    await rm(config.runtimeDir, { recursive: true, force: true });
  } catch (error) {
    throw new CompileError([
      createDiagnostic({
        code: 'FLM2003',
        severity: 'error',
        message: `cannot clear ${relativeDir}: ${errorText(error)}`,
        location: { file: 'flamme.config.ts', line: 1, column: 1, length: 1 },
      }),
    ]);
  }
}

/** One full pipeline run: optional clean, compile, write, report. */
async function compileOnce(config: ResolvedConfig, context: GenerateContext): Promise<ExitCode> {
  if (context.force) {
    await clearRuntimeDir(config);
  }
  const result = await generate(config, { update: true, persisted: context.persisted });
  return reportResult(result, config, context.io, 'generate', context.silent);
}

/** Runs `flamme generate`, including the `--watch` loop. */
export async function runGenerate(context: GenerateContext): Promise<ExitCode> {
  const config = await loadProjectConfig(context.io, context.configFile);
  let code = await compileOnce(config, context);
  if (!context.watch) {
    return code;
  }

  // Rebuilds are serialized: a batch that arrives mid-run waits for it. The
  // config is re-read on every change so edits to it take effect immediately,
  // and the whole project is recompiled because core's `files` option replaces
  // the project (it deletes artifacts outside the batch).
  const lock = createPipelineLock();
  const runtimeDir = toPosix(relative(config.projectDir, config.runtimeDir));
  const session = watchDirectory({
    directory: config.projectDir,
    signal: context.signal,
    ignore: (file) => isIgnoredWatchPath(file, runtimeDir),
    onChange: () =>
      lock.run(async () => {
        const fresh = await loadProjectConfig(context.io, context.configFile);
        code = await compileOnce(fresh, context);
      }),
  });
  if (!context.silent) {
    context.io.stdout(`flamme: watching ${toPosix(config.projectDir)} for changes.`);
  }
  await session.closed;
  return code;
}
