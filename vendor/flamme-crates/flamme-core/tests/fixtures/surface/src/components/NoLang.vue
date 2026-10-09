<script>
import { graphql } from '$flamme'

const fragment = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
`
</script>

<template>
  <div>{{ fragment.name }}</div>
</template>
