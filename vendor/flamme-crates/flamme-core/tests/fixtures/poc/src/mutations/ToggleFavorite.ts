import { graphql } from '$flamme'

export const ToggleFavorite = graphql`mutation ToggleFavorite($id: Int!) {
	toggleFavorite(id: $id) {
		species {
			id
			favorite
			...FavoriteSpecies_toggle
		}
	}
}
`
