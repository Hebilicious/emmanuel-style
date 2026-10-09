/**
 * The typed path of the app's one page route.
 *
 * `src/pages/[[id]].vue` is planned as route name `'[[id]]'` with the optional `:id?` param, and the
 * generated `$flamme/routes` module exports exactly that path. The app's link components need a
 * location, so this is the one place that spells it: a name-based location would hard-code a
 * generated identifier in five components, and a typo would only surface as a failed navigation at
 * runtime.
 *
 * The value is `pages`'s own `path` field, so a change to the page's file name changes the path and
 * the app follows it. `speciesIdOf` supplies the default when the caller has no id.
 */
import { pages } from '$flamme/routes';

import { speciesIdOf } from './species-id.js';

/** The route's own path pattern (`/:id?`). */
const SPECIES_ROUTE = pages['[[id]]'].path;

/**
 * The location of one species page: always `/<id>`.
 *
 * The route's `[[id]]` segment is optional, so `/` is a valid URL too, but it is **not** the same
 * location: `/` redirects to the default id (`/1`, the generated record's `redirect`), so a link to
 * `/` would cost a redirect on every click. `/<id>` is the canonical spelling.
 */
export function speciesPath(id: number): string {
  return `/${String(speciesIdOf(id))}`;
}

/** The route path the app's page declares; exported so a test can assert the pair. */
export const SPECIES_PATH = SPECIES_ROUTE;
