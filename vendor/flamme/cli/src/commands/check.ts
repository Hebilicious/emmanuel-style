/**
 * `flamme check`: the generate pipeline in check mode, which writes
 * nothing and reports every diagnostic.
 *
 * Two additive modes: `--json` prints the diagnostics as a JSON array instead of
 * the human `file:line:col  FLMxxxx  message` lines (the human format is
 * untouched without the flag), and `--persisted` additionally fails when the
 * committed `<runtimeDir>/persisted.json` is missing or stale.
 */

import { generate } from '@flamme/core';

import type { ExitCode } from '../exit-codes.js';
import type { ResolvedIo } from '../io.js';
import { reportJson, reportResult } from './report.js';
import { loadProjectConfig } from './project.js';

/** Everything `check` needs from the parsed command line. */
export interface CheckContext {
  /** Resolved output sinks and working directory. */
  readonly io: ResolvedIo;
  /** Explicit `--config` path, if any. */
  readonly configFile: string | undefined;
  /** `--json`: machine-readable diagnostics instead of the human lines. */
  readonly json: boolean;
  /** `--persisted`: report `FLM1025` when the committed manifest is stale. */
  readonly persisted: boolean;
}

/** Runs `flamme check` and returns its exit code. */
export async function runCheck(context: CheckContext): Promise<ExitCode> {
  const config = await loadProjectConfig(context.io, context.configFile);
  const result = await generate(config, { check: true, persisted: context.persisted });
  if (context.json) {
    return reportJson(result, context.io);
  }
  return reportResult(result, config, context.io, 'check', false);
}
