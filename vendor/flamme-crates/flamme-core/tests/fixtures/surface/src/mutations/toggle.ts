import { graphql } from '$flamme'

export const ToggleFavorite = graphql("mutation ToggleFavorite($id: Int!) {\n\ttoggleFavorite(id: $id) {\n\t\tspecies {\n\t\t\tid\n\t\t}\n\t}\n}\n")
