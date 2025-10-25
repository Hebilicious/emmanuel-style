import vue from "@astrojs/vue"
import AstroPWA from "@vite-pwa/astro"
import { defineConfig, fontProviders } from "astro/config"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import rehypeSlug from "rehype-slug"

export default defineConfig({
	site: "https://emmanuel.style",
	markdown: {
		rehypePlugins: [
			rehypeSlug,
			[rehypeAutolinkHeadings, { behavior: "wrap", properties: { className: ["heading-link"] } }]
		]
	},
	integrations: [
		AstroPWA({
			registerType: "autoUpdate",
			workbox: {
				navigateFallback: "/",
				// Include fonts and all assets for offline support
				globPatterns: ["**/*.{js,css,html,png,svg,ico,webp,woff,woff2,otf,ttf}"],
				// Cache Google Fonts
				runtimeCaching: [
					{
						urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
						handler: "CacheFirst",
						options: {
							cacheName: "google-fonts-cache",
							expiration: {
								maxEntries: 10,
								maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					},
					{
						urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
						handler: "CacheFirst",
						options: {
							cacheName: "gstatic-fonts-cache",
							expiration: {
								maxEntries: 10,
								maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					},
					// Cache images
					{
						urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/i,
						handler: "CacheFirst",
						options: {
							cacheName: "images-cache",
							expiration: {
								maxEntries: 50,
								maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
							}
						}
					},
					// Cache local fonts
					{
						urlPattern: /\.(?:woff|woff2|ttf|otf)$/i,
						handler: "CacheFirst",
						options: {
							cacheName: "fonts-cache",
							expiration: {
								maxEntries: 20,
								maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					},
					// Cache CSS and JS
					{
						urlPattern: /\.(?:css|js)$/i,
						handler: "StaleWhileRevalidate",
						options: {
							cacheName: "static-resources",
							expiration: {
								maxEntries: 30,
								maxAgeSeconds: 60 * 60 * 24 * 7 // 7 days
							}
						}
					}
				]
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
