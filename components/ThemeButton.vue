<template>
    <button :class="classes" aria-label="themeColorButton" @click="selectTheme(name)"></button>
</template>
<script lang="ts">
import { defineComponent, computed } from "nuxt-composition-api"
import { useTheme } from "@/services/useTheme"

export default defineComponent({
    props: {
        theme: { type: Array, required: true }
    },
    setup(props) {
        const name = computed(() => props.theme[0] as string)
        const { currentTheme, selectTheme, themesList } = useTheme()
        const classes = computed(() => {
            const selfTheme = themesList.get(name.value)
            const isActive = currentTheme.value === selfTheme
            return { Selector: true, isActive, ...(selfTheme && { [selfTheme]: true }) }
        })

        const format = (n: string) => `${n[0].toUpperCase()}${n.slice(1)}`
        return { name, currentTheme, selectTheme, classes, format }
    }
})
</script>
<style lang="postcss" scoped>
button {
    --size: 2.5rem;

    outline: none;
    border: 2px solid var(--secondaryAccent);
    background: var(--primaryBackground);
    border-radius: 100%;
    width: var(--size);
    height: var(--size);
    transition: border-color 1s ease;
    &.isActive {
        border: 4px solid var(--activeBorder);
        filter: drop-shadow(0 0 4px var(--activeBorder));
    }
}
</style>
