export default {
    /*
     ** Nuxt rendering mode
     ** See https://nuxtjs.org/api/configuration-mode
     */
    mode: "universal",
    /*
     ** Nuxt target
     ** See https://nuxtjs.org/api/configuration-target
     */
    target: "static",
    /*
     ** Headers of the page
     ** See https://nuxtjs.org/api/configuration-head
     */
    head: {
        htmlAttrs: {
            lang: "en"
        },
        title: "Emmanuel" ?? process.env.npm_package_name ?? "",
        meta: [
            { charset: "utf-8" },
            { name: "viewport", content: "width=device-width, initial-scale=1" },
            {
                hid: "description",
                name: "description",
                content: "Emmanuel's landing page."
            }
        ],
        link: [
            { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
            { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Dosis&display=swap" },
            { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Aclonica&display=swap" }
        ]
    },
    /*
     ** Global CSS
     */
    css: [],
    /*
     ** Plugins to load before mounting the App
     ** https://nuxtjs.org/guide/plugins
     */
    plugins: [],
    /*
     ** Auto import components
     ** See https://nuxtjs.org/api/configuration-components
     */
    components: true,
    /*
     ** Nuxt.js dev-modules
     */
    buildModules: [
        "@nuxt/typescript-build",
        "nuxt-composition-api",
        // Doc: https://github.com/nuxt-community/stylelint-module
        "@nuxtjs/stylelint-module",
        // Doc: https://github.com/nuxt-community/nuxt-tailwindcss
        "@nuxtjs/tailwindcss",
        "@aceforth/nuxt-optimized-images",
        "@nuxtjs/pwa"
    ],
    /*
     ** Nuxt.js modules
     */
    // modules: ["@nuxt/http"],

    http: {
        // proxyHeaders: false
    },
    /*
     ** Build configuration
     ** See https://nuxtjs.org/api/configuration-build/
     */
    build: {
        postcss: {
            plugins: {
                "postcss-nested": {},
                "postcss-100vh-fix": {},
                "postcss-viewport-height-correction": {}
            },
            preset: { stage: 0, autoprefixer: { grid: true, flexbox: true } }
        }
    },
    optimizedImages: {
        optimizeImages: true,
        optimizeImagesInDev: true
    },
    pwa: {
        manifest: {
            name: "Emmanuel",
            lang: "en",
            orientation: "portrait"
        }
    }
}
