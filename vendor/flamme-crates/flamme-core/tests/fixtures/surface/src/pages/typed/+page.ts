import { graphql } from '$flamme'
import type { DocumentNode } from 'graphql'

export const Page = graphql`query TypedPage { favorites { id } }` satisfies DocumentNode
