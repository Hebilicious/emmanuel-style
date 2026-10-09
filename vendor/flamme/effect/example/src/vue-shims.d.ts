/**
 * The one ambient declaration the example needs: a `*.vue` specifier.
 *
 * `moon run effect:typecheck` uses `vue-tsc`, which resolves a `.vue` file to its real component
 * type and checks the script block. Vitest's own typecheck pass spawns plain `tsc` (the root
 * `vitest.config.ts` fixes the checker per project), and `tsc` has no idea what a `.vue` file is;
 * this declaration is what it resolves instead, so the type tests and the sources compile under both
 * checkers. It never hides an error in an SFC: `vue-tsc` prefers the real file.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
