/**
 * `flamme()` — a host for two built-in plugins and any the caller registers
 * (`spec/spec.md` §10.1):
 *
 * 1. `vite:flamme:transform`, `enforce: 'pre'`: rewrites `graphql()` tags and
 *    `.gql` import specifiers in `.vue`/`.ts`/`.tsx` sources and splices the
 *    rewritten scripts back with a corrected sourcemap.
 * 2. `vite:flamme`: `config` (aliases + generated tsconfig), `buildStart`
 *    (codegen in build), `configureServer` (codegen in dev), `hotUpdate`
 *    (incremental rebuild + invalidation + `ws` push) and `resolveId`/`load`
 *    (virtual modules).
 *
 * `options.plugins` contributes more: a compiler plugin joins every codegen pass
 * through the config's `plugins`, and a Vite plugin is appended to this array.
 */

import type { Plugin } from 'vite';

import {
  runBuildStart,
  runConfig,
  runConfigResolved,
  runConfigureServer,
  runHotUpdate,
  runLoad,
  runResolveId,
  runTransform,
  createPluginState,
} from './actions.js';
import { CODEGEN_PLUGIN_NAME, TRANSFORM_PLUGIN_NAME } from './names.js';
import type { FlammePluginOptions } from './options.js';
import { vitePluginsOf } from './plugins.js';

export type { FlammePluginOptions } from './options.js';
export type { FlammeVitePlugin } from './plugins.js';

/**
 * Creates the Flamme Vite plugins, plus any the options registered. List them
 * once, before the Vue compiler plugin: `plugins: [flamme(), vue()]`.
 */
export function flamme(options: FlammePluginOptions = {}): Plugin[] {
  const state = createPluginState(options);

  const transform: Plugin = {
    name: TRANSFORM_PLUGIN_NAME,
    enforce: 'pre',
    async transform(code, id) {
      return runTransform(state, this, code, id);
    },
  };

  const codegen: Plugin = {
    name: CODEGEN_PLUGIN_NAME,
    async config(userConfig) {
      return runConfig(state, userConfig);
    },
    async configResolved(config) {
      await runConfigResolved(state, config);
    },
    async buildStart() {
      await runBuildStart(state, this);
    },
    async configureServer(server) {
      await runConfigureServer(state, server, this);
    },
    resolveId(id) {
      return runResolveId(state, id);
    },
    async load(id) {
      return runLoad(state, this, id);
    },
    async hotUpdate(hotUpdate) {
      return runHotUpdate(state, hotUpdate);
    },
  };

  return [transform, codegen, ...vitePluginsOf(options.plugins)];
}
