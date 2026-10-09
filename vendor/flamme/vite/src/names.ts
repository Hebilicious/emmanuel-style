/**
 * The two plugin names (`spec/spec.md` §10.1) live in their own module so the
 * options layer can name them without importing the plugin factories.
 */

/** The `enforce: 'pre'` transform plugin. */
export const TRANSFORM_PLUGIN_NAME = 'vite:flamme:transform';

/** The codegen/HMR/virtual-module plugin. */
export const CODEGEN_PLUGIN_NAME = 'vite:flamme';

/** The HMR event name the client listens on to drop cached documents (§4.8). */
export const ARTIFACT_UPDATE_EVENT = 'flamme:artifact-update';
