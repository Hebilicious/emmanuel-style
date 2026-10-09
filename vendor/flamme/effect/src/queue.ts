/**
 * The local-first seam: the one member of `@flamme/local` this package names.
 *
 * `@flamme/effect` does not depend on `@flamme/local`. It declares the shape it calls, and an app
 * passes its own store in: `flammeLayer({ url, local })`, where `local` is what
 * `createLocalFirst({ client })` returned. `LocalFirst` satisfies {@link FlammeQueue} structurally,
 * which the package's type tests pin; a hand-written queue satisfies it too.
 *
 * The seam is deliberately one method. Everything else the store owns (the durable cache, the
 * replay, the sync status, `discard`, `retry`) stays the app's, because a Vue app renders it with
 * `@flamme/local/vue` and a Node program does not render it at all.
 */
import type { Artifact, Variables } from '@flamme/runtime';

/** The failure a queue reports for an entry it parked. */
export interface FlammeQueueFailure {
  readonly message: string;
}

/** What a queue did with one mutation. */
export type FlammeQueueOutcome<TData> =
  /** The server confirmed it during this call and its payload is in the cache. */
  | { readonly status: 'confirmed'; readonly id: string; readonly data: TData }
  /** It is queued (offline, or an earlier entry is still pending) and visible locally. */
  | { readonly status: 'queued'; readonly id: string }
  /** The server rejected it with a GraphQL error; it stays queued until `retry()`/`discard()`. */
  | { readonly status: 'parked'; readonly id: string; readonly error: FlammeQueueFailure };

/** The options of one queued mutation. */
export interface FlammeQueueMutation {
  /** The mutation's variables. */
  readonly variables: Variables;
  /** Written into an optimistic layer before anything is sent. */
  readonly optimistic?: Variables;
}

/**
 * The local-first queue, as this package uses it.
 *
 * `LocalFirst` from `@flamme/local` is assignable to this interface, so an app hands its store over
 * with no adapter:
 *
 * ```ts
 * const client = buildClient({ url: '/graphql' });
 * const local = createLocalFirst({ client, adapter: browserAdapter() });
 * await local.restore();
 * const layer = clientLayer(client, { local });
 * ```
 */
export interface FlammeQueue {
  /** Applies a mutation locally, queues it durably, and delivers it when it is the queue's turn. */
  mutate<TData>(
    artifact: Artifact<'mutation', TData>,
    options: FlammeQueueMutation,
  ): Promise<FlammeQueueOutcome<TData>>;
  /** Stops the store and releases its adapter; the layer calls it when its scope closes. */
  readonly dispose?: () => void;
}
