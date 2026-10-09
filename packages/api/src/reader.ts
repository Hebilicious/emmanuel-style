/**
 * Reader identity for favourites.
 *
 * A reader is whoever a client says it is, via `x-reader-id`. Nothing here
 * trusts that claim beyond using it as a stable key, so the header is hashed
 * before it is stored: the Durable Object keeps opaque keys rather than a list
 * of client-chosen strings, and a reader who sends surrounding whitespace or a
 * different Unicode form of the same id normalises onto one key instead of
 * counting twice.
 *
 * This module deliberately imports nothing from `cloudflare:workers`, so the
 * key derivation can be exercised outside workerd.
 */

/** How much of an unbounded client header is allowed to name a reader. */
const MAX_READER_ID_LENGTH = 128

/**
 * The key a reader is stored under, or `null` for a request that cannot name
 * one. Without an identity there is no way to be idempotent, so the caller is
 * told rather than having a counter drift.
 */
export const readerKey = async (readerId: string | null | undefined): Promise<string | null> => {
	if (typeof readerId !== "string") return null

	const normalized = readerId.normalize("NFKC").trim()
	if (normalized.length === 0 || normalized.length > MAX_READER_ID_LENGTH) return null

	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized))
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
}
