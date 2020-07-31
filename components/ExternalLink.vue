<template>
    <a target="_blank" :href="`https://${url}`" rel="noopener noreferrer">
        <slot></slot>
    </a>
</template>
<script lang="ts">
export default {
    props: {
        url: { type: String, required: true }
    }
}
</script>
<style lang="postcss" scoped>
a {
    &:hover {
        transform: scale(1.2);
        transition: all 0.1s ease-out;
    }
}
</style>
