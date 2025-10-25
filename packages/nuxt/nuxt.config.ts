// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
	modules: ["@nuxt/image", "@unocss/nuxt", "@vite-pwa/nuxt", "@vueuse/nuxt"],
	app: {
		head: {
			link: [
				{
					rel: "stylesheet",
					href: "https://cdnjs.cloudflare.com/ajax/libs/animate.css/4.1.1/animate.min.css"
				}
			],
			title: "Emmanuel",
			meta: [
				{
					hid: "description",
					name: "description",
					content: "Emmanuel's landing page."
				}
			]
		}
	},
	pwa: {
		// meta: {
		//     title: "Emmanuel Style",
		//     author: "Emmanuel",
		//     favicon: true
		// },
		registerType: "autoUpdate",
		workbox: {
			navigateFallback: "/",
			globPatterns: ["**/*.{js,css,html,png,svg,ico}"]
		},
		client: {
			installPrompt: true
		},
		devOptions: {
			enabled: true,
			suppressWarnings: true,
			navigateFallbackAllowlist: [/^\/$/],
			type: "module"
		},
		manifest: {
			name: "Emmanuel",
			lang: "en",
			orientation: "portrait",
			short_name: "NuxtVitePWA",
			theme_color: "#ffffff",
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
	},
	devtools: { enabled: true },
	routeRules: {
		"/": { prerender: true }
	},
	vite: {
		vue: {
			script: {
				defineModel: true,
				propsDestructure: true
			}
		}
	},
	css: ["@unocss/reset/tailwind.css", "~/assets/css/main.css"],
	postcss: {
		plugins: {
			autoprefixer: {},
			"postcss-nested": {},
			"postcss-100vh-fix": {},
			"postcss-viewport-height-correction": {}
		}
	},
	image: {
		inject: true,
		provider: "imagekit",
		imagekit: {
			baseURL: "https://ik.imagekit.io/hebilicious"
		}
	},
	experimental: {
		renderJsonPayloads: true,
		payloadExtraction: true,
		typedPages: true,
		componentIslands: true,
		viewTransition: true
	}
})
