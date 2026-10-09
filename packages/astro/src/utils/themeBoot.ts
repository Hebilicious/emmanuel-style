import { THEME_STORAGE_KEY, themeMap } from "./useTheme"

/**
 * Boot script: decide the theme before first paint so there is no flash.
 *
 * Exported as a string because it is injected inline by Layout.astro; a module
 * script would run too late for the first frame.
 */
export const themeBootScript = `;(function () {
	var STORAGE_KEY = ${JSON.stringify(THEME_STORAGE_KEY)}
	var themeMap = ${JSON.stringify(themeMap)}
	try {
		var stored = localStorage.getItem(STORAGE_KEY)
		var preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
		var theme = themeMap[stored] || themeMap[preferred]
		document.documentElement.classList.add(theme)
	} catch (error) {
		document.documentElement.classList.add(themeMap.light)
	}
})()`
