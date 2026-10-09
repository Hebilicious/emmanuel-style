/**
 * The transport: one GraphQL endpoint for the data a server owns, and the bundle
 * for everything else.
 *
 * The site has two kinds of field. Favourites and star counts live in Durable
 * Objects behind the worker. Content (the site facts, a post, its blocks and its
 * notes, the shelves, roles and schools) is generated at build time and is already
 * in the bundle.
 *
 * Both are answered here, so the rest of the stack, the cache, the masking and the
 * local-first queue, cannot tell them apart. That is what makes a page render with
 * the network off: a content document never reaches the network to begin with, and
 * a favourites document falls back to the durable cache while it is unreachable.
 */

import type { TransportFn, TransportRequest, TransportResponse } from "@flamme/runtime"
import { resolveLocally } from "./resolve.js"

/** The worker's GraphQL endpoint. Empty in a build with no backend configured. */
const ENDPOINT = (import.meta.env["VITE_API_BASE"] as string | undefined) ?? ""

/**
 * The reader's stable id, so a favourite toggle is idempotent per reader and the
 * queue replays it safely.
 */
const readerId = (): string => {
	const key = "emmanuel.reader"
	try {
		const existing = localStorage.getItem(key)
		if (existing) return existing
		const created = crypto.randomUUID()
		localStorage.setItem(key, created)
		return created
	} catch {
		return "anonymous"
	}
}

/** Fields the worker owns. Everything else is answered from the bundle. */
const SERVER_OWNED = ["favourites", "toggleFavourite", "stars"]

/**
 * Whether the worker owns any root field of this document.
 *
 * Read from the compiler's own selection rather than by scanning the document text:
 * a `favourites` fragment inside a content query would be missed by a substring
 * search, and a field name appearing in a string literal would be matched wrongly.
 */
const needsServer = (request: TransportRequest): boolean => {
	const fields = Object.keys(request.artifact.selection.fields ?? {})
	return fields.some((field) => SERVER_OWNED.includes(field))
}

export const createTransport =
	(): TransportFn =>
	async (request: TransportRequest): Promise<TransportResponse> => {
		/*
		 * Content is answered from the bundle first, so a page works offline before
		 * the service worker is considered.
		 */
		if (!needsServer(request) && ENDPOINT === "") {
			return resolveLocally(request)
		}

		if (ENDPOINT === "") return resolveLocally(request)

		try {
			const response = await fetch(`${ENDPOINT}/api/graphql`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-reader-id": readerId()
				},
				body: JSON.stringify({ query: request.query, variables: request.variables })
			})
			if (!response.ok) throw new Error(`graphql ${response.status}`)
			return (await response.json()) as TransportResponse
		} catch (error) {
			// A content document still resolves locally; a favourites document fails and
			// the durable cache answers for it.
			if (!needsServer(request)) return resolveLocally(request)
			throw error
		}
	}
