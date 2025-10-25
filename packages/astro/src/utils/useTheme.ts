import { useColorMode } from "@vueuse/core"
import { ref, watch } from "vue"

export type Theme = "pink" | "dark" | "paper" | "light"

export const DEFAULT_THEME: Theme = "dark"

export const themesList = new Map<Theme, string>([
	["light", "LightTheme"],
	["dark", "DarkTheme"],
	["paper", "PaperTheme"],
	["pink", "PinkTheme"]
])

export const themeMap: Record<string, string> = {
	light: "LightTheme",
	dark: "DarkTheme",
	paper: "PaperTheme",
	pink: "PinkTheme"
}

const isClient = () => typeof document !== "undefined"

const upsertMetaNav = ({ color = "", name = "" }) => {
	if (!isClient()) return
	document.querySelector(`meta[name='${name}']`)?.remove()
	const metaNav = document.createElement("meta")
	metaNav.setAttribute("name", name)
	metaNav.setAttribute("content", color.trim())
	document.querySelector("head")?.appendChild(metaNav)
}

const setNavbarColor = (color: string) => {
	upsertMetaNav({ color, name: "theme-color" }) // chrome
	upsertMetaNav({ color, name: "msapplication-navbutton-color" }) // win
	upsertMetaNav({ color, name: "apple-mobile-web-app-status-bar-style" }) // ios
}

/**
 * Apply theme class to document element and update navbar color
 * This only handles switching themes after initial load
 */
const applyTheme = (theme: Theme) => {
	if (!isClient()) return

	// Remove all theme classes and add the new one
	const themeClasses = Array.from(themesList.values())
	document.documentElement.classList.remove(...themeClasses)

	const themeClass = themesList.get(theme)
	if (themeClass) {
		document.documentElement.classList.add(themeClass)
	}

	// Update navbar color
	const color = getComputedStyle(document.documentElement).getPropertyValue("--navbarColor")
	setNavbarColor(color)
}

/**
 * Composable for theme switching in Vue components
 * Note: Initial theme is applied by the inline script in Layout.astro
 * This composable only handles user-initiated theme changes
 */
export const useTheme = () => {
	const rootRef = ref<HTMLElement | null>(null)
	const mode = useColorMode<Theme>({
		modes: Object.fromEntries(themesList) as Partial<Record<Theme, string>>,
		initialValue: DEFAULT_THEME
	})

	const selectTheme = (themeName: Theme = DEFAULT_THEME) => {
		mode.value = themeName
	}

	// Only watch for changes, don't apply on mount (already done by inline script)
	watch(mode, (newTheme) => {
		applyTheme(newTheme as Theme)
	})

	return { mode, themesList, selectTheme, setNavbarColor, rootRef }
}
