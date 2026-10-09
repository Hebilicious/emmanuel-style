import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { flamme } from "@flamme/vite"

/**
 * The Vite config for the Flamme build of emmanuel.style.
 *
 * `flamme()` must precede the Vue compiler: its transform is `enforce: 'pre'`, and
 * it rewrites the document surfaces (the `graphql()` tag and `.gql` imports) to
 * artifact imports before anything else sees them.
 *
 * `@vitejs/plugin-vue` compiles the SFCs, and Vize is used as the analyzer rather
 * than as the compiler. Flamme's own note says why: `@vizejs/vite-plugin` is also
 * `enforce: 'pre'` and resolves every `.vue` request to its own compiled module
 * `<abs>.vue.ts?vue&vize`, so with `vize()` in the plugin list the Vue plugin later
 * tries to read `experience.vue.ts` as an SFC and fails with ENOENT.
 * `@flamme/vite` picks Vize's native analyzer up automatically when
 * `@vizejs/native` resolves, so the Rust toolchain is still what parses the SFCs.
 */
export default defineConfig({
	plugins: [flamme(), vue()],
	resolve: {
		/*
		 * One instance of Vue and its router in the bundle.
		 *
		 * The vendored framework packages resolve their own peer sets, so pnpm can
		 * place a second `vue-router` for them. Two copies mean two sets of injection
		 * keys, and `RouterView` then throws "Cannot read properties of undefined
		 * (reading 'value')" because it cannot find the router it is rendered under.
		 * Deduping at the bundler makes the app's copy the only one, whatever the
		 * layout in node_modules is.
		 */
		dedupe: ["vue", "vue-router"]
	},
	build: {
		outDir: "dist",
		sourcemap: true,
		cssCodeSplit: false
	},
	ssr: {
		external: ["@flamme/core", "@flamme/vite", "@emmanuel/schema"]
	}
})
