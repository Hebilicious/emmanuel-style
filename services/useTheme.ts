import { ref } from "nuxt-composition-api"

const currentTheme = ref("")

const themesList = new Map([
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

const navcolorMap = new Map([
    ["paper", "#fef1e0"],
    ["light", "#fdfaf5"],
    ["dark", "#1b1c31"],
    ["pink", "#b2f2e4"]
])

export const useTheme = () => {
    const selectTheme = (themeName = "pink") => {
        const theme = themesList.get(themeName)
        if (!theme) throw new Error(`Theme ${themeName} doesn't exist.`)
        window.localStorage.setItem("theme", JSON.stringify({ themeName, color: navcolorMap.get(themeName) }))
        currentTheme.value = theme
    }
    return { currentTheme, themesList, selectTheme, setNavbarColor }
}
