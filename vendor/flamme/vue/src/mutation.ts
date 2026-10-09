/**
 * `useMutation` (§8.5), local-first when the app has a local store.
 *
 * The handle owns the four things a mutation view needs: `mutate`, `fetching` (aliased as `pending`,
 * the spec's name), `errors` and `data`, plus `outcome`, which says whether the call was confirmed
 * or queued. The optimistic layer, the list operations and the rollback are the client's job
 * (`MutationOptions.optimistic`), so this composable only tracks the request's lifetime and turns the
 * response's errors into either a rejection or a `null` result.
 *
 * With `createFlamme({ local })` the same call is **local-first**: it is written into an optimistic
 * layer first, queued durably, and delivered when the queue reaches it. The handle's shape does not
 * change, and the component code does not either; only the meaning of the wait does. The one
 * difference a caller can see is that a parked write (a GraphQL rejection, which stays queued for
 * `retry()`/`discard()`) resolves instead of rejecting unless the caller asks for the rejection with
 * `throwOnError: true`.
 */
import { computed, inject, shallowRef, type ComputedRef, type ShallowRef } from 'vue';
import type { Artifact, ArtifactData, ArtifactInput, GraphQLResponseError } from '@flamme/runtime';
import type { LocalError, LocalFirst, LocalMutationOutcome } from '@flamme/local';
import { LOCAL_KEY } from '@flamme/local/vue';

import { useFlamme } from './client.js';
import { asVariables, isRecord } from './keys.js';

/** The recursive optional form of a mutation result, used for `optimistic` (§8.5). */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends object
    ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** One `mutate` call's options. */
export interface MutateOptions<TData, TInput> {
  /** The mutation's variables. */
  readonly variables: TInput;
  /** Written as an optimistic layer before the request; rolled back on error. */
  readonly optimistic?: DeepPartial<TData>;
  /**
   * Reject instead of resolving when the response carries errors.
   *
   * Default `true`, except with a local store installed: there a parked write is a **state**, not a
   * failed call (the entry is queued and `retry()`/`discard()` decide what happens to it), so the
   * default is `false` and `errors`/`outcome` report it. `true` opts back into the rejection.
   */
  readonly throwOnError?: boolean;
}

/**
 * What the last call through a handle did.
 *
 * `confirmed` and `queued` are the local-first distinction a caller needs: the server took the
 * write during this call, or it is durable in the queue and will be delivered later. `parked` is a
 * GraphQL rejection that is still queued, with the failure the server reported.
 */
export type MutationOutcome<TData> =
  /** The server answered during this call; `data` is its payload. */
  | { readonly status: 'confirmed'; readonly data: TData | null }
  /** The write is queued durably and visible locally; `id` is its entry (see `discard`). */
  | { readonly status: 'queued'; readonly id: string }
  /** The server rejected it; the entry stays queued until `retry()` or `discard()`. */
  | { readonly status: 'parked'; readonly id: string; readonly error: LocalError };

/** The reactive mutation handle of §8.5. */
export interface MutationHandle<TData, TInput> {
  /** Sends the mutation and resolves with its data, or `null` when it carried only errors. */
  mutate(options: MutateOptions<TData, TInput>): Promise<TData | null>;
  /** A request is in flight (the spec's name for {@link MutationHandle.fetching}). */
  readonly pending: ComputedRef<boolean>;
  /** A request is in flight. */
  readonly fetching: ComputedRef<boolean>;
  /** The GraphQL errors of the last response, or `null`. */
  readonly errors: ShallowRef<readonly GraphQLResponseError[] | null>;
  /** The last response's data, or `null`. */
  readonly data: ShallowRef<TData | null>;
  /**
   * What the last call through this handle did, or `null` before any call.
   *
   * Always `null` without a local store: `queued` and `parked` are the queue's states, and there is
   * no queue. A caller that reads it must therefore treat `null` as "no local store".
   */
  readonly outcome: ShallowRef<MutationOutcome<TData> | null>;
}

/** `true` when a value looks like a GraphQL response error. */
function isResponseError(value: unknown): value is GraphQLResponseError {
  return isRecord(value) && typeof value['message'] === 'string';
}

