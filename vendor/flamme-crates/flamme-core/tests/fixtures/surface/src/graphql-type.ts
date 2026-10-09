import type { DocumentNode } from 'graphql'

interface Props {
  fragment: GraphQL<`fragment SpeciesPreview on Species @loading {
	name
	id
}
`>
}

type Alias = GraphQL<`fragment SpeciesPreview on Species @loading {
	name
	id
}
`>
type Bare = GraphQL

export type { Props, Alias, Bare }
