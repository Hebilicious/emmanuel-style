/**
 * `QueryResult`: four independent flags (§5.4), plus the incremental-delivery state of §7.13.
 *
 * `fetching` is not `!data`, `partial` is not an error, and `stale` is not `fetching`; the store
 * never collapses them. `isPending` is orthogonal to all of them (it is about placeholder values,
 * not network state). `hasNext`/`deferred` are orthogonal too: they describe a response that is
 * still arriving, not one that failed or that is out of date.
 */
import type { DataSource, DeferredState, Variables } from './artifact.js';
import type { GraphQLResponseError } from './client.js';

export interface QueryResult<TData = unknown> {
  readonly data: TData | null;
  readonly errors: readonly GraphQLResponseError[] | null;
  /** A request is in flight for these variables. */
  readonly fetching: boolean;
  /** Some selected fields are absent from the cache. */
  readonly partial: boolean;
  /** The data is present but known to be out of date (invalidated, or a layer was rolled back). */
  readonly stale: boolean;
  readonly source: DataSource | null;
  readonly variables: Variables | null;
  readonly extensions: Readonly<Record<string, unknown>> | null;
  /**
   * Incremental delivery (§7.13): the transport still has patches to deliver for this result. The
   * initial payload of a document with `@defer`/`@stream` sets it and the final patch clears it.
   * `false` for every non-incremental response, including one from a server that ignored the
   * directives and answered the whole document at once.
   */
  readonly hasNext: boolean;
  /**
   * Per-label delivery state of every `@defer`/`@stream` target the document declares: `pending`
   * until its patch (or, for `@stream`, the patch that ends the stream) has been merged. A label
   * whose `if:` argument is false is never pending. Empty for a document with no incremental
   * directives.
   */
  readonly deferred: DeferredState;
}
