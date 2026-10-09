/**
 * Configuring and providing the client, and the local-first queue with it.
 *
 * {@link flammeLayer} builds a runtime `Client` from an endpoint (or a transport override) and
 * provides the `Flamme` service from it; the layer's scope owns the client, so closing the scope
 * disposes it and aborts whatever is in flight. {@link clientLayer} provides the service over a
 * client the caller already owns, optionally disposing it with the layer.
 *
 * `local` is where the local-first queue enters: pass the store `createLocalFirst()` returned (or a
 * factory that builds one over the client this layer creates) and every mutation the `Flamme`
 * service runs goes through it. The app keeps the store: the layer only calls `mutate`, and
 * `dispose` when its scope closes.
 */
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { createClient, createFetchTransport } from '@flamme/runtime';
import type {
  Cache,
  CachePolicy,
  Client,
  ClientPlugin,
  FetchLike,
  SerializedCache,
  SubscribeFn,
  TransportFn,
} from '@flamme/runtime';

import type { FlammeQueue } from './queue.js';
import { Flamme, makeFlammeService } from './service.js';

/** Builds the queue from the client, for a layer that creates the client itself. */
export type FlammeQueueInput = FlammeQueue | ((client: Client) => FlammeQueue);

/** The `ClientConfig` fields both config shapes accept. */
interface FlammeConfigBase {
  /** The subscription transport; a client without one reports FLM3004 on a subscription. */
  readonly subscribe?: SubscribeFn;
  /** A pre-built cache, shared with a Vue app for example. */
  readonly cache?: Cache;
  /** Runtime plugins, appended to the artifact kind's defaults. */
  readonly plugins?: readonly ClientPlugin[];
  /** The policy an artifact without a baked policy falls back to. */
  readonly cachePolicy?: CachePolicy;
  /** Type name → key fields; the generated `cacheKeys`. */
  readonly keys?: Readonly<Record<string, readonly string[]>>;
  /** The key fields used for a type with no entry. */
  readonly defaultKeys?: readonly string[];
  /** Custom scalar unmarshalling. */
  readonly scalars?: Readonly<Record<string, { readonly unmarshal?: (value: unknown) => unknown }>>;
  /** A snapshot to hydrate before the first read (SSR). */
  readonly hydrate?: SerializedCache;
  /** `false` installs the client with fetching disabled. */
  readonly enabled?: boolean;
  /**
   * The local-first queue (`@flamme/local`'s store, or anything shaped like it). Given a factory,
   * it is built with the client this layer creates and disposed with it.
   */
  readonly local?: FlammeQueueInput;
}

/** Builds the HTTP transport from an endpoint, the headers and an optional `fetch` implementation. */
export interface FlammeEndpointConfig extends FlammeConfigBase {
  /** The GraphQL endpoint. */
  readonly url: string;
  /** Headers sent with every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The underlying `fetch`; defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Request credentials mode. */
  readonly credentials?: RequestCredentials;
}

/** Brings your own transport and skips the HTTP one entirely. */
export interface FlammeTransportConfig extends FlammeConfigBase {
  /** The transport every request goes through. */
  readonly transport: TransportFn;
}

/** What {@link flammeLayer} accepts: an endpoint, or a transport of your own. */
export type FlammeConfig = FlammeEndpointConfig | FlammeTransportConfig;

/** Options of {@link clientLayer}. */
export interface ClientLayerOptions {
  /** The local-first queue to route mutations through. */
  readonly local?: FlammeQueueInput;
  /** Dispose the queue and the client when the layer's scope closes. Defaults to `false`. */
  readonly dispose?: boolean;
}

/** Builds the client a config describes; hydration happens here, before anything can read. */
export function buildClient(config: FlammeConfig): Client {
  const transport =
    'transport' in config
      ? config.transport
      : createFetchTransport({
          url: config.url,
          ...(config.headers === undefined ? {} : { headers: config.headers }),
          ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
          ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
        });
  const client = createClient({
    fetch: transport,
    ...(config.subscribe === undefined ? {} : { subscribe: config.subscribe }),
    ...(config.cache === undefined ? {} : { cache: config.cache }),
    ...(config.plugins === undefined ? {} : { plugins: config.plugins }),
    ...(config.cachePolicy === undefined ? {} : { cachePolicy: config.cachePolicy }),
    ...(config.keys === undefined ? {} : { keys: config.keys }),
    ...(config.defaultKeys === undefined ? {} : { defaultKeys: config.defaultKeys }),
    ...(config.scalars === undefined ? {} : { scalars: config.scalars }),
    ...(config.enabled === undefined ? {} : { enabled: config.enabled }),
  });
  if (config.hydrate !== undefined) {
    client.hydrate(config.hydrate);
  }
  return client;
}

/** Resolves the queue input against the client the layer built. */
function queueOf(input: FlammeQueueInput | undefined, client: Client): FlammeQueue | null {
  if (input === undefined) {
    return null;
  }
  return typeof input === 'function' ? input(client) : input;
}

/** Disposes a service's queue and client in that order; the queue owns a view of the client. */
function disposeService(service: {
  readonly client: Client;
  readonly queue: FlammeQueue | null;
}): void {
  service.queue?.dispose?.();
  service.client.dispose();
}

/** A layer that builds a client from a config and disposes it (and its queue) when the scope closes. */
export function flammeLayer(config: FlammeConfig): Layer.Layer<Flamme> {
  return Layer.effect(
    Flamme,
    Effect.acquireRelease(
      Effect.sync(() => {
        const client = buildClient(config);
        return makeFlammeService(client, queueOf(config.local, client));
      }),
      (service) =>
        Effect.sync(() => {
          disposeService(service);
        }),
    ),
  );
}

/** A layer that provides the service over a client you already have. */
export function clientLayer(client: Client, options: ClientLayerOptions = {}): Layer.Layer<Flamme> {
  const queue = queueOf(options.local, client);
  if (options.dispose !== true) {
    return Layer.succeed(Flamme, makeFlammeService(client, queue));
  }
  return Layer.effect(
    Flamme,
    Effect.acquireRelease(
      Effect.sync(() => makeFlammeService(client, queue)),
      (service) =>
        Effect.sync(() => {
          disposeService(service);
        }),
    ),
  );
}
