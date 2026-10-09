import { graphql } from '$flamme'

const name = 'x'

export const none = graphql()
export const two = graphql('a', 'b')
export const notStatic = graphql(name)
export const dynamic = graphql(`query Dynamic { ${name} }`)
