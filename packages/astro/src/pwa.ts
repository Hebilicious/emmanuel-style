import { registerSW } from "virtual:pwa-register"

registerSW({
	immediate: true,
	onRegistered(registration: ServiceWorkerRegistration | undefined) {
		console.log("Service Worker registered:", registration)

		// Check for updates periodically (every hour)
		if (registration) {
			setInterval(
				() => {
					registration.update()
				},
				60 * 60 * 1000
			) // 1 hour
		}
	},
	onRegisterError(error: Error) {
		console.error("Service Worker registration error:", error)
	},
	onOfflineReady() {
		console.log("App ready to work offline")
	},
	onNeedRefresh() {
		console.log("New content available, please refresh")
	}
})
