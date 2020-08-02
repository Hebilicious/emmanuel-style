<template>
    <div v-show="isReady" id="rootId" ref="rootRef" :class="['Root', currentTheme]">
        <div class="MainContainer">
            <div class="Landing">
                <div class="Top">
                    <div class="ContentWrapper">
                        <div class="Content">
                            <div class="Heading">
                                <picture>
                                    <source :srcSet="require('~/assets/Profile.png?webp')" type="image/webp" />
                                    <source :srcSet="require('~/assets/Profile.png')" type="image/png" />
                                    <img alt="profilePicture" :src="require('~/assets/Profile.png')" />
                                </picture>
                            </div>
                            <div class="Name">
                                <h2>Emmanuel LD</h2>
                            </div>
                            <div class="Logos">
                                <div class="Icons">
                                    <ExternalLink label="twitter" url="twitter.com/its_hebilicious">
                                        <Twitter :icon-height="iconHeight" />
                                    </ExternalLink>
                                    <ExternalLink label="github" url="github.com/Hebilicious">
                                        <Github :icon-height="iconHeight" />
                                    </ExternalLink>
                                    <ExternalLink label="linkedIn" url="www.linkedin.com/in/emmanuel-donnet">
                                        <LinkedIn :icon-height="iconHeight" />
                                    </ExternalLink>
                                </div>
                            </div>
                            <div class="MainText">
                                <div>
                                    I live in London.
                                </div>
                                <div>
                                    I do computer things.
                                </div>
                            </div>
                            <div class="SubText">
                                The noblest pleasure is the joy of understanding.
                                <br />
                                - DaVinci
                            </div>
                        </div>
                        <div :class="SideName">
                            <h1>
                                <span>E</span><span>m</span><span>m</span><span>a</span><span>n</span><span>u</span
                                ><span>e</span><span>l</span>
                            </h1>
                        </div>
                    </div>
                    <div class="Separation">
                        <div></div>
                        <div class="FakeLine"></div>
                    </div>
                </div>

                <div class="Bottom">
                    <div class="ThemeSwitcher">
                        <ThemeButton v-for="theme in themesList" :key="theme[0]" :theme="theme" />
                    </div>
                    <div class="Initials"></div>
                </div>
            </div>
        </div>
        <!-- <div class="MainContainer"></div> -->
    </div>
</template>

<script lang="ts">
import { useTheme } from "@/services/useTheme"
import { defineComponent, watch, ref, onBeforeMount, computed } from "nuxt-composition-api"

export default defineComponent({
    name: "Index",
    setup() {
        // @ts-ignore
        const rootRef = ref<HTMLElement>(null)
        const isReady = ref(false)
        const { currentTheme, themesList, selectTheme, setNavbarColor } = useTheme()
        // Change the color of mobile navbar
        watch(currentTheme, () => {
            if (rootRef.value === null) return
            const color = getComputedStyle(rootRef.value).getPropertyValue("--navbarColor")
            setNavbarColor(color)
        })
        // Rainbow text
        const SideName = computed(() => {
            return { SideName: true, PaperSideName: currentTheme.value === "PaperTheme" }
        })

        onBeforeMount(() => {
            const saved = window.localStorage.getItem("theme")
            const { themeName, color } = saved ? JSON.parse(saved) : { themeName: "dark", color: "#1b1c31" }
            selectTheme(themeName)
            setNavbarColor(color)
            isReady.value = true
        })
        // dirty set default theme color
        return { currentTheme, themesList, selectTheme, rootRef, isReady, SideName, iconHeight: "1.5rem" }
    }
})
</script>

<style lang="postcss">
.MainContainer {
    /* Force landscape hack */
    @screen mLandscape {
        height: 100vmax !important;
    }

    position: relative;
    height: 100vh;
    width: 100vw;
    display: flex;
    background: var(--primaryBackground);
    color: var(--primaryText);
    transition: background 1s ease;
}

.Landing {
    height: auto;
    width: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
}

.Top {
    display: flex;
    flex-direction: column;
    position: relative;
}

.ContentWrapper {
    @apply pl-8 pr-6 pb-5;

    display: grid;
    grid-template-columns: 1fr 2rem;
}

.SideName {
    display: grid;
    place-items: center;
    transition: color 0.5s ease-in-out;

    h1 {
        @apply text-4xl;

        transform: rotate(180deg);
        writing-mode: vertical-rl;
        font-family: Aclonica, sans-serif;
        text-transform: uppercase;
        color: var(--giantText);
    }

    &.PaperSideName {
        h1 {
            span {
                color: black;
                transition: color 0.5s ease-in-out;
                &:nth-child(1) {
                    color: var(--ultraMarine);
                }
                &:nth-child(2) {
                    color: var(--lightBlue);
                }
                &:nth-child(3) {
                    color: var(--lightGreen);
                }
                &:nth-child(4) {
                    color: var(--darkBeige);
                }
                &:nth-child(5) {
                    color: var(--golden);
                }
                &:nth-child(6) {
                    color: var(--lightPink);
                }
                &:nth-child(7) {
                    color: var(--vividPink);
                }
                &:nth-child(8) {
                    color: var(--green);
                }
            }
        }
    }
}

.Content {
    display: grid;
    gap: 1rem;

    .Heading {
        @apply pt-24;
        @screen mLandscape {
            @apply pt-8;
        }

        img {
            height: 5rem;
            width: auto;
            border-radius: 100%;
            object-fit: contain;
            box-shadow: -10px 15px 30px 0 rgba(0, 0, 0, 0.13);
        }
    }
    .Name {
        @apply text-3xl font-bold;
    }
}

.SubText {
    @apply text-sm italic;
}

.Separation {
    --height: 3px;

    display: grid;
    width: 100%;
    height: var(--height);
    grid-template-columns: 60% auto;
    .FakeLine {
        background: var(--activeBorder) no-repeat center/100% var(--height);
    }
}

.Icons {
    width: 50vmin;
    display: flex;
    justify-content: space-between;
}

.ThemeSwitcher {
    @apply pl-8 pb-6;

    width: 70vmin;
    display: grid;
    grid-auto-flow: column;
    place-items: center;
}
</style>
