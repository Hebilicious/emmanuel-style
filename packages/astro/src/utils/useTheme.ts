import { useColorMode } from "@vueuse/core"
import { onMounted, ref, watch } from "vue"

export type Theme = "pink" | "dark" | "paper" | "light"

export const themesList = new Map<Theme, string>([
	["light", "LightTheme"],
	["dark", "DarkTheme"],
	["paper", "PaperTheme"],
	["pink", "PinkTheme"]
])

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

const applyTheme = (theme: Theme) => {
	if (!isClient()) return

	// Apply theme class to body
	document.body.className = "" // Clear existing theme classes
	const themeClass = themesList.get(theme)
	if (themeClass) {
		document.body.classList.add(themeClass)
	}

	// Set navbar color
	const color = getComputedStyle(document.body).getPropertyValue("--navbarColor")
	setNavbarColor(color)
}

export const useTheme = () => {
	const rootRef = ref<HTMLElement | null>(null)
	const mode = useColorMode<Theme>({
		modes: Object.fromEntries(themesList) as Partial<Record<Theme, string>>,
		initialValue: "pink"
	})

	const selectTheme = (themeName: Theme = "pink") => {
		mode.value = themeName
	}

	watch(mode, () => applyTheme(mode.value as Theme), { immediate: true })

	onMounted(() => applyTheme(mode.value as Theme))

	return { mode, themesList, selectTheme, setNavbarColor, rootRef }
}
