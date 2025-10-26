import vue from "@astrojs/vue"
import rehypeFigure from "@microflash/rehype-figure"
import AstroPWA from "@vite-pwa/astro"
import { defineConfig, fontProviders } from "astro/config"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import rehypeSlug from "rehype-slug"

export default defineConfig({
	site: "https://emmanuel.style",
	markdown: {
		gfm: true,
		rehypePlugins: [
			rehypeSlug,
			[rehypeAutolinkHeadings, { behavior: "wrap", properties: { className: ["heading-link"] } }],
			[rehypeFigure, { className: "prose-figure" }]
		]
	},
	integrations: [
		AstroPWA({
			registerType: "autoUpdate",
			workbox: {
				globDirectory: "dist",
				navigateFallback: null,
				maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB
				globPatterns: ["**/*.{html,js,css,ico,png,jpg,jpeg,svg,gif,webp,woff,woff2,otf,ttf}"]
			},
			devOptions: {
				enabled: true,
				suppressWarnings: true,
				navigateFallbackAllowlist: [/^\/$/],
				type: "module"
			},
			manifest: {
				name: "Emmanuel",
				short_name: "Emmanuel",
				description: "Emmanuel's landing page.",
				lang: "en",
				orientation: "portrait",
				theme_color: "#ffffff",
				background_color: "#ffffff",
				display: "standalone",
				icons: [
					{
						src: "pwa-192x192.png",
						sizes: "192x192",
						type: "image/png"
					},
					{
						src: "pwa-512x512.png",
						sizes: "512x512",
						type: "image/png"
					},
					{
						src: "pwa-512x512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "any maskable"
					}
				]
			}
		}),
		vue()
	],
	vite: {
		css: {
			transformer: "lightningcss"
		}
	},
	experimental: {
		fonts: [
			{
				provider: fontProviders.google(),
				name: "Dosis",
				cssVariable: "--font-dosis",
				weights: ["400"],
				styles: ["normal"],
				subsets: ["latin"],
				display: "swap",
				optimizedFallbacks: true
			},
			{
				provider: fontProviders.google(),
				name: "Aclonica",
				cssVariable: "--font-aclonica",
				weights: ["400"],
				styles: ["normal"],
				subsets: ["latin"],
				display: "swap",
				optimizedFallbacks: true
			},
			{
				provider: "local",
				name: "Monaspace Argon",
				cssVariable: "--font-monaspace",
				variants: [
					{
						weight: 400,
						style: "normal",
						src: ["./fonts/MonaspaceArgon-Regular.otf"],
						display: "swap"
					},
					{
						weight: 500,
						style: "normal",
						src: ["./fonts/MonaspaceArgon-Medium.otf"],
						display: "swap"
					},
					{
						weight: 700,
						style: "normal",
						src: ["./fonts/MonaspaceArgon-Bold.otf"],
						display: "swap"
					}
				],
				fallbacks: ["monospace"],
				optimizedFallbacks: true
			}
		]
	}
})
