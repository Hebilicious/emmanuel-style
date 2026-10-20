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
 * a favourites or stars document that cannot reach the worker fails, so the durable
 * cache answers with what it last saw.
 *
 * A document is one or the other, never both: the worker does not serve content,
 * and the bundle does not know the counts. `Stars`, `Favourite` and
 * `ToggleFavourite` are the worker's documents, and they ask for nothing else.
 */

import type { TransportFn, TransportRequest, TransportResponse } from "@flamme/runtime"
import { resolveLocally } from "./resolve.js"

/**
 * Where the worker is.
 *
 * `VITE_API_BASE` names it when it is on another origin, as it is in development
 * (`wrangler dev` on port 8787) and on a preview. Unset, a production build talks to
 * its own origin, which is where the worker's `/api/*` route is mounted, and a dev
 * server talks to the local worker.
 */
const configured = import.meta.env["VITE_API_BASE"] as string | undefined
const BASE = (configured ?? (import.meta.env.DEV ? "http://localhost:8787" : "")).replace(
	/\/+$/,
	""
)

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
const SERVER_OWNED = new Set(["favourites", "toggleFavourite", "stars"])

/**
 * Whether the worker owns any root field of this document.
 *
 * Read from the compiler's own selection rather than by scanning the document text:
 * a `favourites` fragment inside a content query would be missed by a substring
 * search, and a field name appearing in a string literal would be matched wrongly.
 */
const needsServer = (request: TransportRequest): boolean =>
	Object.values(request.artifact.selection.fields ?? {}).some((field) =>
		SERVER_OWNED.has(field.keyRaw.split("(")[0]?.trim() ?? "")
	)

export const createTransport =
	(): TransportFn =>
	async (request: TransportRequest): Promise<TransportResponse> => {
		// Content is answered from the bundle, so a page works offline before the
		// service worker is even considered.
		if (!needsServer(request)) return resolveLocally(request)

		/*
		 * With no network there is no point asking: the request would fail, and the
		 * browser would log the failed load as a console error on every route. Failing
		 * here instead is the same outcome for Flamme (the durable cache answers, and a
		 * mutation stays queued), without the noise.
		 */
		if (typeof navigator !== "undefined" && navigator.onLine === false) {
			throw new Error("offline: the worker is not reachable")
		}

		const response = await fetch(`${BASE}/api/graphql`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-reader-id": readerId()
			},
			body: JSON.stringify({ query: request.query, variables: request.variables })
		})
		if (!response.ok) throw new Error(`graphql ${response.status}`)
		return (await response.json()) as TransportResponse
	}
