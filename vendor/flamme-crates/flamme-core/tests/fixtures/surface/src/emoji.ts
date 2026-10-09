// 🐙 a comment before the tag shifts UTF-16 offsets from byte offsets
import { graphql } from '$flamme'

export const emoji = graphql`query Emoji { favorites @list(name: "🐙") { id } }`
