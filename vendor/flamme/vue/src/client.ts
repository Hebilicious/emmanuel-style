/**
 * The app plugin and the injection key (§8.1, §8.8).
 *
 * `createFlamme` owns one client per app (one per request on the server), creates it inside a
 * **detached** `effectScope` so nothing it registers can attach to a module-level parent, marks it
 * raw so a `reactive()` wrapper can never deep-proxy the cache, and disposes client and scope
 * together (D6, `[vue-reactivity-ssr.md D.2, D.4 pitfall 7]`).
 */
import {
  effectScope,
  hasInjectionContext,
  inject,
  markRaw,
  toRaw,
  type App,
  type EffectScope,
  type InjectionKey,
} from 'vue';
import { createClient } from '@flamme/runtime';
import { createLocalFirst } from '@flamme/local';
import type {
  LocalAdapter,
  LocalEventTarget,
  LocalFirst,
  LocalRetryOptions,
  LocalScheduler,
  OnlineSource,
} from '@flamme/local';
import { LOCAL_KEY } from '@flamme/local/vue';
import type {
  Cache,
  CachePolicy,
  Client,
  ClientConfig,
  ClientPlugin,
  SerializedCache,
  SubscribeFn,
  TransportFn,
} from '@flamme/runtime';

import { warnOnce } from './dev.js';

/** Injection key for the per-app (per-request on the server) client. */
export const FLAMME_KEY: InjectionKey<Client> = Symbol.for('flamme');

/**
 * How many apps each client has been installed into, so a module-scope client reused across SSR
 * requests is reported. One client per app (per request on the server) is the whole lifecycle
 * contract (§8.1, D6); a shared one leaks the first request's records into the next request's
 * `serialize()` with no other symptom (`review-slice34-adversarial.md` M15).
 */
const installations = new WeakMap<Client, number>();

/**
 * Local-first for the whole app: `createFlamme({ local: true })` for the browser defaults, or an
 * options object. Everything here is optional; the defaults are the ones `createLocalFirst()` uses.
 */
export interface FlammeLocalOptions {
  /** Where the snapshot lives. Default `browserAdapter()`: IndexedDB, then `localStorage`. */
  readonly adapter?: LocalAdapter;
  /** The adapter key of the snapshot. Default `'flamme.local.v1'`. */
  readonly key?: string;
  /** Connectivity source; default reads `navigator.onLine` and is `true` outside a browser. */
  readonly online?: OnlineSource;
  /** The backoff of a retryable transport failure. */
  readonly retry?: LocalRetryOptions;
  /** Attempts before a retryable failure parks the entry. Default `Infinity`. */
  readonly maxAttempts?: number;
  /** The clock every timestamp comes from. Default `Date.now`. */
  readonly now?: () => number;
  /** The delayed-retry scheduler. Default `setTimeout`; tests inject a fake. */
  readonly schedule?: LocalScheduler;
  /** The event target for the browser wiring; `null` disables it. Default `globalThis.window`. */
  readonly events?: LocalEventTarget | null;
}

/**
 * The configuration `createFlamme` accepts: either a client that already exists, or the factory and
 * config that build one inside the detached scope.
 */
export interface FlammeOptions {
  /** A client this app takes ownership of. Mutually exclusive with {@link FlammeOptions.createClient}. */
  readonly client?: Client;
  /**
   * Builds the client inside the detached scope. Defaults to `createClient` from
   * `@flamme/runtime`, so `createFlamme({ fetch })` is the whole §8.1 entry point; pass a
   * factory only to substitute a different client implementation.
   */
  readonly createClient?: (config: ClientConfig) => Client;
  /** Transport, forwarded to {@link FlammeOptions.createClient}. */
  readonly fetch?: TransportFn;
  /** Subscription transport, forwarded to {@link FlammeOptions.createClient}. */
  readonly subscribe?: SubscribeFn;
  /** A pre-built cache, forwarded to {@link FlammeOptions.createClient}. */
  readonly cache?: Cache;
  /** Runtime plugins, forwarded to {@link FlammeOptions.createClient}. */
  readonly plugins?: readonly ClientPlugin[];
  /** The policy an artifact without a baked policy falls back to. */
  readonly cachePolicy?: CachePolicy;
  /** Type name → key fields; pass the generated `cacheKeys` (§4.7). */
  readonly keys?: Readonly<Record<string, readonly string[]>>;
  /** The key fields used for a type with no entry. */
  readonly defaultKeys?: readonly string[];
  /** Custom scalar unmarshalling, forwarded to {@link FlammeOptions.createClient}. */
  readonly scalars?: Readonly<Record<string, { readonly unmarshal?: (value: unknown) => unknown }>>;
  /** Hydrated synchronously, before the app mounts (§8.11). */
  readonly hydrate?: SerializedCache;
  /**
   * Local-first: the app gets a durable cache, an offline queue and a sync status, and
   * `useMutation` becomes local-first (§8.5). `true` takes the browser defaults; an object
   * configures the store exactly as `createLocalFirst()` would.
   *
   * This is the mode's whole entry point: the container builds the store, adds its pipeline plugin
   * to the client it builds, installs it with {@link FlammeApp.plugin}, and
   * {@link FlammeApp.ready} resolves once the snapshot is restored.
   */
  readonly local?: boolean | FlammeLocalOptions;
}

