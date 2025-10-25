import { registerSW } from "virtual:pwa-register"

registerSW({
	immediate: true,
	onRegistered(registration: ServiceWorkerRegistration | undefined) {
		console.log("Service Worker registered:", registration)
	},
	onRegisterError(error: Error) {
		console.error("Service Worker registration error:", error)
	}
})
