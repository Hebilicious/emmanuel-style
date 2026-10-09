/**
 * The router, over Flamme's generated route table.
 *
 * `$flamme/routes` is written by `flamme generate` from `src/pages/**`, so the
 * file tree is the route table and nothing here names a route by hand. This module
 * is the one place that imports it, and it re-exports the generated factory so the
 * browser entry and any test build the same wiring.
 */
import { createFlammeRouter, type FlammeRoute, type FlammeRouter } from "@flamme/router/auto"
import type { Client } from "@flamme/runtime"
import type { RouterHistory } from "vue-router"
import { pages, records } from "$flamme/routes"

export { createFlammeRouter, pages, records }
export type { FlammeRoute, FlammeRouter }

export interface AppRouterOptions {
	readonly client: Client
	readonly history?: RouterHistory
}

export const createAppRouter = async (
	options: AppRouterOptions
): Promise<FlammeRouter & { readonly routes: readonly FlammeRoute[] }> => {
	const created = await createFlammeRouter({
		client: options.client,
		...(options.history === undefined ? {} : { history: options.history })
	})
	return { ...created }
}