/** The handle the plugin installs and the app disposes. */
export interface FlammeApp {
  /** The raw (never reactive) client every composable injects. */
  readonly client: Client;
  /** `app.use(flamme.plugin)`. Installs the client and, with `local`, the local-first store. */
  readonly plugin: { install(app: App): void };
  /** The detached scope the client was created in. */
  readonly scope: EffectScope;
  /** The local-first store `local` asked for, or `null` when the app has none. */
  readonly local: LocalFirst | null;
  /**
   * Resolves when the container is usable: the client exists and, with `local`, the durable
   * snapshot is restored and the queued writes are back in their optimistic layers.
   *
   * Await it before the router is built and before the first render, which is what makes a warm
   * start paint from the device with no request at all.
   */
  readonly ready: Promise<void>;
  /** Aborts in-flight work, disposes the stack LIFO, stops the scope. Idempotent. */
  dispose(): void;
}

/** The `app.use(FlammePlugin, …)` options: an existing client, installed as-is. */
export interface FlammePluginOptions {
  /** The client this app provides. */
  readonly client: Client;
}

/** Installs an existing client: `app.use(FlammePlugin, { client })`. */
export const FlammePlugin: { install(app: App, options: FlammePluginOptions): void } = {
  install(app: App, options: FlammePluginOptions): void {
    reportServerReuse(options.client);
    installClient(app, options.client);
  },
};

/**
 * Builds the plugin object a `Client` is installed through. Shared by {@link createFlamme} and
 * {@link FlammePlugin} so both surfaces provide the same key and global property.
 */
function installClient(
  app: App,
  client: Client,
  onUnmount?: () => void,
): void {
  app.provide(FLAMME_KEY, client);
  // `$flamme` is declared `readonly` (it is a template read surface, §8.1), so the install
  // writes it through `Object.assign`, which the declared type does not forbid.
  Object.assign(app.config.globalProperties, { $flamme: client });
  if (onUnmount !== undefined) {
    app.onUnmount(onUnmount);
  }
}

