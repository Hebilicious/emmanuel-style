<template>
    <div :class="classes">
        <button @click="selectTheme(name)">{{ format(name) }}</button>
    </div>
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
            const isActive = currentTheme.value === themesList.get(name.value)
            return { Selector: true, isActive }
        })
        const format = (n: string) => `${n[0].toUpperCase()}${n.slice(1)}`
        return { name, currentTheme, selectTheme, classes, format }
    }
})
</script>
<style scoped>
.isActive {
    color: red;
}
</style>
