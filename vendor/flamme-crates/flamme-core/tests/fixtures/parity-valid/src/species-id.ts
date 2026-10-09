/**
 * The route's `[[id]]` segment, resolved the one way the app resolves it.
 *
 * The route's `props` function and the `Info` loader's variables both go through
 * {@link speciesIdOf}, so the id the page renders and the id the loader fetches can never disagree
 * (`spec/spec.md` §11.2: `[[id]]` resolves with `Number(route.params.id ?? 1)`).
 *
 * It lives in its own module because the loaders module and the router module both need it and the
 * router imports the page component: keeping it here is what keeps that pair acyclic.
 */

/** The `id` the route resolves to when the segment is absent. */
export const DEFAULT_SPECIES_ID = 1;

/**
 * Reads a route param, or an id the app already holds, as an integer. A missing or non-numeric
 * segment falls back to the default; an out-of-range id is passed through so the fixture answers
 * with its `No Pokémon found with id N` error and the page renders the error view (behaviour 1).
 *
 * The route loader does **not** come through here any more: the generator coerces `[[id]]` from the
 * document's own `$id: Int!` (REQ-2), and this function is what the page uses to read the same param
 * for its child components. The two agree because both fall back to the document's default (`1`) for
 * a segment that is absent or not a number.
 */
export function speciesIdOf(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) ? parsed : DEFAULT_SPECIES_ID;
}
