import { graphql } from '$flamme'

export const plain = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
`
