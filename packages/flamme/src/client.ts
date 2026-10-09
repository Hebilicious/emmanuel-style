/**
 * The Flamme container.
 *
 * Two things make this client different from a networked one:
 *
 *   - the transport (`./transport.js`) answers content from the bundle and sends
 *     only favourites and star counts to the worker, so a page renders with the
 *     network off and a favourites read falls back to the durable cache;
 *   - `local` is on, so the container also builds the durable cache and the queue
 *     of local writes. `await flamme.ready` restores them before the router
 *     exists, which is what makes a warm reload paint from the device and an
 *     offline favourite come back with it.
 *
 * Built once per page load and never at module scope, so nothing leaks between a
 * reload and its predecessor.
 */

import { browserAdapter, type LocalFirst } from "@flamme/local"
import type { ClientPlugin, SerializedCache, TransportFn } from "@flamme/runtime"
import { createFlamme, type FlammeApp } from "@flamme/vue"
import { cacheKeys, defaultKeys } from "$flamme"
import { createTransport } from "./transport.js"

/** The adapter key of the durable snapshot. */
export const LOCAL_SNAPSHOT_KEY = "emmanuel.style.v1"

export interface ClientOptions {
	/** Transport override, for tests. */
	readonly fetch?: TransportFn
	/** Pre-rendered cache payload, when the HTML carries one. */
	readonly hydrate?: SerializedCache
	/** Extra client plugins, appended to the default pipeline. */
	readonly plugins?: readonly ClientPlugin[]
}

export interface SiteClient extends FlammeApp {
	readonly local: LocalFirst
}

export const createSiteClient = (options: ClientOptions = {}): SiteClient => {
	const flamme = createFlamme({
		// `createFlamme` names the transport `fetch`: it is what the client calls to
		// resolve a document, and ours resolves content locally and forwards the
		// server-owned fields to the worker.
		fetch: options.fetch ?? createTransport(),
		keys: cacheKeys,
		defaultKeys,
		local: {
			// The IndexedDB database name, which is what `browserAdapter` takes.
			adapter: browserAdapter({ database: LOCAL_SNAPSHOT_KEY })
		},
		...(options.hydrate === undefined ? {} : { hydrate: options.hydrate }),
		...(options.plugins === undefined ? {} : { plugins: options.plugins })
	})

	return flamme as SiteClient
}
