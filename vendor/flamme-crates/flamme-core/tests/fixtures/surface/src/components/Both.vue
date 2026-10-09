<script setup lang="ts">
import { graphql } from '$flamme'

const setup = graphql`fragment SpriteInfo on Species @loading {
	name
	sprites {
		front
	}
}
`
</script>

<script lang="ts">
import { graphql } from '$flamme'

export const plain = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
`
</script>

<template>
  <div />
</template>