/** The GraphQL errors a rejection carries, when it carries any (the client may attach its result). */
function errorsOf(error: unknown): readonly GraphQLResponseError[] | null {
  if (!isRecord(error)) {
    return null;
  }
  const errors = error['errors'];
  if (!Array.isArray(errors)) {
    return null;
  }
  const found = errors.filter(isResponseError);
  return found.length === 0 ? null : found;
}

/** The optimistic payload as the `MutationOptions.optimistic` record the client expects. */
function toOptimistic<TData>(
  value: DeepPartial<TData> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  return value !== undefined && isRecord(value) ? value : undefined;
}

/** Runs `artifact` and tracks the request's lifetime, result and errors. */
export function useMutation<A extends Artifact<'mutation'>>(
  artifact: A,
): MutationHandle<ArtifactData<A>, ArtifactInput<A>> {
  type TData = ArtifactData<A>;
  type TInput = ArtifactInput<A>;

  const client = useFlamme();
  // the mode is a property of the app, not of the call: `createFlamme({ local })` provided a store,
  // or the app has none and every call is the plain §8.5 one. The `null` default keeps a local-free
  // app from logging Vue's "injection not found" warning on every handle.
  const local = inject(LOCAL_KEY, null);
  // The generated document is `Artifact<'mutation', TData, TInput>`; the generic `A` only guarantees
  // the constraint, so it is re-typed once at this boundary (§3.1).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the phantom carriers are not reachable through the constraint, so the document is re-typed once here (the generated module performs the same narrow)
  const document = artifact as Artifact<'mutation', TData, TInput>;
  const errors = shallowRef<readonly GraphQLResponseError[] | null>(null);
  // seeded in two steps: `shallowRef` cannot pick an overload for a deferred conditional type
  const data: ShallowRef<TData | null> = shallowRef<TData | null>(null);
  const outcome = shallowRef<MutationOutcome<TData> | null>(null);
  const inFlight = shallowRef(0);

  /** The local-first call: the store queues the write and reports what became of it. */
  async function mutateLocally(
    store: LocalFirst,
    options: MutateOptions<TData, TInput>,
  ): Promise<TData | null> {
    const optimistic = toOptimistic<TData>(options.optimistic);
    const result: LocalMutationOutcome<TData> = await store.mutate<TData>(document, {
      variables: asVariables(options.variables),
      ...(optimistic === undefined ? {} : { optimistic }),
    });
    outcome.value = result;
    if (result.status === 'confirmed') {
      errors.value = null;
      data.value = result.data;
      return result.data;
    }
    if (result.status === 'queued') {
      // nothing failed: the write is durable and the queue will deliver it, so the handle has no
      // error to report and no response data to show
      errors.value = null;
      data.value = null;
      return null;
    }
    errors.value = result.error.errors ?? [{ message: result.error.message }];
    data.value = null;
    if (options.throwOnError === true) {
      throw new Error(result.error.message);
    }
    return null;
  }

  /** The plain §8.5 call, against the client's own cache and transport. */
  async function mutateRemotely(options: MutateOptions<TData, TInput>): Promise<TData | null> {
    const optimistic = toOptimistic<TData>(options.optimistic);
    try {
      const result = await client.mutate<TData>(document, {
        variables: asVariables(options.variables),
        ...(optimistic === undefined ? {} : { optimistic }),
      });
      errors.value = result.errors;
      data.value = result.data;
      if (
        options.throwOnError !== false &&
        result.data === null &&
        result.errors !== null &&
        result.errors.length > 0
      ) {
        throw new Error(result.errors[0]?.message ?? 'the mutation failed');
      }
      return result.data;
    } catch (error) {
      const reported = errorsOf(error);
      if (reported !== null) {
        errors.value = reported;
      }
      if (options.throwOnError === false) {
        return null;
      }
      throw error;
    }
  }

  async function mutate(options: MutateOptions<TData, TInput>): Promise<TData | null> {
    inFlight.value += 1;
    try {
      return local === null ? await mutateRemotely(options) : await mutateLocally(local, options);
    } finally {
      inFlight.value -= 1;
    }
  }

  const fetching = computed(() => inFlight.value > 0);
  return { mutate, pending: fetching, fetching, errors, data, outcome };
}
