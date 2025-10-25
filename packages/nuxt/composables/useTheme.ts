export type Theme = "pink" | "dark" | "paper" | "light"

const themesList = new Map<Theme, string>([
	["light", "LightTheme"],
	["dark", "DarkTheme"],
	["paper", "PaperTheme"],
	["pink", "PinkTheme"]
])

const upsertMetaNav = ({ color = "", name = "" }) => {
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

export const useTheme = () => {
	const rootRef = ref<HTMLElement | null>(null)
	const mode = useColorMode({
		modes: {
			light: "LightTheme",
			dark: "DarkTheme",
			paper: "PaperTheme",
			pink: "PinkTheme"
		}
	})

	const selectTheme = (themeName: Theme = "pink") => {
		mode.value = themeName
	}

	watch(mode, () => {
		if (process.server) return // client only
		if (rootRef.value === null) return
		const color = getComputedStyle(rootRef.value).getPropertyValue("--navbarColor")
		setNavbarColor(color)
	})

	return { mode: ref(mode), themesList, selectTheme, setNavbarColor, rootRef }
}
