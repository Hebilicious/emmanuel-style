/**
 * `$flamme/auto-routes`, as far as TypeScript is concerned.
 *
 * The module does not exist when this package is compiled: the Flamme Vite plugin generates it into
 * the app's runtime directory and answers the specifier from its `resolveId`/`load` hooks, so the
 * literal dynamic import in `auto-shim.ts` has no file on disk to resolve against while `tsc` runs.
 * This shorthand ambient declaration is what lets that literal compile. It declares no runtime
 * module, and it is not part of an app's program: an app that has a generated tree resolves the
 * specifier through its own `$flamme/*` path mapping.
 */
declare module '$flamme/auto-routes';
