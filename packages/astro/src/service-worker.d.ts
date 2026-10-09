/**
 * Type for the precache manifest that `workbox-build`'s `injectManifest`
 * replaces at build time. Kept out of the worker source so the token appears
 * exactly once there, which is what the injector requires.
 */
interface ServiceWorkerGlobalScope {
	__WB_MANIFEST: Array<{ url: string; revision: string | null }>
}
