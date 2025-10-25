import { defineCollection, z } from "astro:content"

const blog = defineCollection({
	type: "content",
	schema: z.object({
		title: z.string(),
		description: z.string(),
		publishDate: z.coerce.date(),
		draft: z.boolean().optional().default(false),
		tags: z.array(z.string()).optional().default([])
	})
})

export const collections = { blog }
