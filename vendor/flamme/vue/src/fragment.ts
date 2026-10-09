/**
 * `useFragment` and `usePaginatedFragment` (§8.3, §8.4, D3).
 *
 * The parent hands the child its own masked object; the child reads
 * ``reference[' $fragments'][<Name>]`` and subscribes at **fragment** granularity, keyed on the parent
 * record and the fragment's own hash. The read is synchronous at setup, which is what makes SSR and
 * hydration one pass, and the reference is watched so a different record (or different fragment
 * arguments) re-reads and re-registers.
 *
 * A fragment that owns a `@paginate` field gets the page surface on top of that read: the compiler
 * emits a companion document (`<FragmentName>_Pagination_Query`) on
 * `artifact.paginationArtifact`, and `Client.fetchFragmentPage` lands a page on the **owner** record.
 * The new edges therefore arrive through `useFragment`'s own subscription, and the handle here never
 * owns a store (§6.8).
 */
import {
  computed,
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type ShallowRef,
} from 'vue';
import {
  MissingFragmentSpreadError,
  extractPageInfo,
  fragmentKey,
  isFragmentRef,
  isPending,
  type Artifact,
  type ArtifactData,
  type ArtifactKey,
  type FragmentReference,
  type PageInfo,
  type QueryResult,
  type Variables,
} from '@flamme/runtime';

import { useFlamme } from './client.js';
import { warnOnce } from './dev.js';
import { isRecord, sameVariables } from './keys.js';

/** The reactive fragment handle: the fragment's own data and its parent's pending state. */
export interface FragmentHandle<TData> {
  /** The fragment's masked selection, or `null` when the parent did not spread the fragment. */
  readonly data: ComputedRef<TData | null>;
  /** The parent's frame for this fragment is a placeholder, or the read produced a loading frame. */
  readonly pending: ComputedRef<boolean>;
  /**
   * Some of the fragment's fields are absent from the cache (§5.4). This is the signal a
   * `@defer`ed fragment reports before its patch lands: the reference exists, the fields do not, and
   * `data` is an object with them missing rather than `null`.
   */
  readonly partial: ComputedRef<boolean>;
}

/** Reads the ` $fragments` entry a masked parent carries for one fragment (§3.2, D3). */
function spreadOf(value: unknown, name: string): FragmentReference | null {
  if (!isRecord(value)) {
    return null;
  }
  const marker = value[fragmentKey];
  if (!isRecord(marker)) {
    return null;
  }
  const entry = marker[name];
  return isFragmentRef(entry) ? entry : null;
}

/** `true` when two references address the same record with the same variables. */
function sameReference(left: FragmentReference, right: FragmentReference): boolean {
  return left.parent === right.parent && sameVariables(left.variables, right.variables);
}

/** A parent record id for the diagnostic, or `unknown` when the value carries none. */
function parentOf(value: unknown): string {
  if (isRecord(value) && typeof value['id'] === 'string') {
    return value['id'];
  }
  if (isRecord(value) && typeof value['id'] === 'number') {
    return String(value['id']);
  }
  return 'unknown';
}

/**
 * Subscribes to one fragment of one parent record. Returns `null` data (and `pending: false`) when the
 * parent did not spread the fragment: the type system makes that a compile error, so the runtime
 * warning is the only signal left (§8.4, FLM4002).
 */
export function useFragment<A extends Artifact<'fragment'>>(
  reference: MaybeRefOrGetter<ArtifactKey<A> | null | undefined>,
  artifact: A,
): FragmentHandle<ArtifactData<A>> {
  type TData = ArtifactData<A>;

  const client = useFlamme();
  // The generated document is `Artifact<'fragment', TData, never, TKey>`; the generic `A` only
  // guarantees the constraint, so it is re-typed once at this boundary (§3.1).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the phantom carriers are not reachable through the constraint, so the document is re-typed once here (the generated module performs the same narrow)
  const document = artifact as Artifact<'fragment', TData, unknown, ArtifactKey<A>>;
  const result = shallowRef<QueryResult<TData> | null>(null);
  let current: FragmentReference | null = null;
  let unsubscribe: (() => void) | null = null;

  function detach(): void {
    unsubscribe?.();
    unsubscribe = null;
    current = null;
  }

  /** Re-reads and re-registers whenever the reference (or its variables) changes. */
  function update(incoming: unknown): void {
    const next = spreadOf(incoming, artifact.name);
    if (next === null) {
      detach();
      result.value = null;
      if (incoming !== null && incoming !== undefined) {
        const error = new MissingFragmentSpreadError(
          `useFragment(${artifact.name}) was handed a parent without a \`${artifact.name}\` spread; ` +
            'add `...' +
            artifact.name +
            '` to the parent document or guard the prop with `isLoaded`',
          artifact.name,
          parentOf(incoming),
        );
        warnOnce(`missing-spread:${artifact.name}`, `${error.message} (${error.code})`);
      }
      return;
    }
    if (current !== null && sameReference(current, next)) {
      return;
    }
    detach();
    current = next;
    result.value = client.readFragment<TData, ArtifactKey<A>>(document, next);
    unsubscribe = client.subscribeFragment<TData, ArtifactKey<A>>(document, next, (value) => {
      result.value = value;
    });
  }

  const stopReference = watch(() => toValue(reference), update, { immediate: true, flush: 'pre' });

  function dispose(): void {
    stopReference();
    detach();
  }

  // `getCurrentScope()` is `undefined` (not `null`) outside a scope, so the check is truthiness
  if (getCurrentScope()) {
    onScopeDispose(dispose);
  } else {
    client.retain({ dispose });
    warnOnce(
      'detached-use',
      'useFragment() was called outside a component scope (a plain function, a test or a route loader); ' +
        'the subscription is retained by the client and disposed with it (D6, §8.10).',
    );
  }

  const data = computed(() => result.value?.data ?? null);
  const pending = computed(() => {
    const value = toValue(reference);
    if (value !== null && value !== undefined && isPending(value)) {
      return true;
    }
    return data.value !== null && isPending(data.value);
  });

  return { data, pending, partial: computed(() => result.value?.partial ?? false) };
}

