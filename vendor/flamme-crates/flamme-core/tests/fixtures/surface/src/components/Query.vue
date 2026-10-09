<script setup lang="ts">
import { graphql } from '$flamme'

const page = graphql`query ComponentQuery { favorites { id } }`
</script>

<template>
  <div />
</template>
