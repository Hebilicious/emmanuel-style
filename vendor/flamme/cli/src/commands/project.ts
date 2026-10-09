/**
 * Project setup shared by the commands: finding and loading
 * `flamme.config.ts` through `@flamme/core`.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  CompileError,
  ConfigError,
  hasErrors,
  loadConfig,
  type Diagnostic,
  type ResolvedConfig,
} from '@flamme/core';

import type { ResolvedIo } from '../io.js';

/**
 * Loads the project config for `io.cwd`. An explicit `--config` path that does
 * not exist is reported as `FLM2001` naming that path, rather than as a generic
 * "no config file found".
 *
 * The project directory is the directory of the **resolved config file**, not
 * `io.cwd`: `generate --config <other project>` must generate the project the
 * file belongs to, with every relative `schemaPath`, `include` and `runtimeDir`
 * resolved beside it. `io.cwd` only decides how a relative `--config` is found.
 *
 * Every config-file failure is reported as `FLM2001`: `spec/spec.md` §10.5 makes
 * exit code 2 a config/usage error and names `FLM2001` for it, while core's
 * internal `FLM2004` covers the Vize seam (§10.3). A schema failure (`FLM2002`,
 * exit 3) passes through untouched.
 *
 * A `config` plugin hook that throws is not a config-file failure: the file
 * loaded, the plugin did not. It reaches the caller as a `CompileError` whose
 * `FLM2005` diagnostic names the plugin and the hook, the same channel (and exit
 * code) every other plugin failure uses.
 */
export async function loadProjectConfig(
  io: ResolvedIo,
  configFile: string | undefined,
): Promise<ResolvedConfig> {
  try {
    return await loadConfigFor(io, configFile);
  } catch (error) {
    if (error instanceof ConfigError && error.code !== 'FLM2002') {
      throw new ConfigError('FLM2001', error.message);
    }
    throw error;
  }
}

/** The actual lookup; {@link loadProjectConfig} normalises its error code. */
async function loadConfigFor(
  io: ResolvedIo,
  configFile: string | undefined,
): Promise<ResolvedConfig> {
  // The sink is how a `config` hook failure arrives as a diagnostic instead of a thrown
  // `ConfigError`: it names the plugin, and the run fails like any other compile failure.
  const diagnostics: Diagnostic[] = [];
  let config: ResolvedConfig;
  if (configFile === undefined) {
    config = await loadConfig(io.cwd, { diagnostics });
  } else {
    const absolute = isAbsolute(configFile) ? configFile : resolve(io.cwd, configFile);
    if (!existsSync(absolute)) {
      throw new ConfigError('FLM2001', `config file not found: ${configFile}`);
    }
    config = await loadConfig(dirname(absolute), { configFile: absolute, diagnostics });
  }
  if (hasErrors(diagnostics)) {
    throw new CompileError(diagnostics);
  }
  return config;
}
