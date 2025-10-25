import { defineConfig, fontProviders } from "astro/config"
import AstroPWA from "@vite-pwa/astro"
import vue from "@astrojs/vue"

export default defineConfig({
	integrations: [
		AstroPWA({
			registerType: "autoUpdate",
			workbox: {
				navigateFallback: "/",
				globPatterns: ["**/*.{js,css,html,png,svg,ico,webp}"]
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
				optimizedFallbacks: true
			},
			{
				provider: fontProviders.google(),
				name: "Aclonica",
				cssVariable: "--font-aclonica",
				weights: ["400"],
				styles: ["normal"],
				subsets: ["latin"],
				optimizedFallbacks: true
			}
		]
	}
})
