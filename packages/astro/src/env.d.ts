/// <reference types="astro/client" />

// Virtual modules provided by @vite-pwa/astro
declare module "virtual:pwa-register" {
	export interface RegisterSWOptions {
		immediate?: boolean
		onNeedRefresh?: () => void
		onOfflineReady?: () => void
		onRegistered?: (registration: ServiceWorkerRegistration | undefined) => void
		onRegisterError?: (error: Error) => void
	}

	export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>
}

declare module "virtual:pwa-info" {
	export interface PwaInfo {
		webManifest: {
			href: string
			useCredentials: boolean
			linkTag: string
		}
	}
	export const pwaInfo: PwaInfo | undefined
}

type Runtime = import("@astrojs/cloudflare").Runtime<Env>

declare namespace App {
	interface Locals extends Runtime {}
}
