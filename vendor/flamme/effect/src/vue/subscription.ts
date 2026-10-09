/**
 * The subscription atom.
 *
 * `subscribe` is the `Stream` of a subscription's payloads, and the atom is that stream's current
 * value: `Stream` maps onto the atom API directly, so a component reads a subscription with the
 * same `useAtomValue` it uses for a query. The stream is scoped by the atom runtime, so unmounting
 * the component (or disposing the registry) interrupts it, which closes the transport.
 *
 * The value is `AsyncResult<Data, FlammeError | NoSuchElementError>`: `Success` per payload,
 * `waiting` while the next one is on the way, and `NoSuchElementError` when the transport completed
 * before ever delivering one.
 */
import type * as AsyncResult from 'effect/unstable/reactivity/AsyncResult';
import type * as Atom from 'effect/unstable/reactivity/Atom';
import type * as Cause from 'effect/Cause';

import type { Artifact, Variables } from '@flamme/runtime';

import type { FlammeError } from '../errors.js';
import { subscribe } from '../fns.js';
import type { Flamme } from '../service.js';

/** One subscription as an atom: the `AsyncResult` of its current payload. */
export type SubscriptionAtom<TData> = Atom.Atom<
  AsyncResult.AsyncResult<TData, FlammeError | Cause.NoSuchElementError>
>;

/** Builds the subscription atom for one artifact and one set of variables. */
export function subscriptionAtom<TData, TInput>(
  runtime: Atom.AtomRuntime<Flamme>,
  artifact: Artifact<'subscription', TData, TInput>,
  variables: Variables,
): SubscriptionAtom<TData> {
  return runtime.atom(subscribe<TData>(artifact, { variables }));
}