/** The reactive paginated-fragment handle of §8.3: the fragment handle plus the page surface. */
export interface PaginatedFragmentHandle<TData> extends FragmentHandle<TData> {
  /**
   * The connection's `pageInfo`, read off the fragment's own data at `artifact.refetch.path`, or
   * `null` when the artifact has no `refetch` spec **or** its method is `offset`.
   *
   * An offset list has no cursors and no `pageInfo` at all (Houdini never computes one), which is
   * also why `useQuery` has no `pageInfo` on that handle: `extractPageInfo` over a plain list would
   * report an all-false page that keeps an arrow alive.
   */
  readonly pageInfo: ComputedRef<PageInfo | null>;
  /** `pageInfo.hasNextPage` under the cursor guard; `false` for a fragment with no page surface. */
  readonly hasNextPage: ComputedRef<boolean>;
  /** `pageInfo.hasPreviousPage` under the cursor guard. Cursor pagination only. */
  readonly hasPreviousPage?: ComputedRef<boolean>;
  /** A next-page request is in flight. */
  readonly loadingNextPage: ComputedRef<boolean>;
  /** A previous-page request is in flight. Cursor pagination only. */
  readonly loadingPreviousPage?: ComputedRef<boolean>;
  /** Fetches the next page and merges it into the owner record; the fragment's read gains the edges. */
  loadNextPage(): Promise<void>;
  /** Fetches the previous page and merges it into the owner record. Cursor pagination only. */
  loadPreviousPage?(): Promise<void>;
}

/** The `usePaginatedFragment` options. */
export interface PaginatedFragmentOptions {
  /**
   * `false` makes the page methods inert (no request, no loading flag). Default `true`. The read
   * surface (`data`, `pending`, `partial`, `pageInfo`) is unaffected.
   */
  readonly enabled?: MaybeRefOrGetter<boolean>;
}

/**
 * The page surface of a fragment that owns a `@paginate` field (§8.3, §6.8).
 *
 * The **method** the compiler recorded decides the surface, exactly as it does for `useQuery`: a
 * cursor connection gets `pageInfo` and both arrows, an offset list gets `loadNextPage` with
 * `limit`/`offset` and nothing cursor-shaped. A page request runs through
 * `Client.fetchFragmentPage`, which merges the companion's defaults, the owner record's key fields
 * and the fragment's own variables into the page input and writes the response to the **owner**
 * record, so `useFragment`'s subscription is what delivers the new edges.
 */
