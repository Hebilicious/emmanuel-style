/**
 * Virtual module ids (`spec/spec.md` §10.2). The `\0` prefix is Vite's
 * convention for ids no other plugin may resolve; our namespace is distinct
 * from plugin-vue's `?vue&type=…` requests and from Vize's ids.
 */

/** The dev-only manifest module the client can import. */
export const MANIFEST_VIRTUAL_ID = 'virtual:flamme/manifest';

/** The resolved id of {@link MANIFEST_VIRTUAL_ID}. */
export const MANIFEST_RESOLVED_ID = '\0flamme:manifest';

/**
 * The virtual module `@flamme/router/auto` imports to install the generated route table.
 *
 * The router package cannot statically import a file that does not exist until codegen has run, so
 * `@flamme/router`'s `auto-shim-import` module holds a **literal** dynamic import of this specifier
 * and our `resolveId`/`load` answer it. The literal matters: a specifier held in a variable reaches
 * the browser bundle unresolved. The same module is also written to disk as
 * `<runtimeDir>/auto-routes.ts`, so the generated tree stays inspectable.
 */
export const ROUTES_VIRTUAL_ID = '$flamme/auto-routes';

/** The resolved id of {@link ROUTES_VIRTUAL_ID}. */
export const ROUTES_RESOLVED_ID = '\0flamme:auto-routes';

/** Splits an id into its path and its query string. */
export function splitId(id: string): { readonly file: string; readonly query: string | undefined } {
  const at = id.indexOf('?');
  return at === -1 ? { file: id, query: undefined } : { file: id.slice(0, at), query: id.slice(at + 1) };
}

/**
 * The `.vue` file behind Vize's compiled-module id, or `undefined` for any other
 * id (`research/vize.md` §D/§E.2: `<abs>.vue.ts?vue&vize`, the module id the
 * Vize Vite plugin serves a compiled SFC under). The whole secondary strategy
 * keys off this one shape and nothing else about Vize, so a Vize that serves the
 * SFC under its own path, or no Vize at all, leaves this `undefined`.
 *
 * The `?vue&vize` query is matched as parameters, so an extra flag on the same
 * request still resolves; a plain `Foo.vue.ts` module never carries it.
 */
export function vizeCompiledFile(id: string): string | undefined {
  const { file, query } = splitId(id);
  if (query === undefined || !file.endsWith('.vue.ts')) {
    return undefined;
  }
  const params = new URLSearchParams(query);
  if (!params.has('vue') || !params.has('vize')) {
    return undefined;
  }
  return file.slice(0, -'.ts'.length);
}
