import presetUno from "@unocss/preset-uno"
import presetWebFonts from "@unocss/preset-web-fonts"
import transformerDirectives from "@unocss/transformer-directives"
import { defineConfig } from "unocss"

export default defineConfig({
	presets: [
		presetUno(),
		presetWebFonts({
			provider: "google",
			fonts: {
				aclonica: [{ name: "Aclonica", weights: [400], provider: "google" }],
				dosis: [{ name: "Dosis", weights: [400], provider: "google" }]
			}
		})
	],
	transformers: [transformerDirectives()]
})
