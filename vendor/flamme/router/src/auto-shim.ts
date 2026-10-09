/**
 * The one import of the generated `$flamme/auto-routes` shim.
 *
 * `@flamme/router` cannot statically import a file that does not exist when the package is
 * compiled, so {@link createFlammeRouter} imports the shim dynamically and the shim calls
 * `setGeneratedRoutes` once at import time. The specifier is a **literal**, written in
 * `auto-shim-import.ts`, so a bundler resolves the import while it builds: the Flamme Vite plugin
 * answers `$flamme/auto-routes` from its own `resolveId`/`load` hooks
 * (`packages/vite/src/virtual.ts`), which is what puts the generated module in the bundle. Held in a
 * variable instead, the emitted chunk contains `import(theVariable)`, the plugin never sees the
 * specifier, and the browser is handed a bare specifier it rejects at runtime.
 *
 * The literal sits one dynamic hop down for the environments that have no answer for the specifier
 * at all: a transform that cannot resolve it fails, and failing here, at the import the router
 * catches, is what lets `isMissingShimError` (`auto.ts`) read the failure as "there is no shim".
 * Failing in this module instead would fail the transform of `@flamme/router/auto` itself, before a
 * router can be created.
 *
 * The default importer is replaceable through {@link setGeneratedShimImporter} so this package's
 * tests can raise the failures a bundler or a browser would without a Flamme build; the setter is
 * internal to the package and is not re-exported from a public entry.
 */

/** The `$flamme/auto-routes` specifier the Vite plugin generates and `auto-shim-import.ts` imports. */
export const GENERATED_SHIM_ID = '$flamme/auto-routes';

/** How the generated shim is loaded; the namespace is not read, only the side effect matters. */
export type GeneratedShimImporter = () => Promise<unknown>;

/** The production import: the literal specifier, imported on demand. */
const defaultImporter: GeneratedShimImporter = async () => {
  const shim = await import('./auto-shim-import.js');
  await shim.importAutoRoutes();
};

let importer: GeneratedShimImporter = defaultImporter;

/**
 * Replaces the importer `importGeneratedShim` uses. Internal: this package's tests raise a bundler's
 * or a browser's failure through it, and no public entry re-exports it.
 */
export function setGeneratedShimImporter(next: GeneratedShimImporter): void {
  importer = next;
}

/**
 * Imports the generated shim, whose only job is to call `setGeneratedRoutes`; its namespace is not
 * read.
 */
export async function importGeneratedShim(): Promise<void> {
  await importer();
}
