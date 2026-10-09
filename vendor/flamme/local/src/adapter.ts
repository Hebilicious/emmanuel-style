/**
 * The adapters: the injectable persistence boundary of the local-first layer.
 *
 * Every adapter is a three-method string store (`get`/`set`/`remove`), so the store above it never
 * knows whether the snapshot lives in IndexedDB, in `localStorage`, in a `Map`, or in a file. The
 * browser default is {@link browserAdapter}: IndexedDB first, `localStorage` second, memory last,
 * and a failing probe (Safari's private mode throws on `localStorage` access) falls through to the
 * next layer instead of breaking boot.
 */
import type { LocalAdapter } from './types.js';

/** The subset of the `Storage` interface `localStorageAdapter` needs; the DOM `Storage` satisfies it. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Options of {@link localStorageAdapter}. */
export interface LocalStorageAdapterOptions {
  /** The storage to use. Default `globalThis.localStorage`; there is no silent fallback here. */
  readonly storage?: StorageLike;
}

/**
 * The one member of the DOM's `IDBFactory` the adapter uses, with the request, database, transaction
 * and store shapes it reads through.
 *
 * Declaring the boundary structurally is what makes the adapter testable without a browser: a fake
 * that satisfies these five interfaces is accepted with no assertion, and the DOM's own types
 * satisfy them as they are.
 */
export interface IndexedDBFactoryLike {
  open(name: string, version?: number): IDBOpenRequestLike;
}

/** An open request: the upgrade hook, the result and the failure. */
export interface IDBOpenRequestLike {
  readonly result: IDBDatabaseLike;
  readonly error: unknown;
  addEventListener(type: string, listener: () => void): void;
}

/** The opened database, to the extent the adapter needs it. */
export interface IDBDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
  transaction(name: string, mode: IDBTransactionMode): IDBTransactionLike;
}

/** A transaction: its store, its failure and the completion hook `set` waits for. */
export interface IDBTransactionLike {
  objectStore(name: string): IDBObjectStoreLike;
  readonly error: unknown;
  addEventListener(type: string, listener: () => void): void;
}

/** The object store: three request-returning operations. */
export interface IDBObjectStoreLike {
  get(key: string): IDBRequestLike;
  put(value: string, key: string): IDBRequestLike;
  delete(key: string): IDBRequestLike;
}

/** One request: its result, its failure and the success hook. */
export interface IDBRequestLike {
  readonly result: unknown;
  readonly error: unknown;
  addEventListener(type: string, listener: () => void): void;
}

/** Options of {@link indexedDBAdapter}. */
export interface IndexedDBAdapterOptions {
  /** The database name. Default `'flamme-local'`. */
  readonly database?: string;
  /** The object store holding the snapshot. Default `'snapshots'`. */
  readonly store?: string;
  /** The IDB factory; default `globalThis.indexedDB`. Tests inject a fake. */
  readonly factory?: IndexedDBFactoryLike;
}

/** Options of {@link browserAdapter}: the union of both adapter options. */
export type BrowserAdapterOptions = IndexedDBAdapterOptions & LocalStorageAdapterOptions;

/**
 * A `Map`-backed adapter: the test adapter, and the fallback when a host has no browser storage.
 *
 * `initial` seeds the map, so a test can hand the store a snapshot without a write.
 */
export function memoryAdapter(initial: Readonly<Record<string, string>> = {}): LocalAdapter {
  const records = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key: string): Promise<string | null> => records.get(key) ?? null,
    set: async (key: string, value: string): Promise<void> => {
      records.set(key, value);
    },
    remove: async (key: string): Promise<void> => {
      records.delete(key);
    },
  };
}

/**
 * A `localStorage` adapter. `setItem` is synchronous under the hood, which is what makes it the
 * fallback for a host whose IndexedDB is blocked; it throws on a quota failure, and the store turns
 * that into a `storage` error without losing the in-memory state.
 */