export function usePaginatedFragment<A extends Artifact<'fragment'>>(
  reference: MaybeRefOrGetter<ArtifactKey<A> | null | undefined>,
  artifact: A,
  options?: PaginatedFragmentOptions,
): PaginatedFragmentHandle<ArtifactData<A>> {
  const client = useFlamme();
  const fragment = useFragment(reference, artifact);
  const refetch = artifact.refetch;
  const method = refetch?.method ?? 'cursor';
  const pageSize = refetch?.pageSize ?? 0;
  /** The path from the fragment's root to the list it pages; empty without a `@paginate` field. */
  const path = refetch?.path ?? [];
  // The companion document the compiler generates for a fragment that owns a `@paginate` field
  // (`<FragmentName>_Pagination_Query`, §7.3). Absent on a fragment without `@paginate`, and on a
  // module generated before fragment pagination existed: the page methods warn once and no-op.
  const companion = artifact.paginationArtifact;
  const loadingNext = shallowRef(false);
  const loadingPrevious = shallowRef(false);

  const pageInfo = computed<PageInfo | null>(() => {
    if (refetch === undefined || method === 'offset') {
      return null;
    }
    // `extractPageInfo` walks the fragment's **own** read: a connection embedded in a fragment's
    // owner record has no path from the document root, so there is no `readConnection` to ask.
    const info = extractPageInfo(fragment.data.value, path);
    // A server that reports `hasNextPage: true` with a `null` `endCursor` would otherwise leave the
    // arrow enabled forever: every click re-requests the page the fragment already has, because
    // there is no cursor to build the next request from (`review-slice34-adversarial.md` M7). The
    // arrow reports what pagination can actually do, the same guard `useQuery` applies.
    return {
      ...info,
      hasNextPage: info.hasNextPage && info.endCursor !== null,
      hasPreviousPage: info.hasPreviousPage && info.startCursor !== null,
    };
  });

  const hasNextPage = computed(() => pageInfo.value?.hasNextPage ?? false);

  /** The `{ parent, variables }` reference a page request goes through, or `null` with no spread. */
  function currentReference(): FragmentReference | null {
    return spreadOf(toValue(reference), artifact.name);
  }

  /** `true` unless the caller disabled the page surface. */
  function enabled(): boolean {
    return options?.enabled === undefined ? true : toValue(options.enabled);
  }

  /** How many entries the fragment's own list holds right now: `countPage` for an embedded list. */
  function loadedEntries(): number {
    let current: unknown = fragment.data.value;
    for (const field of path) {
      if (!isRecord(current)) {
        return 0;
      }
      current = current[field];
    }
    return Array.isArray(current) ? current.length : 0;
  }

  function warnMissingCompanion(): void {
    warnOnce(
      `fragment-pagination:${artifact.name}`,
      `usePaginatedFragment(${artifact.name}) has no pagination artifact: the fragment has no ` +
        '`@paginate` field, or its generated module predates fragment pagination. Add `@paginate` ' +
        `to the fragment's connection field and regenerate (\`${artifact.name}_Pagination_Query\`); ` +
        'the page methods are a no-op.',
    );
  }

  /**
   * Runs one page request behind the shared gates. `input` builds the page variables, or returns
   * `null` when the arrow for that direction is not usable: a `false` predicate performs no request
   * at all, which is the whole point of the arrow.
   */
  async function requestPage(
    direction: 'forward' | 'backward',
    loading: ShallowRef<boolean>,
    input: () => Variables | null,
  ): Promise<void> {
    if (companion === undefined) {
      warnMissingCompanion();
      return;
    }
    // §8.7: a `@loading` frame is a placeholder, so there is no loaded record to page from. The
    // runtime no-ops this case too; the Vue layer must not even build the request, because a frame's
    // page info is a placeholder rather than a cursor.
    if (!enabled() || fragment.pending.value) {
      return;
    }
    // there is no page to send without the ` $fragments` entry the child read through
    const target = currentReference();
    if (target === null) {
      return;
    }
    const pageVariables = input();
    if (pageVariables === null) {
      return;
    }
    loading.value = true;
    try {
      await client.fetchFragmentPage(companion, target, direction, pageVariables);
    } finally {
      loading.value = false;
    }
  }

  /** The cursor page input of §6.8: `first`/`after` forward, `last`/`before` backward. */
  function cursorPageInput(direction: 'forward' | 'backward', info: PageInfo): Variables {
    return direction === 'forward'
      ? { first: pageSize, after: info.endCursor, last: null, before: null }
      : { last: pageSize, before: info.startCursor, first: null, after: null };
  }

  async function loadForwardPage(): Promise<void> {
    await requestPage('forward', loadingNext, () => {
      const info = pageInfo.value;
      return info !== null && info.hasNextPage ? cursorPageInput('forward', info) : null;
    });
  }

  async function loadBackwardPage(): Promise<void> {
    await requestPage('backward', loadingPrevious, () => {
      const info = pageInfo.value;
      return info !== null && info.hasPreviousPage ? cursorPageInput('backward', info) : null;
    });
  }

  async function loadOffsetPage(): Promise<void> {
    await requestPage('forward', loadingNext, () => ({
      // the offset the next window starts at is how many entries the list already holds
      // (`offsetHandlers`' `{ limit, offset }`; the compiler records `pageSize` from `limit`)
      offset: loadedEntries(),
      limit: pageSize,
    }));
  }

  const cursorSurface =
    method === 'offset'
      ? {}
      : {
          hasPreviousPage: computed(() => pageInfo.value?.hasPreviousPage ?? false),
          loadingPreviousPage: computed(() => loadingPrevious.value),
          loadPreviousPage: loadBackwardPage,
        };

  return {
    data: fragment.data,
    pending: fragment.pending,
    partial: fragment.partial,
    pageInfo,
    hasNextPage,
    loadingNextPage: computed(() => loadingNext.value),
    ...cursorSurface,
    loadNextPage: method === 'offset' ? loadOffsetPage : loadForwardPage,
  };
}
