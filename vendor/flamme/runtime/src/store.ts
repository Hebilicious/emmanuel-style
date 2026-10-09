/**
 * `DocumentStore` (§5.3).
 *
 * The store is a thin refcounted wrapper over a `QueryLifecycle` (§5.8): it adds `send`, `set`,
 * `cleanup` and `subscriberCount` and forwards everything else. The first subscriber starts the
 * store (a setup pass: the cache read and the cache subscription, never a request), the last
 * unsubscribe runs `cleanup()`, and a later subscriber restarts it.
 */
import type { Artifact, ArtifactKind, CachePolicy, FragmentReference, Variables } from './artifact.js';
import type { Client, QueryOptions } from './client.js';
import type { QueryLifecycle, QueryLifecycleOptions } from './lifecycle.js';
import { isStoreLifecycle } from './lifecycle.js';
import type { ClientPlugin } from './pipeline.js';
import type { QueryResult } from './result.js';
import { ClientDisposedError } from './errors.js';
import { clientRequests, isClientDisposed, releaseStore } from './client.js';

export class DocumentStore<TData = unknown> {
  readonly #client: Client;
  readonly #lifecycle: QueryLifecycle<TData>;
  readonly #policy: CachePolicy | undefined;
  #variables: Variables;
  #subscriberCount = 0;
  #started = false;

  constructor(options: DocumentStoreOptions<TData>) {
    this.#client = options.client;
    this.#policy = options.policy;
    this.#variables = options.variables ?? {};
    this.#lifecycle =
      options.lifecycle ?? options.client.config.lifecycle(buildLifecycleOptions(options));
  }

  /** Frozen snapshot. Replaced (never mutated) on every notification. */
  get state(): QueryResult<TData> {
    return this.#lifecycle.result;
  }

  /** The frozen snapshot identity the lifecycle exposes; it changes only when the result changes. */
  get snapshot(): unknown {
    return this.#lifecycle.snapshot;
  }

  /**
   * Subscribe to result changes. The first subscriber starts the store (cache read plus cache
   * subscription, no request); the last unsubscribe tears it down (§5.3).
   */
  subscribe(run: (value: QueryResult<TData>) => void): () => void {
    assertAlive(this.#client);
    const off = this.#lifecycle.subscribe(run);
    this.#subscriberCount += 1;
    if (this.#subscriberCount === 1 && !this.#started) {
      this.#started = true;
      void this.send({ setup: true }).catch(() => {
        // a setup pass performs no request, so the only failure possible is a disposed client
        this.#started = false;
      });
    }
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      off();
      this.#subscriberCount -= 1;
      if (this.#subscriberCount === 0) {
        this.cleanup();
      }
    };
  }

  /** Run the pipeline. Resolves with the final result of this request (or the shared in-flight one). */
  send(options: SendOptions = {}): Promise<QueryResult<TData>> {
    assertAlive(this.#client);
    const pageRequest = options.cacheParams?.disableSubscriptions === true;
    if (options.variables !== undefined && !pageRequest) {
      this.#variables = options.variables;
    }
    return this.#lifecycle.fetch(options.variables ?? this.#variables, queryOptionsOf(options, this.#policy));
  }

  /** Write a new result and notify. Frozen before delivery. */
  set(value: QueryResult<TData>): void {
    if (isStoreLifecycle(this.#lifecycle)) {
      this.#lifecycle.setResult(value);
      return;
    }
    throw new Error(
      'DocumentStore.set needs a lifecycle that can replace its result. The default createQueryLifecycle provides setResult.',
    );
  }

  /** Abort in-flight work, drop the cache subscription, dispose the layer. Idempotent. */
  cleanup(): void {
    this.#lifecycle.dispose();
    this.#subscriberCount = 0;
    this.#started = false;
    releaseStore(this.#client, this);
  }

  /** How many listeners the store currently has. */
  get subscriberCount(): number {
    return this.#subscriberCount;
  }
}

export interface DocumentStoreOptions<TData> {
  readonly client: Client;
  readonly artifact: Artifact<ArtifactKind, TData>;
  readonly variables?: Variables;
  readonly initialValue?: TData | null;
  readonly fetching?: boolean;
  readonly enabled?: boolean;
  readonly plugins: readonly ClientPlugin[];
  /** Resolved instance; defaults to `createQueryLifecycle(...)` (§5.8). */
  readonly lifecycle?: QueryLifecycle<TData>;
  /** The policy every `send` of this store uses unless it is overridden (additive, §5.1). */
  readonly policy?: CachePolicy;
  /** The fragment reference this store reads through (additive, §5.3). */
  readonly reference?: FragmentReference;
}

/**
 * §5.3 declares this interface as `SendOptions<TData>`, but none of its fields mentions `TData`
 * (`optimistic` is `Readonly<Record<string, unknown>>`); an unused type parameter is a compile
 * error under this repo's `noUnusedParameters`, so the parameter is not declared. `TData` stays on
 * the store's own `send`, where it is carried by `QueryResult<TData>`.
 */
export interface SendOptions {
  readonly variables?: Variables;
  readonly policy?: CachePolicy;
  readonly setup?: boolean;
  readonly silenceEcho?: boolean;
  readonly cacheParams?: {
    /** Do not register a cache subscription for this request (page requests). */
    readonly disableSubscriptions?: boolean;
    /** Merge directions to apply when writing the payload. */
    readonly applyUpdates?: readonly ('append' | 'prepend')[];
  };
  readonly optimistic?: Readonly<Record<string, unknown>>;
}

/** The `QueryOptions` one `send` builds; `sendOptions` carries the store-level §5.3 fields. */
function queryOptionsOf(options: SendOptions, policy: CachePolicy | undefined): QueryOptions {
  const effective = options.policy ?? policy;
  const sendOptions = {
    ...(options.silenceEcho === undefined ? {} : { silenceEcho: options.silenceEcho }),
    ...(options.cacheParams === undefined ? {} : { cacheParams: options.cacheParams }),
    ...(options.optimistic === undefined ? {} : { optimistic: options.optimistic }),
  };
  return {
    ...(options.variables === undefined ? {} : { variables: options.variables }),
    ...(effective === undefined ? {} : { policy: effective }),
    ...(options.setup === true ? { setup: true } : {}),
    ...(Object.keys(sendOptions).length === 0 ? {} : { sendOptions }),
  };
}

/** Throws FLM4006 when the client is gone; the store's two entry points share it. */
function assertAlive(client: Client): void {
  if (isClientDisposed(client)) {
    throw new ClientDisposedError(
      'This store belongs to a client that has been disposed, so it can never be delivered (FLM4006).',
      { hint: 'create one client per app (or per SSR request) and keep it alive for that request' },
    );
  }
}

/** The options the client's lifecycle factory receives for one store. */
function buildLifecycleOptions<TData>(
  options: DocumentStoreOptions<TData>,
): QueryLifecycleOptions<TData> {
  return {
    client: options.client,
    artifact: options.artifact,
    plugins: options.plugins,
    requests: clientRequests(options.client),
    ...(options.variables === undefined ? {} : { variables: options.variables }),
    ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
    ...(options.fetching === undefined ? {} : { fetching: options.fetching }),
    ...(options.reference === undefined ? {} : { reference: options.reference }),
  };
}
