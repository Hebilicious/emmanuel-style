import { registerSW } from "virtual:pwa-register"

registerSW({
	immediate: true,
	onRegistered(registration: ServiceWorkerRegistration | undefined) {
		console.log("Service Worker registered:", registration)
		if (registration) {
			setInterval(
				() => {
					console.log("🔄 Checking for updates (periodic)...")
					registration.update()
				},
				5 * 60 * 1000
			) // 5 minutes
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

const update = () => {
	navigator.serviceWorker?.getRegistration().then((registration) => {
		registration?.update()
	})
}
// Check for updates when user returns to the tab
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) {
		console.log("🔄 Checking for updates (tab visible)...")
		update()
	}
})

// Check for updates on every page load/reload
window.addEventListener("load", () => {
	console.log("🔄 Checking for updates (page load)...")
	update()
})

// Check for updates when the user comes back online
window.addEventListener("online", () => {
	console.log("🔄 Checking for updates (back online)...")
	update()
})
