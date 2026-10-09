import { useColorMode } from "@vueuse/core"

/** The two surviving themes. `paper`, `pink` and the rest are gone. */
export type Theme = "light" | "dark"

/**
 * Storage key kept from the previous build so returning visitors keep the
 * theme they picked.
 */
export const THEME_STORAGE_KEY = "vueuse-color-scheme"

export const DEFAULT_THEME: Theme = "dark"

export const themesList = new Map<Theme, string>([
	["light", "LightTheme"],
	["dark", "DarkTheme"]
])

export const themeMap: Record<string, string> = {
	light: "LightTheme",
	dark: "DarkTheme"
}

export const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark"

const isClient = () => typeof document !== "undefined"

const upsertMeta = ({ color = "", name = "" }) => {
	if (!isClient()) return
	document.querySelector(`meta[name='${name}']`)?.remove()
	const meta = document.createElement("meta")
	meta.setAttribute("name", name)
	meta.setAttribute("content", color.trim())
	document.querySelector("head")?.appendChild(meta)
}

export const setNavbarColor = (color: string) => {
	upsertMeta({ color, name: "theme-color" })
	upsertMeta({ color, name: "msapplication-navbutton-color" })
	upsertMeta({ color, name: "apple-mobile-web-app-status-bar-style" })
}

/** Apply a theme class and repaint the browser chrome to match. */
export const applyTheme = (theme: Theme) => {
	if (!isClient()) return

	document.documentElement.classList.remove(...themesList.values())
	const themeClass = themesList.get(theme)
	if (themeClass) document.documentElement.classList.add(themeClass)

	const color = getComputedStyle(document.documentElement).getPropertyValue("--primaryBackground")
	setNavbarColor(color)
}

/**
 * Theme switching for Vue islands. The initial class is applied by the inline
 * script in Layout.astro, so this only reacts to later changes.
 */
export const useTheme = () => {
	const mode = useColorMode<Theme>({
		modes: Object.fromEntries(themesList) as Partial<Record<Theme, string>>,
		initialValue: DEFAULT_THEME,
		storageKey: THEME_STORAGE_KEY
	})

	const selectTheme = (theme: Theme = DEFAULT_THEME) => {
		mode.value = theme
	}

	const toggleTheme = () => {
		selectTheme(mode.value === "dark" ? "light" : "dark")
	}

	return { mode, themesList, selectTheme, toggleTheme, setNavbarColor }
}
