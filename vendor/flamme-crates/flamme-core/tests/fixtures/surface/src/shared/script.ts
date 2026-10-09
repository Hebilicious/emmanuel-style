import { graphql } from '$flamme'

export const shared = graphql`fragment MoveDisplay on SpeciesMove @loading {
	learned_at
	method
}
`
