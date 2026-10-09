<script setup lang="ts">
import { graphql } from '$flamme'

const fragment = graphql`fragment FavoritePreview on Species @loading {
	id
	name
}
`
</script>

<template>
  <div>{{ graphql`query NotScanned { nope }` }}</div>
</template>

<style scoped>
div {
  color: red;
}
</style>
