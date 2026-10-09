import { graphql } from '$flamme'

export const escaped = graphql`query Escaped {
	favorites @list(name: "a\tb\\\\c\`d\u0041\x42\$e") {
		id
	}
}`

export const continued = graphql`query Continued { \
	favorites { id } \
}`
