/**
 * Request dedupe, request ids and the abort seam (§5.6).
 *
 * The registry is owned by the `Client`, so two stores observing the same document and variables
 * share one network request: the first store becomes the leader and owns the `AbortController`, the
 * others join and receive the leader's result. The entry is released when every store that joined
 * it has settled or cleaned up, and the controller is aborted only when the client is disposed or a
 * `@dedupe(cancelFirst: true)` request replaces it.
 */
import type { Artifact, CachePolicy, Variables } from './artifact.js';
import type { QueryResult } from './result.js';
import { asRecord } from './cache/keys.js';

/** The `@dedupe` configuration the compiler records in `pluginData.dedupe` (§7.9). */
export interface DedupeConfig {
  readonly cancelFirst: boolean;
  readonly match: 'variables' | 'all';
}

/**
 * One in-flight request. `refs` counts the stores that will consume the result, `promise` never
 * rejects (the failure travels in `failure`, so a joiner can decide for itself), and `resolve` is
 * the deferred the leader settles once its pipeline has finished.
 */
export interface InFlightRequest<TData> {
  readonly key: string;
  readonly controller: AbortController;
  readonly promise: Promise<QueryResult>;
  readonly requestId: number;
  refs: number;
  /** The `throwOnError` rejection of the leader, if any. */
  failure: unknown;
  /** The leader's final result, copied by every joiner. */
  result: QueryResult<TData> | null;
  readonly resolve: (result: QueryResult) => void;
  /** The commit channel: the leader publishes every commit, each store that joined subscribes. */
  readonly joins: RequestJoins<TData>;
  /**
   * The leader's result at its **first payload**, once its response has delivered one (§7.13), or
   * `null` while the response has not started streaming. A read that joins the request reads the
   * same payload: it is the state a route loader settles on.
   */
  firstPayload: QueryResult<TData> | null;
  /**
   * Registers one first-payload listener. The listener runs immediately when the payload already
   * arrived, so a read that joins late still learns it, and once more if it has not. The returned
   * function unregisters it.
   */
  onFirstPayload(listener: (result: QueryResult<TData>) => void): () => void;
  /**
   * Publishes the leader's first payload to every listener and remembers it for later joiners. Only
   * the leader calls this, at most once, from the commit that announced `hasNext: true`.
   */
  publishFirstPayload(result: QueryResult<TData>): void;
}

/**
 * The commit channel of one in-flight request (§5.6, §7.13). A store that joins an in-flight request
 * shares its whole result, not just its final state: the leader publishes each commit it accepts and
 * every joiner receives it while the response is still streaming, so a joiner's `hasNext`,
 * `deferred` and data track the patches the way the leader's do.
 */
export interface RequestJoins<TData> {
  /** Registers one joiner; the returned function unregisters it. */
  add(listener: (patch: Partial<QueryResult<TData>>) => void): () => void;
  /** Fans one accepted leader commit out to every registered joiner. */
  publish(patch: Partial<QueryResult<TData>>): void;
}

/** The per-client in-flight table. */
export class RequestRegistry {
  readonly #entries = new Map<string, InFlightRequest<unknown>>();

  /** Creates and registers a leader entry; the caller runs the pipeline and calls `resolve`. */
  create<TData>(
    key: string,
    requestId: number,
    controller: AbortController,
  ): InFlightRequest<TData> {
    let settle: ((result: QueryResult) => void) | undefined;
    const promise = new Promise<QueryResult>((resolve) => {
      settle = resolve;
    });
    const listeners = new Set<(patch: Partial<QueryResult<TData>>) => void>();
    const firstPayloadListeners = new Set<(result: QueryResult<TData>) => void>();
    const entry: InFlightRequest<TData> = {
      key,
      controller,
      promise,
      requestId,
      refs: 1,
      failure: undefined,
      result: null,
      firstPayload: null,
      resolve: (result) => settle?.(result),
      joins: {
        add: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        // copied before iterating: a joiner may leave while the fan-out is running
        publish: (patch) => {
          for (const listener of Array.from(listeners)) {
            listener(patch);
          }
        },
      },
      onFirstPayload: (listener) => {
        // a read that joins after the payload landed still learns it: the entry remembers it
        if (entry.firstPayload !== null) {
          listener(entry.firstPayload);
          return () => {};
        }
        firstPayloadListeners.add(listener);
        return () => {
          firstPayloadListeners.delete(listener);
        };
      },
      publishFirstPayload: (result) => {
        if (entry.firstPayload !== null) {
          // a `hasNext: true` commit later in the same stream is a patch, not the first payload
          return;
        }
        entry.firstPayload = result;
        for (const listener of Array.from(firstPayloadListeners)) {
          listener(result);
        }
        firstPayloadListeners.clear();
      },
    };
    this.#entries.set(key, entry);
    return entry;
  }

  /** The in-flight entry for a key, if any. The caller owns the artifact's data type. */
  get<TData>(key: string): InFlightRequest<TData> | undefined {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the entry's TData is the artifact's own type, which the caller holds
    return this.#entries.get(key) as InFlightRequest<TData> | undefined;
  }

  /** Drops one reference; the entry leaves the table when the last store lets go of it. */
  release(entry: InFlightRequest<unknown>): void {
    entry.refs -= 1;
    if (entry.refs > 0) {
      return;
    }
    if (this.#entries.get(entry.key) === entry) {
      this.#entries.delete(entry.key);
    }
  }

  /** Aborts an entry's controller and removes it (`@dedupe(cancelFirst: true)`). */
  cancel(entry: InFlightRequest<unknown>): void {
    entry.controller.abort();
    if (this.#entries.get(entry.key) === entry) {
      this.#entries.delete(entry.key);
    }
  }

  /** Aborts every request in flight (`client.dispose()`). */
  abortAll(): void {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) {
      entry.controller.abort();
    }
  }

  /** How many requests are in flight. */
  get size(): number {
    return this.#entries.size;
  }
}

/** The `@dedupe` configuration of an artifact; the default shares by variables. */
export function dedupeConfigOf(artifact: Artifact): DedupeConfig {
  const record = asRecord(artifact.pluginData['dedupe']);
  if (record === null) {
    return { cancelFirst: false, match: 'variables' };
  }
  return {
    cancelFirst: record['cancelFirst'] === true,
    match: record['match'] === 'all' ? 'all' : 'variables',
  };
}

/** `` `${artifact.hash}::${stableStringify(variables)}` ``, or the hash alone for `match: 'all'`. */
export function requestKey(artifact: Artifact, variables: Variables): string {
  const config = dedupeConfigOf(artifact);
  return config.match === 'all'
    ? artifact.hash
    : `${artifact.hash}::${stableStringify(variables)}`;
}

/** Canonical JSON: object keys are sorted at every depth, so two equal records share one key. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = asRecord(value);
  if (record === null) {
    return 'undefined';
  }
  const keys = Object.keys(record).toSorted();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

/** The policy a request runs under; exported for the report's precedence table. */
export function resolveCachePolicy(
  explicit: CachePolicy | undefined,
  artifact: Artifact,
  fallback: CachePolicy,
): CachePolicy {
  return explicit ?? artifact.policy ?? fallback;
}
