<script setup lang="ts">
import { graphql } from '$flamme'
import { SpriteInfo } from '$flamme'

const document = graphql`fragment SpriteInfo on Species @loading {
	name
	sprites {
		front
	}
}
`
</script>

<template>
  <div>{{ document.name }}</div>
</template>
