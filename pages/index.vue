<template>
    <div class="container">
        <div>
            <Logo />
            <h1 class="title">
                emmanuel-style
            </h1>
            <div class="links">
                <a href="https://nuxtjs.org/" target="_blank" rel="noopener noreferrer" class="button--green">
                    Documentation
                </a>
                <a
                    href="https://github.com/nuxt/nuxt.js"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="button--grey"
                >
                    GitHub
                </a>
            </div>
            <div v-for="post in posts" :key="post.id">
                <div>{{ post }}</div>
            </div>
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent, useFetch, useContext, ref } from "nuxt-composition-api"

export default defineComponent({
    setup() {
        const { $http } = useContext()

        const posts = ref([])

        useFetch(async () => {
            const data = await $http.get("https://jsonplaceholder.typicode.com/posts").then((posts) => posts.json())
            posts.value = data
        })

        return { posts }
    }
})
</script>

<style>
/* Sample `apply` at-rules with Tailwind CSS */
.container {
    @apply min-h-screen flex justify-center items-center text-center mx-auto;
}

.title {
    font-family: "Quicksand", "Source Sans Pro", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
        Arial, sans-serif;
    display: block;
    font-weight: 300;
    font-size: 100px;
    color: #35495e;
    letter-spacing: 1px;
}

.subtitle {
    font-weight: 300;
    font-size: 42px;
    color: #526488;
    word-spacing: 5px;
    padding-bottom: 15px;
}

.links {
    padding-top: 15px;
}
</style>
