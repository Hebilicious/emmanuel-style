/**
 * The mutation atom.
 *
 * A mutation is an action, not a value, so it is an `AtomResultFn` built with the runtime's `fn`:
 * writing it runs one mutation through the `mutate` effect of this package and its value is the
 * `AsyncResult` of that run. `AsyncResult.isWaiting` is the pending flag, so
 * `useAtom(mutation, { mode: 'promise' })` gives a promise and a pending state from one atom, and
 * `Atom.Interrupt` (a write) interrupts the run, which aborts the request.
 *
 * The success value is {@link FlammeMutationResult}: `confirmed` with the server's payload, or
 * `queued` with the local-first entry's id when the layer was given a queue and the write did not
 * reach the server. The queue's optimistic write is in the cache before the atom settles, so every
 * query and fragment atom that read the record has already re-rendered by then. A mutation the queue
 * parked fails the atom with `FlammeParkedError`.
 */
import type * as Atom from 'effect/unstable/reactivity/Atom';
import type * as Effect from 'effect/Effect';

import type { Artifact } from '@flamme/runtime';

import type { FlammeError } from '../errors.js';
import { mutate } from '../fns.js';
import type { FlammeMutationResult } from '../operations.js';
import type { Flamme } from '../service.js';
import { asVariables } from './keys.js';

/** What a mutation atom is written with: its variables and, optionally, an optimistic payload. */
export interface MutationInput<TInput> {
  /** The mutation's variables, marshalled by the runtime against the artifact's defaults. */
  readonly variables: TInput;
  /** Written into an optimistic layer before the request and rolled back on failure. */
  readonly optimistic?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * One mutation as an atom: an `AtomResultFn` whose write is {@link MutationInput} and whose value is
 * the `AsyncResult` of the run.
 */
export type MutationAtom<TData, TInput> = Atom.AtomResultFn<
  MutationInput<TInput>,
  FlammeMutationResult<TData>,
  FlammeError
>;

/**
 * Builds the mutation atom for one artifact.
 *
 * The atom is a function atom, so it carries no state between runs: two components writing the same
 * mutation atom share the one atom (and the pending state that comes with it) but each write is its
 * own run, and a second write while the first is in flight starts its own fiber.
 */
export function mutationAtom<TData, TInput>(
  runtime: Atom.AtomRuntime<Flamme>,
  artifact: Artifact<'mutation', TData, TInput>,
): MutationAtom<TData, TInput> {
  return runtime.fn(
    (
      input: MutationInput<TInput>,
    ): Effect.Effect<FlammeMutationResult<TData>, FlammeError, Flamme> =>
      mutate<TData>(artifact, {
        variables: asVariables(input.variables),
        ...(input.optimistic === undefined ? {} : { optimistic: input.optimistic }),
      }),
  );
}
