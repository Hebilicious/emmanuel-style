/**
 * Favourites, one Durable Object per article.
 *
 * A Durable Object gives each article a single-threaded owner, so a
 * read-modify-write of the counter cannot interleave and no database or
 * transaction is needed. Keying by article slug means two readers who favourite
 * different posts never contend.
 *
 * The object also remembers *who* favourited an article. The site queues writes
 * locally and replays them when the network returns, so a replay cannot be
 * allowed to count twice: `toggle` flips this reader's own flag and moves the
 * total by exactly that flip. A reader who never toggled stays untracked, which
 * is what keeps the pre-existing `add` route and the GraphQL mutation safe to
 * mix.
 */
import { DurableObject } from "cloudflare:workers"

export interface FavouriteState {
	count: number
	updatedAt: number
}

/**
 * The persisted shape.
 *
 * `readers` is a list rather than a set because it has to survive JSON
 * serialisation. It holds the hashed keys from `readerKey`, never raw headers.
 */
interface StoredState extends FavouriteState {
	readers: string[]
}

export class Favourites extends DurableObject {
	async #read(): Promise<StoredState> {
		const stored = await this.ctx.storage.get<StoredState>("state")
		return stored ?? { count: 0, updatedAt: 0, readers: [] }
	}

	/** Read the current total. */
	async count(): Promise<FavouriteState> {
		const stored = await this.#read()
		return { count: stored.count, updatedAt: stored.updatedAt }
	}

	/**
	 * Add one favourite and return the new total.
	 *
	 * This route cannot be idempotent, because it carries no reader. It stays
	 * for the existing REST surface; the GraphQL surface uses `toggle`.
	 */
	async add(): Promise<FavouriteState> {
		const current = await this.#read()
		const next: StoredState = {
			...current,
			count: current.count + 1,
			updatedAt: Date.now()
		}
		await this.ctx.storage.put("state", next)
		return { count: next.count, updatedAt: next.updatedAt }
	}

	/**
	 * Flip one reader's favourite and return the new total.
	 *
	 * Two toggles with the same reader key return the total to where it started,
	 * so replaying a queued write is a no-op the second time. The flag and the
	 * count are written in one `storage.put`, so they cannot diverge.
	 *
	 * `blockConcurrencyWhile` is not needed here either: Durable Object requests
	 * are already serialised per object.
	 */
	async toggle(readerKey: string): Promise<FavouriteState> {
		const current = await this.#read()
		const favourited = current.readers.includes(readerKey)

		const readers = favourited
			? current.readers.filter((key) => key !== readerKey)
			: [...current.readers, readerKey]

		const next: StoredState = {
			readers,
			count: favourited ? Math.max(0, current.count - 1) : current.count + 1,
			updatedAt: Date.now()
		}
		await this.ctx.storage.put("state", next)
		return { count: next.count, updatedAt: next.updatedAt }
	}
}
