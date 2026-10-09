/**
 * The `Pending` sentinel, the loading-frame marker and the two predicates (§8.7, D3).
 *
 * This is the whole framework-agnostic half of the loading state: `cache.read({ loading: true })`
 * builds frames with these primitives, and `@flamme/vue` re-exports the predicates for
 * template use. Nothing here imports `vue`.
 */

/**
 * The nominal brand of the sentinel. The type is `typeof brand` for a separately declared
 * `unique symbol`, not the literal `unique symbol`: a member whose type is written `unique symbol`
 * must be both `static` and `readonly` (TS1331). Removing the private member instead would make
 * `LoadingType` structurally satisfiable by any object and destroy the guarantee that only
 * `PendingValue` can be a placeholder.
 */
declare const brand: unique symbol;

let pendingValue: Pending | undefined;

/**
 * The placeholder a loading read substitutes for a value. The constructor is private, so
 * `PendingValue` is the only value of type `LoadingType` in existence (§8.7).
 */
export class Pending {
  declare private readonly __brand: typeof brand;

  private constructor() {}

  static {
    // The singleton is created here because the constructor is private; `Object.freeze` prevents
    // accidental mutation of the one shared placeholder.
    pendingValue = new Pending();
    Object.freeze(pendingValue);
  }
}

/**
 * The one and only placeholder value. It is a real runtime value: it can be stored in the cache,
 * put inside arrays, compared by identity and printed by Vue.
 */
export const PendingValue: Pending = pendingValue;

/** The placeholder type, produced only by `PendingValue`. */
export type LoadingType = Pending;

/** The loaded branch of a result or of one of its fields: everything that is not a loading frame. */
export type LoadedBranchOf<T> = Exclude<T, { readonly ' $loadingFrame': true }>;

/**
 * The non-enumerable marker a loading frame carries. `Symbol.for` keeps two copies of this package
 * in one bundle agreeing on the marker identity. It is written by the cache's loading read and read
 * only by `isPending`/`isLoaded`; the generated type-level twin is `' $loadingFrame'` (§3.2).
 */
export const LOADING_FRAME: unique symbol = Symbol.for('flamme.loadingFrame');

/**
 * Marks `frame` as a loading frame and returns it. The frame must be marked *before* it is frozen
 * (a frozen object cannot take a new property).
 */
export function markLoadingFrame<T extends object>(frame: T): T {
  Object.defineProperty(frame, LOADING_FRAME, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return frame;
}

/** `true` when `value` is a frame produced by a loading read. */
export function isLoadingFrame(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && LOADING_FRAME in value;
}

/**
 * `true` when the value is a `Pending` placeholder at any depth of a loading frame.
 *
 * The walk follows exactly the containers a frame produced: a `Pending`, an array (anywhere inside
 * a frame, e.g. an `@loading(count: n)` placeholder list) and a marked frame's own values. It does
 * **not** descend into an unmarked object, which is what makes `isPending(species)` false once the
 * composite resolves even when a nested leaf is still pending; that nested check is
 * `isPending(species.moves)` (§7.1, §8.7 property 1).
 *
 * Total: `null`, `undefined`, a symbol, a function and a cyclic object are all handled; cycles are
 * cut with a `WeakSet`.
 */
export function isPending<T>(value: T): value is T & LoadingType {
  return containsPending(value, new WeakSet());
}

/**
 * `true` when a result, or one of its fields, is on its loaded branch. Only a loading frame is
 * unloaded; a `Pending` leaf is not a frame, so `isPending` remains the leaf predicate (§8.7
 * property 2, §8.9).
 */
export function isLoaded<T>(value: T): value is LoadedBranchOf<T> {
  return !isLoadingFrame(value);
}

function containsPending(value: unknown, seen: WeakSet<object>): boolean {
  if (value instanceof Pending) {
    return true;
  }

  if (isArray(value)) {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    for (const entry of value) {
      if (containsPending(entry, seen)) {
        return true;
      }
    }
    return false;
  }

  if (!isLoadingFrame(value)) {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  for (const entry of Object.values(value)) {
    if (containsPending(entry, seen)) {
      return true;
    }
  }
  return false;
}

/**
 * `Array.isArray` narrowed to `readonly unknown[]`, so the element walk never handles `any`.
 */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
