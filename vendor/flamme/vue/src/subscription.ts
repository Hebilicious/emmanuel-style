/**
 * `useSubscription` (§8.6).
 *
 * The transport seam is `ClientConfig.subscribe` (the raw `SubscribeFn`), because `Client.subscribe`
 * returns only a closer and therefore has no payload channel for the handle's `data`. Each payload is
 * written into the cache through the subscription's own selection, so a mounted query or fragment that
 * reads the same records updates without the subscription knowing about it.
 */
import {
  getCurrentScope,
  onScopeDispose,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type ShallowRef,
} from 'vue';
import type {
  Artifact,
  ArtifactData,
  ArtifactInput,
  GraphQLResponseError,
  SubscribeFn,
  TransportRequest,
  Variables,
} from '@flamme/runtime';

import { useFlamme } from './client.js';
import { warnOnce } from './dev.js';
import { asVariables } from './keys.js';

/** The reactive subscription handle of §8.6. */
export interface SubscriptionHandle<TData> {
  /** The masked result of the last payload, or `null` before the first one. */
  readonly data: ShallowRef<TData | null>;
  /** The errors of the last payload or transport failure, or `null`. */
  readonly errors: ShallowRef<readonly GraphQLResponseError[] | null>;
  /** The transport accepted the subscription and has not closed it. */
  readonly connected: ShallowRef<boolean>;
  /** Closes the transport; idempotent. */
  close(): void;
}

/** The error list of a transport failure, as one response-shaped entry. */
function failure(error: unknown): readonly GraphQLResponseError[] {
  return [{ message: error instanceof Error ? error.message : String(error) }];
}

/**
 * Opens the subscription transport for `artifact` and streams its payloads into the cache. Without a
 * `ClientConfig.subscribe` the handle stays disconnected and warns once (FLM3004).
 */
export function useSubscription<A extends Artifact<'subscription'>>(
  artifact: A,
  variables?: MaybeRefOrGetter<ArtifactInput<A>>,
): SubscriptionHandle<ArtifactData<A>> {
  type TData = ArtifactData<A>;
  type TInput = ArtifactInput<A>;

  const client = useFlamme();
  // The generated document is `Artifact<'subscription', TData, TInput>`; the generic `A` only
  // guarantees the constraint, so it is re-typed once at this boundary (§3.1).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the phantom carriers are not reachable through the constraint, so the document is re-typed once here (the generated module performs the same narrow)
  const document = artifact as Artifact<'subscription', TData, TInput>;
  // seeded in two steps: `shallowRef` cannot pick an overload for a deferred conditional type
  const data: ShallowRef<TData | null> = shallowRef<TData | null>(null);
  const errors = shallowRef<readonly GraphQLResponseError[] | null>(null);
  const connected = shallowRef(false);
  let closeTransport: (() => void) | null = null;

  /** The masked read of what this subscription has written so far (§6.4). */
  function readBack(vars: Variables): void {
    const read = client.cache.read<TData>({
      selection: document.selection,
      parent: '_ROOT_',
      variables: asVariables(vars),
      mask: true,
    });
    data.value = read.data;
  }

  function open(): void {
    close();
    const subscribe: SubscribeFn | undefined = client.config.subscribe;
    if (subscribe === undefined) {
      warnOnce(
        `no-subscribe:${document.name}`,
        `${document.name}: the client has no subscribe transport, so useSubscription() stays disconnected (FLM3004).`,
      );
      return;
    }
    const vars = asVariables(toValue(variables));
    const request: TransportRequest = {
      query: document.raw,
      operationName: document.name,
      hash: document.hash,
      variables: vars,
      artifact: document,
    };
    // the transport can fail or complete *inside* `subscribe`, before it returns; the handle must
    // not report a connection the transport never accepted or already ended
    // (`review-slice34-adversarial.md` M13)
    let settled = false;
    closeTransport = subscribe(request, {
      next: (value) => {
        errors.value = value.errors ?? null;
        if (value.data !== undefined && value.data !== null) {
          client.cache.write({ selection: document.selection, data: value.data, variables: vars });
          readBack(vars);
        }
      },
      error: (error) => {
        settled = true;
        connected.value = false;
        errors.value = failure(error);
      },
      complete: () => {
        settled = true;
        connected.value = false;
      },
    });
    connected.value = !settled;
    readBack(vars);
  }

  function close(): void {
    closeTransport?.();
    closeTransport = null;
    connected.value = false;
  }

  const stopVariables = watch(() => (variables === undefined ? null : toValue(variables)), open, {
    flush: 'pre',
  });
  open();

  function dispose(): void {
    stopVariables();
    close();
  }

  // `getCurrentScope()` is `undefined` (not `null`) outside a scope, so the check is truthiness
  if (getCurrentScope()) {
    onScopeDispose(dispose);
  } else {
    client.retain({ dispose });
    warnOnce(
      'detached-use',
      'useSubscription() was called outside a component scope (a plain function, a test or a route loader); ' +
        'the subscription is retained by the client and disposed with it (D6, §8.10).',
    );
  }

  return { data, errors, connected, close };
}
