import { graphql } from '$flamme'

export const nested = {
  deep: [() => ({ value: graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
` })],
}

export function make() {
  return graphql`query Made { favorites { id } }`
}
