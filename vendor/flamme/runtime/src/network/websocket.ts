/**
 * The subscription transport (§5.1, §8.6): GraphQL over WebSocket.
 *
 * `ClientConfig.subscribe` is the seam; this is a real transport behind it, so an app does not have
 * to write one. It speaks `graphql-transport-ws` (`connection_init` → `connection_ack`, `subscribe`
 * → `next` / `error` / `complete`, `ping` → `pong`) over the platform `WebSocket`, and it owns the
 * two behaviours every hand-written transport gets wrong:
 *
 * - **reconnection.** An unexpected close schedules a reconnect with exponential backoff (full
 *   jitter by default, reset by a completed handshake) and re-sends every open subscription's
 *   `subscribe` frame on the new socket. A payload that arrives after a reconnect reaches the same
 *   store, so the app never sees the gap.
 * - **the §12.1 error taxonomy.** A socket that closes for good (reconnection off or exhausted)
 *   reports `NetworkError` (FLM3001) to every open subscription, which the subscription plugin wraps
 *   as `SubscriptionTransportError` (FLM3004). An **operation** error (`error` frame) is data, not a
 *   dead socket: it is delivered through `next` as the result's `errors`, and the connection stays
 *   up, exactly like a GraphQL error in an HTTP response.
 *
 * Nothing here imports `ws` or `graphql`: the socket is a structural interface and the default
 * factory reads `globalThis.WebSocket`, so the package still has no runtime dependency and no DOM
 * import. A test (or a Node app) passes `createSocket`.
 */
import type { SubscribeFn, TransportRequest } from '../client.js';
import { NetworkError } from '../errors.js';
import { devWarn } from '../dev.js';
import { asObject, asResponse, errorPayload } from './payload.js';

/** The subset of the platform `WebSocket` event this transport reads. */
export interface WebSocketEventLike {
  /** `message` events carry the frame; a binary frame is ignored. */
  readonly data?: unknown;
  readonly code?: number;
  readonly reason?: string;
  /** `true` for a clean close; the transport reconnects either way. */
  readonly wasClean?: boolean;
  readonly error?: unknown;
}

/** The subset of the platform `WebSocket` this transport uses. `WebSocket` satisfies it. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void;
}

/** Opens one socket. Injected so a test (or a Node app) never touches a real network. */
export type WebSocketFactory = (url: string, protocols: readonly string[]) => WebSocketLike;

export interface WebSocketTransportOptions {
  /** The endpoint, or a function of the request (one socket per document, if you want that). */
  readonly url: string | ((request: TransportRequest) => string);
  /** Defaults to `globalThis.WebSocket`. */
  readonly createSocket?: WebSocketFactory;
  /** Subprotocols. Default `['graphql-transport-ws']`. */
  readonly protocols?: readonly string[];
  /** The `connection_init` payload (an auth token, usually), or a function producing it. */
  readonly connectionInit?:
    | Readonly<Record<string, unknown>>
    | (() => Readonly<Record<string, unknown>>);
  /** Reconnect after an unexpected close. Default `true`. */
  readonly reconnect?: boolean;
  /** Give up after this many consecutive failed attempts. Default `Infinity`. */
  readonly maxRetries?: number;
  /** First backoff delay. Default 250 ms. */
  readonly initialDelayMs?: number;
  /** Backoff ceiling. Default 5000 ms. */
  readonly maxDelayMs?: number;
  /** Randomise the delay in `[delay / 2, delay]`. Default `true`; tests turn it off. */
  readonly jitter?: boolean;
  /** Observer for socket-level failures, including the ones this transport retries. */
  readonly onError?: (error: unknown) => void;
}

/** A `ClientConfig.subscribe` with the transport's own lifecycle attached. */
export interface SubscriptionTransport extends SubscribeFn {
  /**
   * Closes the socket and completes every open subscription. The transport belongs to the app, not
   * to a `Client` (one socket can serve several), so nothing calls this for you: call it when the
   * app tears down. A later `subscribe` reports `NetworkError`.
   */
  dispose(): void;
  /** `true` once {@link SubscriptionTransport.dispose} ran. */
  readonly disposed: boolean;
  /** `true` while a handshake has completed on the current socket. */
  readonly connected: boolean;
  /** The subscriptions this transport is holding, retrying or streaming. */
  readonly active: number;
}

