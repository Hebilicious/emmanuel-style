import { graphql } from '$flamme'

const Doc = graphql`query AliasPage { favorites { id } }`
const Also = Doc

export const Page = Also
