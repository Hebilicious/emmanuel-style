import vize from "@vizejs/vite-plugin"
import { defineConfig } from "vite"
import { flamme } from "@flamme/vite"

/**
 * The Vite config for the Flamme build of emmanuel.style.
 *
 * Vize compiles the SFCs. Its plugin is `enforce: 'pre'` and serves every `.vue`
 * file as its own compiled module, `<abs>.vue.ts?vue&vize`, so Flamme never sees
 * the SFC source. Flamme handles that id on its secondary path: it rewrites the
 * `graphql()` tags and `.gql` imports inside the compiled module instead, with the
 * same artifact index. `@vitejs/plugin-vue` is not in the list at all, because it
 * would try to read `<abs>.vue.ts` as an SFC and fail with ENOENT.
 *
 * With `vize()` in the list, Flamme also picks Vize's native analyzer for its own
 * SFC scan, so the Rust toolchain parses the components end to end.
 */
export default defineConfig({
	plugins: [vize(), flamme()],
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
