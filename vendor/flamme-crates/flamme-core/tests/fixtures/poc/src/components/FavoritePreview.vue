<script setup lang="ts">
import { graphql } from '$flamme'

const fragment = graphql`fragment FavoritePreview on Species @loading {
	id
	pokedexNumber
	name
	sprites {
		front
	}
}
`
</script>

<template>
  <div>{{ fragment.name }}</div>
</template>
