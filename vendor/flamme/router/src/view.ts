/**
 * The stable reactive projection of a cache read the loader hands to vue-router.
 *
 * vue-router's basic loader commits `data` exactly once: `data` is a `shallowRef` and the loader
 * function's return value is the only thing ever written to it (D9, §11.2). A frozen one-shot
 * snapshot would therefore go stale the moment a mutation writes the cache. Instead the loader
 * returns a stable Vue `reactive` object and copies each new cache read into it, so the object's
 * identity never changes while its fields follow the cache, and a component's own `useQuery`
 * subscription remains the fine-grained source of truth.
 *
 * A sync is a top-level key copy. The cache returns deeply frozen, structurally shared reads
 * (`packages/runtime/src/cache/read.ts`), so every changed subtree arrives under a new object and
 * reassigning the top-level key is what notifies the placeholder-free reactive proxy. Unchanged
 * subtrees keep their identity and do not notify.
 */
import { reactive } from 'vue';

/** A mutable record: what a cache read is copied into. */
type MutableRecord = Record<string, unknown>;

/**
 * The loader's live data: a stable reactive object plus the function that keeps it in sync with the
 * cache.
 */
export interface CacheView<TData> {
  /** The stable reactive object, or `null` until a cache read produced data. */
  readonly value: TData | null;
  /** Copies a fresh cache read into the stable object without replacing its identity. */
  sync(data: unknown): void;
}

/**
 * Creates the stable reactive object a {@link CacheView} exposes.
 *
 * `sync(null)` and a non-record read (an array) clear the object and make {@link CacheView.value}
 * `null` again; a later read refills the same object, so a loader that returned it during navigation
 * keeps reflecting the cache.
 */
export function createCacheView<TData>(): CacheView<TData> {
  const proxy = reactive<MutableRecord>({});
  let filled = false;

  return {
    get value(): TData | null {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the caller declares TData; every value only ever comes from a cache read
      return filled ? (proxy as unknown as TData) : null;
    },
    sync(data: unknown): void {
      const source = asRecord(data);
      if (source === null) {
        filled = false;
        clear(proxy);
        return;
      }
      for (const key of Object.keys(proxy)) {
        if (!(key in source)) {
          delete proxy[key];
        }
      }
      for (const key of Object.keys(source)) {
        proxy[key] = source[key];
      }
      filled = true;
    },
  };
}

/** A plain object read result, or `null` for `null`, a scalar or an array. */
function asRecord(value: unknown): MutableRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed to a non-null, non-array object above
  return value as MutableRecord;
}

/** Removes every own key, which is what makes `value` read as `null` after a clear. */
function clear(target: MutableRecord): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
}
