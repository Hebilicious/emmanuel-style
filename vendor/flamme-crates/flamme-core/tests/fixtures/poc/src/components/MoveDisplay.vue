<script setup lang="ts">
import { graphql } from '$flamme'
import { MoveDisplay } from '$flamme'

const document = graphql`fragment MoveDisplay on SpeciesMove @loading {
	learned_at
	method
	move {
		name
		accuracy
		power
		pp
		type
	}
}
`
</script>

<template>
  <div>{{ document.name }}</div>
</template>
