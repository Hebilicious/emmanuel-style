<script setup lang="ts">
import { graphql } from '$flamme'
import { SpeciesPreview } from '$flamme'

const document = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
	pokedexNumber
	...SpriteInfo
}
`
</script>

<template>
  <div>{{ document.name }}</div>
</template>
