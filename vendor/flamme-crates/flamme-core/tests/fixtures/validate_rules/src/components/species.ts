import { graphql } from '$flamme'

export const speciesFields = graphql(`
  fragment TagSpecies on Species {
    id
    name
  }
`)
