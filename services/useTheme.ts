import { ref } from "nuxt-composition-api"

const currentTheme = ref("DarkTheme")

const themesList = new Map([
    ["paper", "PaperTheme"],
    ["light", "LightTheme"],
    ["dark", "DarkTheme"],
    ["pink", "PinkTheme"]
])

export const useTheme = () => {
    const selectTheme = (themeName = "pink") => {
        const theme = themesList.get(themeName)
        if (!theme) throw new Error(`Theme ${themeName} doesn't exist.`)
        currentTheme.value = theme
    }
    return { currentTheme, themesList, selectTheme }
}
