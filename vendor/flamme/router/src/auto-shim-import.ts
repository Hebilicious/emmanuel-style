/**
 * The literal `$flamme/auto-routes` import, in a module of its own.
 *
 * The specifier has to be a literal inside the `import()` call for a bundler to resolve it while it
 * builds. That is what lets the Flamme Vite plugin's `resolveId`/`load` hooks answer it
 * (`packages/vite/src/virtual.ts`), and what keeps the emitted chunk free of a bare specifier a
 * browser would reject at runtime. Held in a variable instead, the chunk contains
 * `import(theVariable)` and the plugin never sees the specifier.
 *
 * `auto-shim.ts` imports this module dynamically, on purpose: a transform that cannot resolve the
 * specifier (no Flamme plugin, no `$flamme` alias: vitest in a jsdom environment, a dev server
 * outside a Flamme setup) fails the transform of whatever module carries the literal, so keeping it
 * one hop down leaves the failure at the shim import the router catches and classifies, instead of
 * failing the transform of `@flamme/router/auto` itself.
 */

/** Imports the generated shim for its side effect; the namespace is not read. */
export async function importAutoRoutes(): Promise<void> {
  await import('$flamme/auto-routes');
}
