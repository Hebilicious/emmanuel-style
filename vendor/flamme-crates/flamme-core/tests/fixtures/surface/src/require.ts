const { graphql } = require('$flamme')

export const required = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
`
