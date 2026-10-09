import { graphql } from '$flamme'

export const mid = graphql`query BrokenMid {
	favorites @list(name: "a\tb") {
		???
	}
}`

export const tail = graphql`query BrokenTail {
	favorites {
		id
	}
`
