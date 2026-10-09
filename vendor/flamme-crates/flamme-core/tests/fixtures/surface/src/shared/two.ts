import { graphql } from '$flamme'

export const Page = graphql`query Alpha { favorites { id } }`
export const Other = graphql`query Beta { favorites { id } }`
