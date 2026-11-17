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
import { contentVersion } from "./content.js"
import { createTransport } from "./transport.js"

/** What every snapshot database of this site is named after. */
const SNAPSHOT_PREFIX = "emmanuel.style."

/**
 * The IndexedDB database of the durable snapshot, named after the content.
 *
 * Content is answered from the bundle, but once answered it sits in the cache, and
 * the snapshot carries the cache across reloads. A snapshot written by an older
 * build therefore answered for the new build's content (`CacheOrNetwork` found it
 * and never asked the bundle), and a reader kept the old article after a new one
 * shipped. Naming the database after the content version means new content opens a
 * new snapshot.
 */
export const LOCAL_SNAPSHOT_KEY = `${SNAPSHOT_PREFIX}${contentVersion}`

/**
 * Remove the snapshots older builds left behind. They can no longer be read, so they
 * only take space. Best effort: `indexedDB.databases()` is missing in some browsers,
 * and a failure here must not stop the app.
 */
const pruneSnapshots = async (): Promise<void> => {
	try {
		if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return
		for (const database of await indexedDB.databases()) {
			const name = database.name ?? ""
			if (name.startsWith(SNAPSHOT_PREFIX) && name !== LOCAL_SNAPSHOT_KEY)
				indexedDB.deleteDatabase(name)
		}
	} catch {
		// Nothing depends on this.
	}
}

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

	void pruneSnapshots()
	return flamme as SiteClient
}
