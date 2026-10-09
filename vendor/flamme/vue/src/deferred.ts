/**
 * The deferred boundary (§7.13): `useDeferred` and the `<Deferred>` component.
 *
 * A `@defer`ed selection is part of the document but not of the first payload, so a component that
 * renders it needs three answers: is it still coming, has it arrived, and did the stream end without
 * it. Those are the boundary's `pending`, `ready` and `failed`, read from the result's per-label
 * state rather than from the data — a masked deferred fragment's fields are not in the parent's data
 * at all, which is exactly why the label state exists.
 *
 * The boundary is deliberately thin: it renders `ready` as the default slot and everything else as
 * the `fallback` slot, and it reads only `result.deferred[label]` and `result.hasNext`, so a patch
 * that fills in a *different* label does not re-render it. A fragment child under the boundary keeps
 * its own `useFragment` subscription, so the data itself re-renders the child, not the route.
 */
import {
  computed,
  defineComponent,
  isRef,
  type ComputedRef,
  type MaybeRefOrGetter,
  type PropType,
} from 'vue';
import type { DeferredState, DeferredStatus, QueryResult } from '@flamme/runtime';

/** What the boundary reads: a result, or a handle's `deferred`/`hasNext` refs. */
export interface DeferredSource {
  /** Per-label delivery state. A ref or getter keeps the boundary reactive. */
  readonly deferred: MaybeRefOrGetter<DeferredState>;
  /** `true` while the transport still has patches to deliver. */
  readonly hasNext: MaybeRefOrGetter<boolean>;
}

/** A source, or a getter returning a whole result (the shape a `useQuery` handle's result has). */
export type DeferredInput = DeferredSource | (() => QueryResult | DeferredSource);

/** The boundary's state for one label. */
export interface DeferredBoundary {
  /** `pending` until the label's patch is merged; `ready` afterwards (or when none was requested). */
  readonly status: ComputedRef<DeferredStatus>;
  /** The patch has not arrived yet. */
  readonly pending: ComputedRef<boolean>;
  /** The patch arrived, or the server answered the whole document at once. */
  readonly ready: ComputedRef<boolean>;
  /**
   * The stream ended (`hasNext: false`) while the label was still pending, so it will never arrive:
   * an error tore the stream down, or the server dropped the selection. The boundary stops waiting.
   */
  readonly failed: ComputedRef<boolean>;
}

/**
 * Unwraps one member of the source: a plain value, a `ref`/`computed`, or a getter. All three are
 * read inside the boundary's `computed`, so whichever the caller passed stays reactive.
 */
function unwrapDeferred(value: DeferredState | MaybeRefOrGetter<DeferredState>): DeferredState {
  if (isRef(value)) {
    return value.value;
  }
  return typeof value === 'function' ? value() : value;
}

function unwrapFlag(value: MaybeRefOrGetter<boolean>): boolean {
  if (isRef(value)) {
    return value.value;
  }
  return typeof value === 'function' ? value() : value;
}

/**
 * The `deferred`/`hasNext` pair behind one input, unwrapped either way it was given. A missing
 * source (a nullable handle, a component whose prop has not been supplied yet) is treated as "no
 * incremental target": the boundary renders its content rather than shimmering on no information.
 */
function readState(input: DeferredInput | null | undefined): {
  readonly deferred: DeferredState;
  readonly hasNext: boolean;
} {
  if (input === null || input === undefined) {
    return { deferred: {}, hasNext: false };
  }
  if (typeof input === 'function') {
    const value = input();
    if (value === null || value === undefined) {
      return { deferred: {}, hasNext: false };
    }
    // A whole result and a handle both carry `deferred`/`hasNext`; unwrapping either is the same
    // call, which is why the boundary needs no discriminant (a handle has `data` too).
    return { deferred: unwrapDeferred(value.deferred), hasNext: unwrapFlag(value.hasNext) };
  }
  return { deferred: unwrapDeferred(input.deferred), hasNext: unwrapFlag(input.hasNext) };
}

/**
 * The delivery state of one `@defer`/`@stream` label.
 *
 * ```ts
 * const boundary = useDeferred(() => query, 'evolutionChain')
 * ```
 *
 * `query` may be a `useQuery`/`useFragment` handle and `result` a whole `QueryResult`; both expose
 * `deferred` and `hasNext`, which is all the boundary reads.
 */
export function useDeferred(input: DeferredInput | null | undefined, label: string): DeferredBoundary {
  const state = computed(() => readState(input));
  const status = computed<DeferredStatus>(() => state.value.deferred[label] ?? 'ready');
  const pending = computed(() => status.value === 'pending');
  return {
    status,
    pending,
    ready: computed(() => status.value === 'ready'),
    failed: computed(() => pending.value && !state.value.hasNext),
  };
}

/**
 * `<Deferred :result="query" label="evolutionChain">` renders its default slot once the label's patch
 * has been merged and its `#fallback` slot until then; the fallback receives `{ pending, failed }` so
 * a broken stream can render an error hint rather than shimmer forever.
 *
 * ```vue
 * <Deferred :result="query" label="evolutionChain">
 *   <EvolutionChain :species="species" />
 *   <template #fallback="{ failed }"><ChainSkeleton :failed="failed" /></template>
 * </Deferred>
 * ```
 */
export const Deferred = defineComponent({
  name: 'FlammeDeferred',
  props: {
    /** A query/fragment handle or a result: anything with `deferred` and `hasNext`. */
    result: { type: Object as PropType<DeferredSource>, required: true },
    /** The `label:` the document gave the `@defer`/`@stream` target. */
    label: { type: String, required: true },
  },
  setup(props, { slots }) {
    const boundary = useDeferred(() => props.result, props.label);
    return () =>
      boundary.ready.value
        ? slots['default']?.()
        : slots['fallback']?.({ pending: boundary.pending.value, failed: boundary.failed.value });
  },
});
