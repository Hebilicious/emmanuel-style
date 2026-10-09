<script setup lang="ts">
import { graphql } from '$flamme'
const Bad = graphql(`
  query InlineComponent {
    viewer {
      id
    }
  }
`)
</script>

<template>
  <div>{{ Bad }}</div>
</template>
