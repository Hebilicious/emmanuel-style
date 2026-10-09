/**
 * The local transport: content answered from the bundle.
 *
 * This is the "server" for everything the build produced. Flamme's compiler already
 * normalised each document into a selection (`artifact.selection`), so this module
 * walks that selection against the generated content: fields are read from the
 * content objects, arguments come from `keyRaw`, fragments are merged the way a
 * server merges them, and `__typename` comes from the content or the field's type.
 *
 * The result is an ordinary transport response, so the cache, the fragment masking,
 * the local-first queue and the router loaders cannot tell it from a networked one.
 * Nothing here reads a file or touches the network, which is what makes a content
 * page render with the network off before the service worker is even considered.
 *
 * `favourites`, `toggleFavourite` and `stars` are the worker's, and `transport.ts`
 * routes those over HTTP instead.
 */
import type { FieldSpec, SubscriptionSelection, TransportRequest, TransportResponse } from "@flamme/runtime"
import {
	postBySlug,
	posts as allPosts,
	roles as allRoles,
	schools as allSchools,
	shelves as allShelves,
	site as siteContent
} from "./content.js"

/**
 * The field's own name, before its arguments.
 *
 * `keyRaw` is the printer's form of the field: `post(slug: $slug)`, `stars(names:
 * $names)`, or a bare `site` when the field takes no arguments.
 */
export const fieldName = (field: FieldSpec): string => field.keyRaw.split("(")[0]?.trim() ?? ""

/**
 * Read one argument out of `keyRaw`, substituting variables.
 *
 * The arguments sit inside the parentheses, so a `:` split over the whole string
 * finds `post(slug` rather than `slug` and every lookup misses: that is what left
 * the article blank, because `post(slug: $slug)` never resolved to a slug.
 */
const argOf = (
	field: FieldSpec,
	variables: Readonly<Record<string, unknown>>,
	name: string
): unknown => {
	const open = field.keyRaw.indexOf("(")
	if (open === -1) return undefined
	const inside = field.keyRaw.slice(open + 1, field.keyRaw.lastIndexOf(")"))
	if (inside === "") return undefined

	for (const part of inside.split(",")) {
		const colon = part.indexOf(":")
		if (colon === -1) continue
		const key = part.slice(0, colon).trim()
		if (key !== name) continue
		const bare = part.slice(colon + 1).trim().replace(/^"|"$/g, "")
		return bare.startsWith("$") ? variables[bare.slice(1)] : bare
	}
	return undefined
}

/**
 * Resolve one selection against one value.
 *
 * `typename` is what to answer for `__typename`: the content's own value when it
 * carries one, otherwise the type the selection expects.
 */
const resolveSelection = (
	value: unknown,
	selection: SubscriptionSelection,
	variables: Readonly<Record<string, unknown>>,
	typename: string | null
): unknown => {
	if (value === null || value === undefined) return null

	if (Array.isArray(value)) {
		return value.map((item) => resolveSelection(item, selection, variables, typename))
	}

	if (typeof value !== "object") return value

	const source = value as Record<string, unknown>
	const out: Record<string, unknown> = {}

	/*
	 * `selection.fragments` is not walked: the compiler inlines every spread's fields
	 * into `fields`, and a `FragmentSpec` carries only the spread's arguments and
	 * conditions. Reading a `.selection` off it is a type error and a no-op at runtime.
	 */

	for (const [key, field] of Object.entries(selection.fields ?? {})) {
		if (field.type === "__typename") {
			out[key] = (source["__typename"] as string | undefined) ?? typename ?? "Unknown"
			continue
		}

		const nested = source[key]

		// A field the content does not have is left out rather than set to null, so the
		// cache receives exactly what a server would have sent for a selection it chose
		// to answer.
		if (nested === undefined) continue

		out[key] = field.selection
			? resolveSelection(nested, field.selection, variables, field.type)
			: nested
	}

	// The content model leaves `__typename` implicit; the selection's own type is the
	// better answer than nothing, and the cache keys on it.
	if (typename && out["__typename"] === undefined) out["__typename"] = typename

	return out
}

/** One document's root selection against the content module. */
const resolveRoot = (
	selection: SubscriptionSelection,
	request: TransportRequest
): Record<string, unknown> => {
	const variables = request.variables
	const out: Record<string, unknown> = {}

	for (const [key, field] of Object.entries(selection.fields ?? {})) {
		let value: unknown

		switch (field.type) {
			case "__typename":
				out[key] = request.artifact.rootType || "Query"
				continue
			case "Site":
				value = siteContent
				break
			case "Shelf":
				value = allShelves
				break
			case "Post":
				// `post` takes a slug, `posts` is the list; the field's own name tells them
				// apart, and an alias would otherwise decide it.
				value =
					fieldName(field) === "post"
						? postBySlug(String(argOf(field, variables, "slug") ?? ""))
						: allPosts
				break
			case "Role":
				value = allRoles
				break
			case "School":
				value = allSchools
				break
			default:
				// Not a content field. `transport.ts` sends those to the worker, so
				// reaching here means the split between the two is wrong.
				continue
		}

		out[key] = field.selection
			? resolveSelection(value, field.selection, variables, field.type)
			: value
	}

	return out
}

/**
 * Answer one document from the bundle.
 *
 * The selection is the compiler's, so this never parses GraphQL and the document
 * text is never needed at runtime.
 */
export const resolveLocally = (request: TransportRequest): TransportResponse => {
	const selection = request.artifact.selection
	return { data: resolveRoot(selection, request) }
}
