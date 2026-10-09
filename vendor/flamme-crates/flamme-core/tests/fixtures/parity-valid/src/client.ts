/**
 * The app's client module (`spec/spec.md` §8.1).
 *
 * The transport is the only I/O the app owns: a POST of `{ query, variables, operationName }` to the
 * bundled fixture at `/graphql`. `createAppClient()` builds the per-app container (one client per
 * page load, per request on the server) with the cache-key map the compiler generated, so the
 * `flamme.config.ts` key configuration is never duplicated at runtime.
 *
 * Local-first is a **mode of that container**, not a second one: `createFlamme({ local })` builds the
 * durable store, places its pipeline plugin in the client's plugin list (which is why the factory
 * builds the client rather than taking one), and installs it with `flamme.plugin`. `flamme.ready` is
 * the restore, and `main.ts` awaits it before the router exists.
 */
import {
  browserAdapter,
  type LocalAdapter,
  type LocalFirst,
  type OnlineSource,
} from '@flamme/local';
import {
  HttpError,
  INCREMENTAL_ACCEPT,
  isMultipart,
  readMultipartResponse,
  type SerializedCache,
  type TransportFn,
  type TransportResponse,
} from '@flamme/runtime';
import { createFlamme, type FlammeApp } from '@flamme/vue';
import { cacheKeys, defaultKeys } from '$flamme';

/** The fixture endpoint `vite.config.ts` mounts from `server/handler.ts`. */
export const ENDPOINT = '/graphql';

/**
 * The adapter key of the app's durable snapshot (`@flamme/local`'s own default is
 * `'flamme.local.v1'`). Named here so a test can read exactly what the app wrote.
 */
export const LOCAL_SNAPSHOT_KEY = 'pokedex.local.v1';

/** A JSON body is a transport response when it is an object (all of its fields are optional). */
function isTransportResponse(value: unknown): value is TransportResponse {
  return typeof value === 'object' && value !== null;
}

/**
 * Builds the POST transport for one endpoint. The integration test reuses this exact function with
 * an absolute URL, so the code under test is the app's transport, not a test double.
 */
export function createTransport(endpoint: string): TransportFn {
  return async (request, signal) => {
    // §7.13: only a document that declares `@defer`/`@stream` asks for incremental delivery, so
    // every other request keeps the exact header set (and the exact JSON path) it had before.
    const incremental =
      request.artifact.deferred !== undefined && request.artifact.deferred.length > 0;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(incremental ? { accept: INCREMENTAL_ACCEPT } : {}),
      },
      body: JSON.stringify({
        query: request.query,
        variables: request.variables,
        operationName: request.operationName,
      }),
      signal,
    });
    if (!response.ok) {
      throw new HttpError(
        `the fixture API answered ${response.status} for ${request.operationName}`,
        response.status,
        await response.text(),
      );
    }
    if (isMultipart(response)) {
      return readMultipartResponse(response);
    }
    const body: unknown = await response.json();
    if (!isTransportResponse(body)) {
      throw new HttpError(
        `the fixture API answered a non-object body for ${request.operationName}`,
        response.status,
        JSON.stringify(body),
      );
    }
    return body;
  };
}

/** The app's transport: a POST to the fixture API at `/graphql`. */
export const transport: TransportFn = createTransport(ENDPOINT);

/** Options for {@link createAppClient}: tests replace the transport and never touch the network. */
export interface AppClientOptions {
  /** Transport override; defaults to {@link transport}. */
  readonly fetch?: TransportFn;
  /** A cache payload to hydrate synchronously before the app mounts (§8.11). */
  readonly hydrate?: SerializedCache;
  /** Where the durable snapshot lives. Default IndexedDB, then `localStorage`, then memory. */
  readonly adapter?: LocalAdapter;
  /** The adapter key of the snapshot. Default {@link LOCAL_SNAPSHOT_KEY}. */
  readonly key?: string;
  /**
   * Connectivity source. Default the platform's (`navigator.onLine`); a test or a host that knows
   * better passes its own, and the store also listens for the browser's `online`/`offline` events.
   */
  readonly online?: OnlineSource;
}

/** The app's Flamme container, plus the local-first store that makes it durable and offline-capable. */
export interface AppClient extends FlammeApp {
  /** The durable cache, the queue of local writes and their replay. */
  readonly local: LocalFirst;
}

/**
 * Builds the app's Flamme container with the spec §8.1 entry point: `createFlamme` builds the
 * runtime's `createClient` inside its detached scope. Called once per page load (never at module
 * scope, §8.11) so the cache and its subscriptions cannot leak between requests or tests.
 *
 * The local-first store is part of the same call: `local` is a mode of `createFlamme`, which builds
 * the store, adds its plugin to the client it is building, and installs it with `flamme.plugin`.
 * The restore is deliberately **not** awaited here: `main.ts` (and a test) awaits `flamme.ready`
 * before the first render.
 */
export function createAppClient(options: AppClientOptions = {}): AppClient {
  const flamme = createFlamme({
    fetch: options.fetch ?? transport,
    keys: cacheKeys,
    defaultKeys,
    local: {
      adapter: options.adapter ?? browserAdapter(),
      key: options.key ?? LOCAL_SNAPSHOT_KEY,
      ...(options.online === undefined ? {} : { online: options.online }),
    },
    ...(options.hydrate === undefined ? {} : { hydrate: options.hydrate }),
  });
  const local = flamme.local;
  if (local === null) {
    throw new Error('createFlamme() built no local store although the app asked for one');
  }
  return { ...flamme, local };
}
