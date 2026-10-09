/**
 * The `flamme()` plugin host (`apps/docs/content/plugins.md`).
 *
 * `flamme()` is a host, not a fixed pair of plugins. A plugin registered with
 * `flamme({ plugins: [...] })` may contribute a compiler plugin, a Vite plugin, or
 * both:
 *
 * ```ts
 * flamme({
 *   plugins: [
 *     { name: 'flamme:routes', compiler: flammeRoutesPlugin() },
 *     { name: 'my-vite-plugin', vite: myPlugin() },
 *   ],
 * })
 * ```
 *
 * The `compiler` plugins join the config's own `plugins` through `loadConfig`'s
 * `extraPlugins`, so every codegen pass (`configureServer`, `buildStart`, and a
 * `flamme generate` of the same config file) runs them; the `vite` plugins are
 * appended to the array `flamme()` returns, after the built-ins.
 */

import type { CompilerPlugin } from '@flamme/core';
import type { Plugin } from 'vite';

/** One plugin registered with `flamme()`. */
export interface FlammeVitePlugin {
  /** Plugin name; used by the ordering warning and by diagnostics. */
  readonly name: string;
  /** Compiler plugin(s) the codegen pass runs. */
  readonly compiler?: CompilerPlugin | readonly CompilerPlugin[];
  /** Vite plugin(s) `flamme()` returns after its own two. */
  readonly vite?: Plugin | readonly Plugin[];
}

/** Every compiler plugin the `flamme()` plugin list contributes, in list order. */
export function compilerPluginsOf(
  plugins: readonly FlammeVitePlugin[] | undefined,
): readonly CompilerPlugin[] {
  const found: CompilerPlugin[] = [];
  for (const plugin of plugins ?? []) {
    if (plugin.compiler === undefined) {
      continue;
    }
    found.push(...(Array.isArray(plugin.compiler) ? plugin.compiler : [plugin.compiler]));
  }
  return found;
}

/** Every Vite plugin the `flamme()` plugin list contributes, in list order. */
export function vitePluginsOf(plugins: readonly FlammeVitePlugin[] | undefined): readonly Plugin[] {
  const found: Plugin[] = [];
  for (const plugin of plugins ?? []) {
    if (plugin.vite === undefined) {
      continue;
    }
    found.push(...(Array.isArray(plugin.vite) ? plugin.vite : [plugin.vite]));
  }
  return found;
}
