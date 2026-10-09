/**
 * Plugin options, config loading and the plugin-order check (`spec/spec.md`
 * §10.1, §10.2 `configResolved`).
 */

import { resolve } from 'node:path';

import {
  CompileError,
  ConfigError,
  DEFAULT_RUNTIME_DIR,
  hasErrors,
  loadConfig,
  resolveConfig,
  type Diagnostic,
  type FlammeConfig,
  type ResolvedConfig,
} from '@flamme/core';

import { CODEGEN_PLUGIN_NAME, TRANSFORM_PLUGIN_NAME } from './names.js';
import { compilerPluginsOf, type FlammeVitePlugin } from './plugins.js';

/** Options accepted by `flamme()` (`spec/spec.md` §10.1). */
export interface FlammePluginOptions {
  /** Overrides for the config file (mainly for tests and a second PoC config). */
  readonly config?: FlammeConfig;
  /** Path to the config file. Default `<root>/flamme.config.ts`. */
  readonly configFile?: string;
  /** Force the SFC analyzer. Default: Vize when installed and `vize()` is present, else `@vue/compiler-sfc`. */
  readonly sfc?: 'auto' | 'vize' | 'vue-compiler';
  /** Skip codegen entirely (CI already ran the CLI). */
  readonly skipCodegen?: boolean;
  /**
   * Plugins of the host itself: each may contribute a compiler plugin, a Vite
   * plugin, or both. See `./plugins.ts`.
   */
  readonly plugins?: readonly FlammeVitePlugin[];
}

/** The runtime directory a project root implies before the config file is read. */
export function defaultRuntimeDir(root: string, options: FlammePluginOptions): string {
  const configured = options.config?.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  return resolve(root, configured);
}

/** The project directory a Vite root and the plugin options imply. */
export function projectDirOf(root: string, options: FlammePluginOptions): string {
  const configured = options.config?.projectDir;
  return configured === undefined ? resolve(root) : resolve(root, configured);
}

/**
 * Loads `flamme.config.ts` for a project, merging `options.config` the way
 * `FlammePluginOptions` documents. Throws `ConfigError` (FLM2004) with a
 * clear message when neither a config file nor `options.config` exists.
 *
 * A `config` plugin hook that throws is the one other failure: the file loaded, so this throws a
 * `CompileError` carrying the `FLM2005` diagnostic that names the plugin and the hook, which is
 * what the caller reports.
 */
export async function loadProjectConfig(
  root: string,
  options: FlammePluginOptions,
): Promise<ResolvedConfig> {
  const projectDir = projectDirOf(root, options);
  const fallback = options.config;
  const extraPlugins = compilerPluginsOf(options.plugins);
  const diagnostics: Diagnostic[] = [];
  const resolved = await loadConfig(projectDir, {
    ...(options.configFile === undefined ? {} : { configFile: options.configFile }),
    ...(fallback === undefined ? {} : { fallback, overrides: fallback }),
    ...(extraPlugins.length === 0 ? {} : { extraPlugins }),
    diagnostics,
  });
  if (hasErrors(diagnostics)) {
    throw new CompileError(diagnostics);
  }
  return resolved.projectDir === projectDir ? resolved : resolveConfig(resolved, projectDir);
}

/**
 * A resolved config for `skipCodegen` runs that could not load one. The
 * placeholder schema is required by `resolveConfig`'s validation and is never
 * read, because this config only supplies paths for the alias and the manifest.
 */
export function fallbackConfig(root: string, options: FlammePluginOptions): ResolvedConfig {
  const extraPlugins = compilerPluginsOf(options.plugins);
  return resolveConfig(
    {
      schemaPath: './schema.graphql',
      ...options.config,
      ...(extraPlugins.length === 0
        ? {}
        : { plugins: [...(options.config?.plugins ?? []), ...extraPlugins] }),
    },
    projectDirOf(root, options),
  );
}

/** The plugin names that mean "a Vue compiler owns the `.vue` files". */
const VUE_COMPILER_PLUGINS = ['vite:vue', 'vize', 'vize:post-transform'];

/** Warns when a Vue compiler plugin is listed before ours (`spec/spec.md` §10.1). */
export function warnOnPluginOrder(
  plugins: readonly { readonly name: string }[],
  warn: (message: string) => void,
): void {
  const ours = plugins.findIndex(
    (plugin) => plugin.name === TRANSFORM_PLUGIN_NAME || plugin.name === CODEGEN_PLUGIN_NAME,
  );
  if (ours === -1) {
    return;
  }
  const compiler = plugins.findIndex((plugin) =>
    VUE_COMPILER_PLUGINS.some((name) => plugin.name === name || plugin.name.startsWith(`${name}:`)),
  );
  if (compiler === -1 || compiler > ours) {
    return;
  }
  const name = plugins[compiler]?.name ?? 'a Vue compiler plugin';
  warn(
    `${name} is listed before flamme(); put flamme() first so the document ` +
      'rewrite sees the SFC source instead of compiled JavaScript ' +
      '(plugins: [flamme(), vue()]).',
  );
}

/** The clear, actionable message for a missing config (`FLM2004`). */
export function missingConfigError(root: string, cause: unknown): ConfigError {
  return new ConfigError(
    'FLM2004',
    `No flamme.config.ts could be loaded from "${root}": ` +
      `${cause instanceof Error ? cause.message : String(cause)}. ` +
      'Create one with `flamme init` or pass `config` to flamme().',
  );
}
