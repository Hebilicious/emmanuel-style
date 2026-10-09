<template>
  <div><script>const a = 1</script></div>
</template>

<script setup lang="ts">
import { graphql } from '$flamme'

const fragment = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
`
</script>
