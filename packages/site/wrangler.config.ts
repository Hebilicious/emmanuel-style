import { defineWranglerConfig } from "wrangler/experimental-config"

/** Where the site's files are, for `cf build`: what `@emmanuel/flamme` builds. */
export default defineWranglerConfig({
	assetsDirectory: "../flamme/dist"
})
