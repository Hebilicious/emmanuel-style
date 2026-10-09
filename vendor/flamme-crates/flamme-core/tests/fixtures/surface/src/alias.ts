import { graphql as gql } from '$flamme'

export const aliased = gql`fragment SpeciesPreview on Species @loading {
	name
	id
}
`

export const shadowed = graphql`query Shadowed { nope }`
