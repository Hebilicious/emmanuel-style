import { graphql } from '$flamme'
import type { DocumentNode } from 'graphql'

export const plain = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
`
export const asserted = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
` as DocumentNode
export const satisfied = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
` satisfies DocumentNode
export const parenthesized = (graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
`)
export const called = (graphql)("fragment SpeciesPreview on Species @loading {\n\tname\n\tid\n}\n")
export const annotated: DocumentNode = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
`
