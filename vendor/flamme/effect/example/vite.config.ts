/**
 * The example's entry file: `vite dev` from this directory serves it.
 *
 * The aliases point every workspace package at its sources, so the example runs from a checkout
 * without a build. A real app resolves the same specifiers through its package manifest.
 */
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // the subpath entry must precede the bare one: Vite picks the first alias whose key is a prefix
      '@flamme/effect/vue': new URL('../src/vue/index.ts', import.meta.url).pathname,
      '@flamme/effect': new URL('../src/index.ts', import.meta.url).pathname,
      '@flamme/runtime': new URL('../../runtime/src/index.ts', import.meta.url).pathname,
      '@flamme/local': new URL('../../local/src/index.ts', import.meta.url).pathname,
    },
  },
});
