<script setup lang="ts">
import { graphql } from '$flamme'

const fragment = graphql("fragment FavoritePreview on Species @loading {\n\tid\n\tname\n}\n")
</script>

<template>
  <div>{{ fragment.name }}</div>
</template>
