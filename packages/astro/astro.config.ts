import { rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { unified } from "@astrojs/markdown-remark"
import vue from "@astrojs/vue"
import rehypeFigure from "@microflash/rehype-figure"
import type { AstroIntegration } from "astro"
import { defineConfig, fontProviders } from "astro/config"
import esbuild from "esbuild"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import rehypeSlug from "rehype-slug"
import { injectManifest } from "workbox-build"

/** The installable web app manifest, written next to the built pages. */
const webManifest = {
	name: "Emmanuel",
	short_name: "Emmanuel",
	description: "Emmanuel's landing page.",
	start_url: "/",
	scope: "/",
	display: "standalone",
	lang: "en",
	orientation: "portrait",
	theme_color: "#0f0e0c",
	background_color: "#0f0e0c",
	icons: [
		{ src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
		{ src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
		{
			src: "pwa-512x512.png",
			sizes: "512x512",
			type: "image/png",
			purpose: "any maskable"
		}
	]
}

/**
 * Offline support.
 *
 * Astro renders the pages in a server build, which is not the build the PWA
 * plugins hook into, so the service worker and the manifest are written here,
 * after every asset exists on disk.
 *
 * `injectManifest` is used rather than `generateSW` because navigation needs
 * custom handling: pages are built as directories, and Workbox's built-in
 * precache route only matches the trailing-slash spelling while the site's
 * links omit it. `injectManifest` does not compile or bundle its input, so the
 * worker is bundled with esbuild first and the manifest is injected into that
 * output.
 */
const offlineSupport = (): AstroIntegration => ({
	name: "offline-support",
	hooks: {
		"astro:build:done": async ({ dir, logger }) => {
			const outDir = fileURLToPath(dir)

			await writeFile(
				new URL("manifest.webmanifest", dir),
				JSON.stringify(webManifest, null, 2),
				"utf8"
			)

			const swSrc = fileURLToPath(new URL("./src/service-worker.ts", import.meta.url))
			const bundled = `${outDir}/.sw-bundled.js`

			await esbuild.build({
				entryPoints: [swSrc],
				outfile: bundled,
				bundle: true,
				format: "esm",
				target: "es2022",
				// Warnings are surfaced below with the rest of the build output.
				logLevel: "warning"
			})

			const { count, size, warnings } = await injectManifest({
				swSrc: bundled,
				swDest: `${outDir}/sw.js`,
				globDirectory: outDir,
				globPatterns: [
					"**/*.{html,js,css,ico,png,svg,jpg,jpeg,webp,woff,woff2,otf,ttf,webmanifest}"
				],
				globIgnores: ["sw.js", "workbox-*.js", ".sw-bundled.js"],
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024
			})

			await rm(bundled, { force: true })

			for (const warning of warnings) logger.warn(warning)
			logger.info(`precached ${count} files (${(size / 1024 / 1024).toFixed(2)} MB)`)
		}
	}
})

/**
 * Nothing here reaches out to a third party at runtime: fonts are copied into
 * the build and the service worker precaches every emitted asset, so the site
 * loads with the network switched off.
 */ export default defineConfig({
	site: "https://emmanuel.style",
	/** The blog lives at /blog. Earlier builds nested it under /library. */
	redirects: {
		"/library/blog": "/blog",
		"/library/blog/[...slug]": "/blog/[...slug]"
	},
	markdown: {
		processor: unified({
			gfm: true,
			rehypePlugins: [
				rehypeSlug,
				[rehypeAutolinkHeadings, { behavior: "wrap", properties: { className: ["heading-link"] } }],
				[rehypeFigure, { className: "prose-figure" }]
			]
		})
	},
	integrations: [vue(), offlineSupport()],
	fonts: [
		{
			provider: fontProviders.local(),
			name: "Nabla",
			cssVariable: "--font-nabla",
			fallbacks: ["Monaspace Argon", "monospace"],
			optimizedFallbacks: false,
			options: {
				variants: [
					{
						/**
						 * Nabla is a COLRv1 colour font with no outlines, and its
						 * palettes cannot be overridden yet, so it is loaded as a
						 * colour face and re-coloured on the compositor. See the
						 * `.display` rule in styles/global.css.
						 */
						src: [{ url: "./fonts/Nabla[EDPT,EHLT].ttf", tech: "color-COLRv1" }],
						weight: "400 700",
						style: "normal",
						display: "swap"
					}
				]
			}
		},
		{
			provider: fontProviders.local(),
			name: "Monaspace Argon",
			cssVariable: "--font-monaspace",
			fallbacks: ["ui-monospace", "monospace"],
			options: {
				variants: [
					{
						src: ["./fonts/MonaspaceArgon-Regular.otf"],
						weight: "400",
						style: "normal",
						display: "swap"
					},
					{
						src: ["./fonts/MonaspaceArgon-Medium.otf"],
						weight: "500",
						style: "normal",
						display: "swap"
					},
					{
						src: ["./fonts/MonaspaceArgon-Bold.otf"],
						weight: "700",
						style: "normal",
						display: "swap"
					}
				]
			}
		}
	],
	vite: {
		css: {
			transformer: "lightningcss"
		},
		server: {
			/**
			 * In development the API worker runs on its own port (`pnpm dev` in
			 * packages/api). Proxying keeps the client on relative URLs, so the
			 * same code works deployed with no build-time base URL.
			 */
			proxy: {
				"/api": {
					target: process.env.API_DEV_ORIGIN ?? "http://localhost:8787",
					changeOrigin: true
				}
			}
		}
	}
})