/** Collects the `ClientConfig` fields an options object actually carries (exactOptionalPropertyTypes). */
function clientConfigOf(
  options: FlammeOptions,
  fetch: TransportFn,
  plugins: readonly ClientPlugin[] | undefined,
): ClientConfig {
  return {
    fetch,
    ...(options.subscribe === undefined ? {} : { subscribe: options.subscribe }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(plugins === undefined ? {} : { plugins }),
    ...(options.cachePolicy === undefined ? {} : { cachePolicy: options.cachePolicy }),
    ...(options.keys === undefined ? {} : { keys: options.keys }),
    ...(options.defaultKeys === undefined ? {} : { defaultKeys: options.defaultKeys }),
    ...(options.scalars === undefined ? {} : { scalars: options.scalars }),
  };
}

/**
 * The store `createFlamme`'s `local` option asks for, or `null`.
 *
 * `local: true` is the browser default (`createLocalFirst({})`); an object is forwarded field by
 * field, so `exactOptionalPropertyTypes` never sees an explicit `undefined`.
 */
function localStoreOf(local: FlammeOptions['local']): LocalFirst | null {
  if (local === undefined || local === false) {
    return null;
  }
  if (local === true) {
    return createLocalFirst({});
  }
  return createLocalFirst({
    ...(local.adapter === undefined ? {} : { adapter: local.adapter }),
    ...(local.key === undefined ? {} : { key: local.key }),
    ...(local.online === undefined ? {} : { online: local.online }),
    ...(local.retry === undefined ? {} : { retry: local.retry }),
    ...(local.maxAttempts === undefined ? {} : { maxAttempts: local.maxAttempts }),
    ...(local.now === undefined ? {} : { now: local.now }),
    ...(local.schedule === undefined ? {} : { schedule: local.schedule }),
    ...(local.events === undefined ? {} : { events: local.events }),
  });
}

/**
 * Creates the per-app container: a detached scope, the client inside it, hydration before mount, and
 * one idempotent `dispose()`.
 */
/** Reports a client that a second app installed on the server, once per client. */
function reportServerReuse(client: Client): void {
  if (typeof window !== 'undefined') {
    return;
  }
  const count = (installations.get(client) ?? 0) + 1;
  installations.set(client, count);
  if (count > 1) {
    warnOnce(
      'shared-server-client',
      'The same flamme client was installed into a second app on the server. Create one client per ' +
        "SSR request (createFlamme({ fetch, … }) inside the request), or the previous request's " +
        "records leak into this request's serialize() payload (FLM4008).",
    );
  }
}

export function createFlamme(options: FlammeOptions): FlammeApp {
  const scope = effectScope(true);
  const build = options.createClient ?? createClient;
  const fetch = options.fetch;
  // The store is built first: its pipeline plugin has to be in the plugin list of the client this
  // call builds, because the plugin list is resolved once, when the client is constructed.
  const local = localStoreOf(options.local);
  let created = options.client;
  if (created === undefined) {
    if (fetch === undefined) {
      throw new Error(
        'createFlamme() needs { fetch } (or { client } / { createClient }) to build a client',
      );
    }
    const plugins =
      local === null ? options.plugins : [...(options.plugins ?? []), local.plugin];
    created = scope.run(() => build(clientConfigOf(options, fetch, plugins)));
  }
  if (created === undefined) {
    throw new Error('createFlamme() could not create a client: the detached scope was stopped');
  }
  // `markRaw` keeps the client out of any reactive container the app installs it in; `toRaw`
  // unwraps a client that a caller already passed through `reactive()`, because marking a proxy
  // raw does not stop the proxy's invariant checks (`review-slice34-adversarial.md` M5).
  const raw = markRaw(toRaw(created));
  if (options.hydrate !== undefined) {
    raw.hydrate(options.hydrate);
  }
  if (local !== null) {
    if (options.client !== undefined) {
      // a client built outside this call already resolved its plugin list, so the store's pipeline
      // hook cannot join it: query results then persist on `pagehide`/`visibilitychange` instead of
      // after every request. A queued mutation still persists itself.
      warnOnce(
        'local-with-existing-client',
        'createFlamme({ client, local }) cannot add the local store\'s plugin to a client it did ' +
          'not build, so query results persist on the page lifecycle events only. Build the ' +
          'client inside createFlamme({ fetch, local }) to persist after every request.',
      );
    }
    local.connect(raw);
  }
  // `local.restore()` never rejects: a storage failure is reported on the status. The promise is
  // what the app awaits before the router exists, so a warm start paints from the device.
  const ready = local === null ? Promise.resolve() : local.restore();

  let disposed = false;
  const flamme: FlammeApp = {
    client: raw,
    scope,
    local,
    ready,
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      local?.dispose();
      raw.dispose();
      scope.stop();
    },
    plugin: {
      install(app: App): void {
        reportServerReuse(raw);
        installClient(app, raw, () => {
          flamme.dispose();
        });
        if (local !== null) {
          app.provide(LOCAL_KEY, local);
        }
      },
    },
  };
  return flamme;
}

/**
 * The injected client. Throws when called outside a setup/plugin context or when no client was
 * provided, because both are silent misconfigurations otherwise (§8.8).
 */
export function useFlamme(): Client {
  if (!hasInjectionContext()) {
    throw new Error('useFlamme() must be called inside setup() or a plugin install');
  }
  const client = inject(FLAMME_KEY);
  if (client === undefined) {
    throw new Error('no flamme client found; call app.use(createFlamme({ … }).plugin)');
  }
  return client;
}

declare module 'vue' {
  interface ComponentCustomProperties {
    readonly $flamme: Client;
  }
}