/** The GraphQL-over-WebSocket frame types this transport reads. */
interface ServerFrame {
  readonly id?: string;
  readonly type?: string;
  readonly payload?: unknown;
}

interface OpenSubscription {
  readonly id: string;
  readonly request: TransportRequest;
  readonly handlers: Parameters<SubscribeFn>[1];
  /** `true` once the `subscribe` frame went out on the current socket. */
  sent: boolean;
}

/** `globalThis.WebSocket` behind a structural carrier (this package has no DOM runtime import). */
interface WebSocketCarrier {
  readonly WebSocket?: new (url: string, protocols?: string[]) => WebSocketLike;
}

/** Builds the `SubscribeFn` a `Client` is configured with, plus `dispose`. */
export function createWebSocketTransport(
  options: WebSocketTransportOptions,
): SubscriptionTransport {
  const factory = options.createSocket ?? defaultSocketFactory;
  const protocols = options.protocols ?? ['graphql-transport-ws'];
  const reconnect = options.reconnect ?? true;
  const maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY;
  const initialDelay = options.initialDelayMs ?? 250;
  const maxDelay = options.maxDelayMs ?? 5000;
  const jitter = options.jitter ?? true;

  const subscriptions = new Map<string, OpenSubscription>();
  let socket: WebSocketLike | null = null;
  let acknowledged = false;
  let disposed = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let nextId = 1;

  /** A socket-level failure: reported to the observer, and to the stores only when it is fatal. */
  function report(error: unknown): void {
    options.onError?.(error);
  }

  function send(frame: Readonly<Record<string, unknown>>): void {
    if (socket === null || socket.readyState !== 1) {
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  /** Sends the `subscribe` frame of every open subscription that has not been sent yet. */
  function flush(): void {
    if (!acknowledged || socket === null) {
      return;
    }
    for (const subscription of subscriptions.values()) {
      if (subscription.sent) {
        continue;
      }
      subscription.sent = true;
      send({
        id: subscription.id,
        type: 'subscribe',
        payload: {
          query: subscription.request.query,
          variables: subscription.request.variables,
          operationName: subscription.request.operationName,
        },
      });
    }
  }

  /** Ends every open subscription with `error`: the socket is gone and is not coming back. */
  function failAll(error: unknown): void {
    const open = [...subscriptions.values()];
    subscriptions.clear();
    for (const subscription of open) {
      subscription.handlers.error(error);
    }
    sync();
  }

  function closeSocket(code: number, reason: string): void {
    const current = socket;
    socket = null;
    acknowledged = false;
    if (current !== null && current.readyState < 2) {
      current.close(code, reason);
    }
  }

  /** The exponential backoff: `initial * 2^retries`, capped, halved at most by jitter. */
  function backoffDelay(): number {
    const base = Math.min(maxDelay, initialDelay * 2 ** retries);
    return jitter ? base / 2 + Math.random() * (base / 2) : base;
  }

  function scheduleReconnect(): void {
    if (retryTimer !== null) {
      return;
    }
    const delay = backoffDelay();
    retries += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  /** Handles the close of the current socket: reconnect, or report the failure as final. */
  function onClose(): void {
    socket = null;
    acknowledged = false;
    sync();
    for (const subscription of subscriptions.values()) {
      // the new socket has to re-open this subscription: the old one died with the socket
      subscription.sent = false;
    }
    if (disposed || subscriptions.size === 0 || !reconnect || retries >= maxRetries) {
      if (subscriptions.size > 0 && !disposed) {
        failAll(
          new NetworkError(
            'The subscription socket closed before the stream completed.',
            { hint: 'check that the GraphQL server supports graphql-transport-ws at this URL' },
          ),
        );
      }
      return;
    }
    scheduleReconnect();
  }

  function handleFrame(frame: ServerFrame): void {
    const type = frame.type;
    if (type === 'connection_ack') {
      acknowledged = true;
      retries = 0;
      sync();
      flush();
      return;
    }
    if (type === 'ping') {
      send({ type: 'pong' });
      return;
    }
    if (type === 'connection_error') {
      report(
        new NetworkError('The subscription server rejected the connection handshake.', {
          hint: 'check the connection_init payload (an expired token, usually)',
        }),
      );
      closeSocket(1008, 'connection_error');
      return;
    }
    if (frame.id === undefined) {
      // `ka`/`pong`/anything else without an operation id carries no result
      return;
    }
    const subscription = subscriptions.get(frame.id);
    if (subscription === undefined) {
      return;
    }
    if (type === 'next') {
      subscription.handlers.next(asResponse(frame.payload));
      return;
    }
    if (type === 'error') {
      // an operation error is data: the result carries it and the socket stays up
      subscription.handlers.next({ errors: errorPayload(frame.payload) });
      return;
    }
    if (type === 'complete') {
      subscriptions.delete(frame.id);
      sync();
      subscription.handlers.complete();
    }
  }

  function connect(): void {
    if (disposed || socket !== null || subscriptions.size === 0) {
      return;
    }
    const first = subscriptions.values().next().value;
    if (first === undefined) {
      return;
    }
    let created: WebSocketLike;
    try {
      // both the url function and the factory are the caller's code: a throw is reported like any
      // other failure to open, never left to escape the `subscribe` seam
      const url = typeof options.url === 'function' ? options.url(first.request) : options.url;
      created = factory(url, protocols);
    } catch (error) {
      report(error);
      failAll(error);
      return;
    }
    socket = created;
    acknowledged = false;
    created.addEventListener('open', () => {
      const init = options.connectionInit;
      const payload = typeof init === 'function' ? init() : init;
      send({ type: 'connection_init', ...(payload === undefined ? {} : { payload }) });
    });
    created.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        // a keep-alive or a server that speaks something else: nothing here can act on it
        devWarn('The subscription socket sent a frame that is not JSON; the frame was ignored.');
        return;
      }
      const frame = asObject(parsed);
      if (frame === null) {
        return;
      }
      handleFrame(frame);
    });
    created.addEventListener('error', (event) => {
      report(event.error ?? new NetworkError('The subscription socket errored.'));
    });
    created.addEventListener('close', () => {
      onClose();
    });
  }

  const transport = (request: TransportRequest, handlers: Parameters<SubscribeFn>[1]): (() => void) => {
    if (disposed) {
      handlers.error(
        new NetworkError('The subscription transport was disposed, so no subscription can open.', {
          hint: 'create a new transport, or subscribe before dispose()',
        }),
      );
      return () => undefined;
    }
    const id = String(nextId);
    nextId += 1;
    subscriptions.set(id, { id, request, handlers, sent: false });
    sync();
    connect();
    flush();
    return () => {
      const subscription = subscriptions.get(id);
      if (subscription === undefined) {
        return;
      }
      subscriptions.delete(id);
      sync();
      if (subscription.sent) {
        send({ id, type: 'complete' });
      }
    };
  };

  /**
   * Mirrors the internal counters onto the transport's own members. The transport is a function (the
   * `subscribe` seam) with three read-only members, so the values cannot be getters without an
   * assertion; they are kept in step here, at the few places the counters change.
   */
  function sync(): void {
    transport.disposed = disposed;
    transport.connected = acknowledged;
    transport.active = subscriptions.size;
  }

  /** Closes the socket and completes every open subscription; a later `subscribe` reports. */
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const open = [...subscriptions.values()];
    subscriptions.clear();
    for (const subscription of open) {
      if (subscription.sent) {
        send({ id: subscription.id, type: 'complete' });
      }
    }
    closeSocket(1000, 'the subscription transport was disposed');
    for (const subscription of open) {
      subscription.handlers.complete();
    }
    sync();
  };

  transport.dispose = dispose;
  transport.disposed = false;
  transport.connected = false;
  transport.active = 0;
  return transport;
}

/** `globalThis.WebSocket` behind a structural carrier (this package never imports the DOM). */
function defaultSocketFactory(url: string, protocols: readonly string[]): WebSocketLike {
  const carrier: WebSocketCarrier = globalThis;
  const ctor = carrier.WebSocket;
  if (ctor === undefined) {
    throw new NetworkError(
      'No global WebSocket is available. Pass `createSocket` to createWebSocketTransport.',
      { hint: 'Node needs an implementation such as `ws`, and a browser needs a secure context' },
    );
  }
  return new ctor(url, [...protocols]);
}
