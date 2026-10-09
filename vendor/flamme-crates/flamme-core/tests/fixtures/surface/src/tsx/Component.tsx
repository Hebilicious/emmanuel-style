import { graphql } from '$flamme'

const fragment = graphql`fragment SpeciesPreview on Species @loading {
	name
	id
}
`

export function Component() {
  return <div>{fragment.name}</div>
}