export function localStorageAdapter(options: LocalStorageAdapterOptions = {}): LocalAdapter {
  const storage: StorageLike | undefined = options.storage ?? globalThis.localStorage;
  if (storage === undefined) {
    throw new Error(
      'localStorageAdapter() needs a Storage: pass { storage } or use browserAdapter() for the fallback chain.',
    );
  }
  return {
    get: async (key: string): Promise<string | null> => storage.getItem(key),
    set: async (key: string, value: string): Promise<void> => {
      storage.setItem(key, value);
    },
    remove: async (key: string): Promise<void> => {
      storage.removeItem(key);
    },
  };
}

/**
 * An IndexedDB adapter: one database, one object store, one record per key.
 *
 * The database is opened lazily once and the promise is cached, so the first `get`/`set` pays the
 * open. A `set` resolves after the transaction **completes**, so `persist()` resolving means the
 * snapshot is committed rather than merely requested.
 */
export function indexedDBAdapter(options: IndexedDBAdapterOptions = {}): LocalAdapter {
  const factory: IndexedDBFactoryLike | undefined = options.factory ?? globalThis.indexedDB;
  if (factory === undefined) {
    throw new Error(
      'indexedDBAdapter() needs an IDBFactory: use browserAdapter() for the IndexedDB/localStorage fallback chain.',
    );
  }
  const database = options.database ?? 'flamme-local';
  const store = options.store ?? 'snapshots';
  let opened: Promise<IDBDatabaseLike> | null = null;

  const open = (): Promise<IDBDatabaseLike> => {
    opened ??= new Promise<IDBDatabaseLike>((resolve, reject) => {
      const request = factory.open(database, 1);
      request.addEventListener('upgradeneeded', () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store);
        }
      });
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () =>
        reject(request.error ?? new Error(`could not open the IndexedDB database "${database}"`)),
      );
      request.addEventListener('blocked', () =>
        reject(new Error(`the IndexedDB database "${database}" is blocked by another tab`)),
      );
    });
    return opened;
  };

  const transaction = async (mode: IDBTransactionMode): Promise<IDBObjectStoreLike> => {
    const db = await open();
    return db.transaction(store, mode).objectStore(store);
  };

  return {
    get: async (key: string): Promise<string | null> => {
      const objectStore = await transaction('readonly');
      const request = objectStore.get(key);
      return new Promise<string | null>((resolve, reject) => {
        request.addEventListener('success', () => {
          const value: unknown = request.result;
          resolve(typeof value === 'string' ? value : null);
        });
        request.addEventListener('error', () =>
          reject(request.error ?? new Error('the IndexedDB read failed')),
        );
      });
    },
    set: async (key: string, value: string): Promise<void> => {
      const db = await open();
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      await commit(tx);
    },
    remove: async (key: string): Promise<void> => {
      const db = await open();
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      await commit(tx);
    },
  };
}

/**
 * The browser default: IndexedDB when it is usable, `localStorage` when it is, memory otherwise.
 *
 * The probes are cheap on purpose. IndexedDB is preferred because it is asynchronous (a large cache
 * never blocks the main thread) and has no 5 MB ceiling; `localStorage` is the fallback for hosts
 * that block IDB, and memory keeps a non-browser or locked-down host working for the session.
 */
export function browserAdapter(options: BrowserAdapterOptions = {}): LocalAdapter {
  const factory: IndexedDBFactoryLike | undefined = options.factory ?? globalThis.indexedDB;
  if (factory !== undefined) {
    // `options` is not a fresh literal here, so the extra `storage` key is not an excess property
    return indexedDBAdapter(options);
  }
  const storage = options.storage ?? probeLocalStorage();
  if (storage !== null) {
    return localStorageAdapter({ storage });
  }
  return memoryAdapter();
}

/** Awaits a transaction's completion, so a `set` resolves only once the data is committed. */
function commit(tx: IDBTransactionLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('error', () => reject(tx.error ?? new Error('the IndexedDB transaction failed')));
    tx.addEventListener('abort', () => reject(tx.error ?? new Error('the IndexedDB transaction was aborted')));
  });
}

/** `globalThis.localStorage` when reading it does not throw, else `null` (Safari's private mode). */
function probeLocalStorage(): StorageLike | null {
  try {
    const storage: StorageLike | undefined = globalThis.localStorage;
    if (storage === undefined) {
      return null;
    }
    storage.getItem('flamme.local.probe');
    return storage;
  } catch {
    return null;
  }
}
