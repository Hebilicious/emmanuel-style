<template>
    <div :class="['Root', currentTheme]">
        <div class="MainContainer">
            <div class="Landing">
                <div class="Top">
                    <div class="ContentWrapper">
                        <div class="Content">
                            <div class="Heading">
                                <img src="~/assets/Profile.png" />
                            </div>
                            <div class="Name">
                                <h2>Emmanuel LD</h2>
                            </div>
                            <div class="Logos">
                                <div class="Icons">
                                    <ExternalLink url="twitter.com/its_hebilicious">
                                        <Twitter :icon-height="iconHeight" />
                                    </ExternalLink>
                                    <ExternalLink url="github.com/Hebilicious">
                                        <Github :icon-height="iconHeight" />
                                    </ExternalLink>
                                    <ExternalLink url="www.linkedin.com/in/emmanuel-donnet">
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
                                Lorem ipsum dolor sit amet, consectetur adipisicing elit. Perferendis ullam obcaecati,
                                dolore, non tempora veritatis unde debitis nisi laboriosam facilis, vero inventore nam
                                illum id nulla hic. Laborum, nesciunt tempore?
                            </div>
                        </div>
                        <div class="SideName">
                            <h1>Emmanuel</h1>
                        </div>
                    </div>
                    <div class="Separation">
                        <div>Head to my blog</div>
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
import { defineComponent } from "nuxt-composition-api"
export default defineComponent({
    name: "Index",
    setup() {
        const { currentTheme, themesList, selectTheme } = useTheme()
        return { currentTheme, themesList, selectTheme, iconHeight: "1.5rem" }
    }
})
</script>

<style lang="postcss">
:root {
    /* colors */
    ---black: #000;
    --white: #fff;
    --darkTheme: #1b1c31;
    --grey: #c6c6c6;
    --beige: #fdfaf5;
    --darkBeige: #fef1e0;
    --golden: #ffe5c4;
    --lightPink: #f4bed8;
    --vividPink: #ff8dd5;
    --darkPink: #ff7699;
    --ultraMarine: #7887fe;
    --lightBlue: #21bffe;
    --lightGreen: #91d7d9;
    --green: #6dd5be;
}

.PinkTheme {
    --primaryBackground: linear-gradient(28deg, #fef1e0 0%, #f4bed8 50%, #b2f2e4 100%);
    --primaryText: var(--black);
    --colorAccent: var(--black);
}

.PaperTheme {
    --primaryBackground: var(--darkBeige);
    --primaryText: var(--black);
    --colorAccent: var(--grey);
}

.LightTheme {
    --primaryBackground: var(--beige);
    --primaryText: var(--black);
    --colorAccent: var(--grey);
}

.DarkTheme {
    --primaryBackground: var(--darkTheme);
    --primaryText: var(--white);
    --colorAccent: var(--darkPink);
}

.MainContainer {
    @apply h-screen;

    background: var(--primaryBackground);
    color: var(--primaryText);
    width: 100vw;
    transition: background 0.5s ease;
}

.Landing {
    @apply h-full flex flex-col justify-between;
}

.Top {
    height: 60%;
}

.ContentWrapper {
    @apply pl-8 pr-8 pb-5;

    display: grid;
    grid-template-columns: 1fr 2rem;
}

.SideName {
    display: grid;
    place-items: center;

    h1 {
        @apply text-4xl;

        transform: rotate(180deg);
        writing-mode: vertical-rl;
    }
}

.Content {
    display: grid;
    gap: 1rem;

    .Heading {
        @apply pt-24;

        img {
            height: 5rem;
            width: auto;
            border-radius: 100%;
            object-fit: contain;
        }
    }
    .Name {
        @apply text-3xl font-bold;
    }
}

.Separation {
    @apply pl-8;

    display: grid;
    grid-template-columns: auto 1fr;
    gap: 1rem;
    .FakeLine {
        background: linear-gradient(var(--colorAccent), var(--colorAccent)) no-repeat center/100% 1px;
    }
}
.Icons {
    width: 50%;
    display: flex;
    justify-content: space-between;
}
</style>
