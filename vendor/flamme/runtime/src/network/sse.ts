/**
 * The subscription transport (§5.1, §8.6): GraphQL over Server-Sent Events.
 *
 * `createWebSocketTransport` is the `graphql-transport-ws` sibling; this is the transport for a
 * server that speaks the graphql-sse protocol, over `fetch` and `ReadableStream`. The protocol
 * defines two modes and both are implemented here:
 *
 * - **distinct connections** (default). One `POST` per operation with `accept: text/event-stream`,
 *   and that response body is the operation's own SSE stream.
 * - **single connection** (`mode: 'single'`). One long-lived `GET` stream carries the results of
 *   every operation, multiplexed by operation id. Each operation is a separate `GET` with the
 *   operation in the search parameters (`query`, `operationName`, `variables`) and its id in
 *   `extensions.operationId`, answered `202 Accepted`; unsubscribing is a `DELETE ?operationId=…`.
 *   Because a reservation is what binds an SSE connection to a client (the protocol's recommended
 *   step, and what the reference server requires), a `PUT` obtains the stream token first unless
 *   `reserve: false` says the endpoint needs none.
 *
 * What it owns, the same way the WebSocket transport owns it for a socket:
 *
 * - **SSE parsing.** `event: next` and `event: complete`, a bare `data:` line as the legacy form of
 *   `next`, `retry:` for the server's reconnection time, and `:` comments as keep-alives. One event
 *   may be split across any number of chunks.
 * - **reconnection.** The single connection reconnects on an unexpected close, with exponential
 *   backoff and full jitter, and re-sends every open operation under its original id. A subscription
 *   opened while the connection is down is queued, not failed.
 * - **aborting.** Unsubscribing aborts that operation's request; `dispose()` aborts the connection.
 * - **the §12.1 error taxonomy.** A stream that closes for good reports `NetworkError` (FLM3001) to
 *   every open subscription, which the subscription plugin wraps as `SubscriptionTransportError`
 *   (FLM3004). An **operation** error is data, not a dead connection: it reaches `next` as the
 *   result's `errors` and the stream stays up, exactly like a GraphQL error in an HTTP response.
 *
 * Nothing here imports `graphql` or a DOM type at runtime: `fetch`, `TextDecoder` and
 * `AbortController` are read from the platform, and the whole transport is testable with a fake
 * `fetch` and a synthetic `ReadableStream`.
 */
import type { SubscribeFn, TransportRequest } from '../client.js';
import { devWarn } from '../dev.js';
import { NetworkError } from '../errors.js';
import { asObject, asResponse, errorPayload } from './payload.js';
import type { FetchLike } from './transport.js';
import type { SubscriptionTransport } from './websocket.js';

/** The protocol mode: one connection per operation, or one connection for all of them. */
export type SseMode = 'distinct' | 'single';

export interface SseTransportOptions {
  /** The endpoint, or a function of the request (in single mode the first operation's request). */
  readonly url: string | ((request: TransportRequest) => string);
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  /** Default `'distinct'`: one POST per operation. `'single'` multiplexes over one GET stream. */
  readonly mode?: SseMode;
  /** Extra headers, or a function re-read on every connection (a rotating auth token). */
  readonly headers?: Readonly<Record<string, string>> | (() => Readonly<Record<string, string>>);
  readonly credentials?: RequestCredentials;
  /** Extra body members merged in after `query`/`variables`/`operationName` (distinct mode). */
  readonly body?: Readonly<Record<string, unknown>>;
  /**
   * Single mode: reserve the stream with a `PUT` before the `GET`, and carry the token it returns
   * (`x-graphql-event-stream-token`) on every later request. Default `true`; pass `false` for an
   * endpoint that binds the stream some other way.
   */
  readonly reserve?: boolean;
  /** Single mode: reconnect after the stream ends. Default `true`. */
  readonly reconnect?: boolean;
  /** Single mode: give up after this many consecutive failed attempts. Default `Infinity`. */
  readonly maxRetries?: number;
  /** First backoff delay, unless the server sent a `retry:`. Default 250 ms. */
  readonly initialDelayMs?: number;
  /** Backoff ceiling. Default 5000 ms. */
  readonly maxDelayMs?: number;
  /** Randomise the delay in `[delay / 2, delay]`. Default `true`; tests turn it off. */
  readonly jitter?: boolean;
  /** Observer for connection-level failures, including the ones the transport retries. */
  readonly onError?: (error: unknown) => void;
}

/** One open subscription, whichever mode opened it. */
interface OpenSubscription {
  readonly id: string;
  readonly request: TransportRequest;
  readonly handlers: Parameters<SubscribeFn>[1];
  /** The request currently carrying this subscription, aborted on unsubscribe or teardown. */
  controller: AbortController | null;
  /** Single mode: `true` once the operation request went out on the current connection. */
  sent: boolean;
}

/** One parsed SSE message: the `event:` name (absent in the legacy form) and its joined `data:`. */
interface SseMessage {
  readonly event: string | null;
  readonly data: string;
}

/** What one chunk of the stream yielded: whole messages, and a `retry:` the server may have sent. */
interface SseParseResult {
  readonly messages: readonly SseMessage[];
  readonly retry: number | null;
}

/** The `content-type` an SSE response must carry. */
const EVENT_STREAM = 'text/event-stream';

/** The header the protocol reserves for the stream token (`TOKEN_HEADER_KEY` in graphql-sse). */
const TOKEN_HEADER = 'x-graphql-event-stream-token';

/** Builds the `SubscribeFn` a `Client` is configured with, plus `dispose`. */
export function createSseTransport(options: SseTransportOptions): SubscriptionTransport {
  const mode = options.mode ?? 'distinct';
  const reserve = options.reserve ?? true;
  const reconnect = options.reconnect ?? true;
  const maxRetries = options.maxRetries ?? Number.POSITIVE_INFINITY;
  const initialDelay = options.initialDelayMs ?? 250;
  const maxDelay = options.maxDelayMs ?? 5000;
  const jitter = options.jitter ?? true;

  const subscriptions = new Map<string, OpenSubscription>();
  let disposed = false;
  let nextId = 1;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The reconnection time the server asked for with `retry:`, which replaces `initialDelayMs`. */
  let serverRetryMs: number | null = null;
  /** Distinct mode: how many operation streams are open, for `transport.connected`. */
  let openStreams = 0;
  /** Single mode: the live connection attempt, or `null` while none is running. */
  let connection: AbortController | null = null;
  /** Single mode: the url the current connection was opened with. */
  let connectionUrl: string | null = null;
  /** Single mode: the reservation token, sent on the stream, every operation and every DELETE. */
  let token: string | null = null;
  /** Single mode: `true` while the multiplexed stream is open. */
  let connected = false;

  /* --------------------------------------------------------------------------------- the plumbing */

  /** A connection-level failure: reported to the observer, and to the stores only when it is fatal. */
  function report(error: unknown): void {
    options.onError?.(error);
  }

  /**
   * Mirrors the internal counters onto the transport's own members. The transport is a function (the
   * `subscribe` seam) with three read-only members, so the values cannot be getters without an
   * assertion; they are kept in step here, at the few places the counters change.
   */
  function sync(): void {
    transport.disposed = disposed;
    transport.connected = mode === 'single' ? connected : openStreams > 0;
    transport.active = subscriptions.size;
  }

  /** `globalThis.fetch` behind a structural carrier (this package has no `node`/`dom` imports). */
  function resolveFetch(): FetchLike {
    if (options.fetch !== undefined) {
      return options.fetch;
    }
    const carrier: FetchCarrier = globalThis;
    const impl = carrier.fetch;
    if (impl === undefined) {
      throw new NetworkError('No global fetch is available. Pass `fetch` to createSseTransport.', {
        hint: 'Node 18+ ships fetch; an older runtime needs a fetch implementation',
      });
    }
    return impl;
  }

  function urlOf(request: TransportRequest): string {
    return typeof options.url === 'function' ? options.url(request) : options.url;
  }

  function headersOf(): Readonly<Record<string, string>> {
    const headers = options.headers;
    if (headers === undefined) {
      return {};
    }
    return typeof headers === 'function' ? headers() : headers;
  }

  function credentialsOf(): { readonly credentials?: RequestCredentials } {
    return options.credentials === undefined ? {} : { credentials: options.credentials };
  }

  function tokenHeader(): Readonly<Record<string, string>> {
    return token === null ? {} : { [TOKEN_HEADER]: token };
  }

  /** The `variables`/`operationName` members every request body and query string carries. */
  function bodyOf(request: TransportRequest): Record<string, unknown> {
    return {
      query: request.query,
      variables: request.variables,
      operationName: request.operationName,
      ...options.body,
    };
  }

  /** The exponential backoff: `initial * 2^retries`, capped, halved at most by jitter. */
  function backoffDelay(): number {
    const base = Math.min(maxDelay, (serverRetryMs ?? initialDelay) * 2 ** retries);
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

  /** Ends every open subscription with `error`: the connection is gone and is not coming back. */
  function failAll(error: unknown): void {
    const open = [...subscriptions.values()];
    subscriptions.clear();
    retries = 0;
    connected = false;
    for (const subscription of open) {
      subscription.controller?.abort();
      subscription.controller = null;
      subscription.handlers.error(error);
    }
    sync();
  }

  /** Removes a completed subscription and tells its caller the stream is over. */
  function complete(subscription: OpenSubscription): void {
    subscriptions.delete(subscription.id);
    sync();
    subscription.handlers.complete();
  }

  /** `true` when this subscription was closed by the caller, so the failure is not reported. */
  function isGone(subscription: OpenSubscription, controller: AbortController): boolean {
    return controller.signal.aborted || subscriptions.get(subscription.id) !== subscription;
  }

  /* ------------------------------------------------------------------- distinct connections mode */

  /** One `POST` per operation; the response body is that operation's own event stream. */
  function openDistinct(subscription: OpenSubscription): void {
    const controller = new AbortController();
    subscription.controller = controller;
    let counted = false;
    void (async () => {
      try {
        const impl = resolveFetch();
        const response = await impl(urlOf(subscription.request), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: EVENT_STREAM,
            ...headersOf(),
          },
          body: JSON.stringify(bodyOf(subscription.request)),
          signal: controller.signal,
          ...credentialsOf(),
        });
        if (!response.ok) {
          throw new NetworkError(
            `The subscription endpoint answered ${response.status} ${response.statusText}.`,
            { hint: 'check that the URL serves graphql-sse (accept: text/event-stream)' },
          );
        }
        const contentType = response.headers.get('content-type');
        if (contentType !== null && !contentType.toLowerCase().includes(EVENT_STREAM)) {
          throw new NetworkError(
            `The subscription endpoint answered "${contentType}" instead of text/event-stream.`,
            {
              hint: 'point the transport at the graphql-sse endpoint, and check for a proxy rewrite',
            },
          );
        }
        const body = response.body;
        if (body === null || body === undefined) {
          throw new NetworkError('The subscription endpoint answered with no body to stream.', {
            hint: 'check that the endpoint is a graphql-sse server',
          });
        }
        counted = true;
        openStreams += 1;
        sync();
        const completed = await readEvents(body, controller.signal, (message) =>
          handleDistinct(subscription, message),
        );
        if (!completed && !controller.signal.aborted) {
          throw new NetworkError('The subscription stream closed before the complete event.', {
            hint: 'check that the server keeps the event stream open for the whole subscription',
          });
        }
      } catch (error) {
        if (isGone(subscription, controller)) {
          return;
        }
        subscriptions.delete(subscription.id);
        sync();
        subscription.handlers.error(
          asNetworkError(error, 'The subscription stream failed mid-flight.'),
        );
      } finally {
        if (subscription.controller === controller) {
          subscription.controller = null;
        }
        if (counted) {
          openStreams -= 1;
          sync();
        }
      }
    })();
  }

  /** One message of a distinct connection. Returns `true` when the stream is over. */
  function handleDistinct(subscription: OpenSubscription, message: SseMessage): boolean {
    if (message.event === 'complete') {
      complete(subscription);
      return true;
    }
    if (message.event === 'error') {
      // the pre-v2 error event: an operation error on the result, then the stream is over
      subscription.handlers.next({ errors: errorPayload(parseData(message.data)) });
      complete(subscription);
      return true;
    }
    if (message.event !== null && message.event !== 'next') {
      // an event name this transport has no result for, like a frame type it does not know
      return false;
    }
    const payload = parseData(message.data);
    if (payload === undefined) {
      return false;
    }
    subscription.handlers.next(asResponse(payload));
    return false;
  }

  /* --------------------------------------------------------------------- single connection mode */

  /** Opens the multiplexed stream, unless one is already open or a reconnect is pending. */
  function connect(): void {
    if (disposed || connection !== null || retryTimer !== null || subscriptions.size === 0) {
      return;
    }
    const controller = new AbortController();
    connection = controller;
    void run(controller);
  }

  async function run(controller: AbortController): Promise<void> {
    let opened = false;
    let alive = false;
    try {
      const impl = resolveFetch();
      const first = subscriptions.values().next().value;
      if (first === undefined) {
        return;
      }
      const url = urlOf(first.request);
      connectionUrl = url;
      if (reserve) {
        const reservation = await impl(url, {
          method: 'PUT',
          headers: { accept: 'text/plain', ...headersOf() },
          signal: controller.signal,
          ...credentialsOf(),
        });
        if (reservation.status !== 201) {
          throw new NetworkError(
            `The graphql-sse endpoint answered ${reservation.status} ${reservation.statusText} to the connection reservation.`,
            { hint: 'a server without the reservation step needs `reserve: false`' },
          );
        }
        const value = (await reservation.text()).trim();
        token = value === '' ? null : value;
      } else {
        token = null;
      }

      const response = await impl(url, {
        method: 'GET',
        headers: { accept: EVENT_STREAM, ...tokenHeader(), ...headersOf() },
        signal: controller.signal,
        ...credentialsOf(),
      });
      if (!response.ok) {
        throw new NetworkError(
          `The graphql-sse endpoint answered ${response.status} ${response.statusText} to the event stream.`,
          { hint: 'check the endpoint URL and that the server speaks graphql-sse in single mode' },
        );
      }
      const body = response.body;
      if (body === null || body === undefined) {
        throw new NetworkError('The graphql-sse endpoint opened an event stream with no body.', {
          hint: 'check for a proxy that buffers or drops event-stream responses',
        });
      }
      opened = true;
      connected = true;
      sync();
      flush();
      await readEvents(
        body,
        controller.signal,
        (message) => {
          // any message proves the connection works, which is what resets the backoff
          alive = true;
          return handleSingle(message);
        },
        (milliseconds) => {
          alive = true;
          serverRetryMs = milliseconds;
        },
      );
      if (alive) {
        retries = 0;
      }
      throw new NetworkError('The subscription connection closed while operations were open.', {
        hint: 'the server ended the event stream; single connection mode reconnects and resubscribes',
      });
    } catch (error) {
      if (disposed || controller.signal.aborted) {
        return;
      }
      onConnectionLost(asNetworkError(error, 'The subscription connection failed.'));
    } finally {
      if (connection === controller) {
        connection = null;
      }
      if (opened) {
        connected = false;
        sync();
      }
    }
  }

  /** Handles the close of the multiplexed stream: reconnect and resubscribe, or report the failure. */
  function onConnectionLost(error: unknown): void {
    if (subscriptions.size === 0) {
      return;
    }
    for (const subscription of subscriptions.values()) {
      // the new connection has to re-open this operation: the old stream died with the connection
      subscription.sent = false;
      subscription.controller?.abort();
      subscription.controller = null;
    }
    if (!reconnect || retries >= maxRetries) {
      failAll(error);
      return;
    }
    report(error);
    scheduleReconnect();
  }

  /** Sends the operation request of every open subscription the current connection has not seen. */
  function flush(): void {
    if (mode !== 'single' || !connected || connection === null) {
      return;
    }
    const owner = connection;
    for (const subscription of subscriptions.values()) {
      if (subscription.sent) {
        continue;
      }
      subscription.sent = true;
      openOperation(subscription, owner);
    }
  }

  /** One operation request: the operation in the search parameters, its id in `extensions`. */
  function openOperation(subscription: OpenSubscription, owner: AbortController): void {
    const url = connectionUrl;
    if (url === null) {
      return;
    }
    const controller = new AbortController();
    subscription.controller = controller;
    const abort = (): void => {
      controller.abort();
    };
    owner.signal.addEventListener('abort', abort);
    if (owner.signal.aborted) {
      controller.abort();
    }
    void (async () => {
      try {
        const impl = resolveFetch();
        const response = await impl(withQuery(url, operationSearch(subscription)), {
          method: 'GET',
          headers: { accept: 'application/json', ...tokenHeader(), ...headersOf() },
          signal: controller.signal,
          ...credentialsOf(),
        });
        if (response.status !== 202) {
          throw new NetworkError(
            `The graphql-sse endpoint answered ${response.status} ${response.statusText} to the operation "${subscription.request.operationName}".`,
            { hint: 'single connection mode expects 202 Accepted for every operation request' },
          );
        }
      } catch (error) {
        if (controller.signal.aborted || subscriptions.get(subscription.id) !== subscription) {
          return;
        }
        subscriptions.delete(subscription.id);
        sync();
        subscription.handlers.error(error);
      } finally {
        owner.signal.removeEventListener('abort', abort);
        if (subscription.controller === controller) {
          subscription.controller = null;
        }
      }
    })();
  }

  /** The protocol's way to stop a streaming operation: `DELETE ?operationId=…`, best effort. */
  function stopOperation(subscription: OpenSubscription): void {
    const url = connectionUrl;
    if (url === null) {
      return;
    }
    void (async () => {
      try {
        const impl = resolveFetch();
        await impl(withQuery(url, `operationId=${encodeURIComponent(subscription.id)}`), {
          method: 'DELETE',
          headers: { ...tokenHeader(), ...headersOf() },
          ...credentialsOf(),
        });
      } catch (error) {
        report(error);
      }
    })();
  }

  /** One message of the multiplexed stream, routed by its operation id. Always keeps the stream. */
  function handleSingle(message: SseMessage): boolean {
    const payload = message.data === '' ? undefined : parseData(message.data);
    const record = asObject(payload);
    const id = record?.['id'];
    if (record === null || typeof id !== 'string') {
      // no operation id: nothing this transport can route the message to
      return false;
    }
    const subscription = subscriptions.get(id);
    if (subscription === undefined) {
      return false;
    }
    if (message.event === 'complete') {
      complete(subscription);
      return false;
    }
    if (message.event === 'error') {
      subscription.handlers.next({ errors: errorPayload(record['payload']) });
      complete(subscription);
      return false;
    }
    if (message.event !== null && message.event !== 'next') {
      return false;
    }
    subscription.handlers.next(asResponse(record['payload']));
    return false;
  }

  /* ------------------------------------------------------------------------------- the seam */

  const transport = (
    request: TransportRequest,
    handlers: Parameters<SubscribeFn>[1],
  ): (() => void) => {
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
    const subscription: OpenSubscription = { id, request, handlers, controller: null, sent: false };
    subscriptions.set(id, subscription);
    sync();
    if (mode === 'single') {
      connect();
    } else {
      openDistinct(subscription);
    }
    return () => {
      const current = subscriptions.get(id);
      if (current === undefined) {
        return;
      }
      subscriptions.delete(id);
      current.controller?.abort();
      current.controller = null;
      if (mode === 'single') {
        if (current.sent) {
          stopOperation(current);
        }
        if (subscriptions.size === 0) {
          retries = 0;
        }
      }
      sync();
    };
  };

  /** Aborts the connection and completes every open subscription; a later `subscribe` reports. */
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
      subscription.controller?.abort();
      subscription.controller = null;
    }
    connection?.abort();
    connection = null;
    connected = false;
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

/**
 * Reads an event stream, one message at a time. Returns `true` when `onMessage` ended the stream
 * (a `complete`, or a legacy `error`), `false` when the body ended or the signal aborted.
 */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onMessage: (message: SseMessage) => boolean,
  onRetry?: (milliseconds: number) => void,
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();
  let completed = false;
  try {
    while (!completed) {
      if (signal.aborted) {
        break;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read one chunk at a time
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      const parsed = parse(decoder.decode(value, { stream: true }));
      if (parsed.retry !== null) {
        onRetry?.(parsed.retry);
      }
      for (const message of parsed.messages) {
        if (onMessage(message)) {
          completed = true;
          break;
        }
      }
    }
  } finally {
    if (completed) {
      // the server said the stream is over: hand the connection back instead of leaving it open
      try {
        await reader.cancel();
      } catch {
        // the stream is already gone; the connection it belonged to is what matters
      }
    }
    reader.releaseLock();
  }
  return completed;
}

/** The search parameters of one operation request: the operation, and its id in `extensions`. */
function operationSearch(subscription: OpenSubscription): string {
  const params = new URLSearchParams();
  params.set('query', subscription.request.query);
  if (subscription.request.operationName !== '') {
    params.set('operationName', subscription.request.operationName);
  }
  params.set('variables', JSON.stringify(subscription.request.variables ?? {}));
  params.set('extensions', JSON.stringify({ operationId: subscription.id }));
  return params.toString();
}

/** `JSON.parse` with the DEV warning an unparseable message gets; a message this transport ignores. */
function parseData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    devWarn('The subscription stream sent a message that is not JSON; the message was ignored.');
    return undefined;
  }
}

/** Appends a query string to a url that may already carry one. */
function withQuery(url: string, search: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${search}`;
}

/** A connection-level failure as the taxonomy's `NetworkError`, whatever the platform threw. */
function asNetworkError(error: unknown, message: string): NetworkError {
  return error instanceof NetworkError ? error : new NetworkError(message, { cause: error });
}

/** The line ending an event stream may use: LF, CRLF and a lone CR are all valid. */
const LINE_BREAK = /\r\n|\n|\r/;

/**
 * The incremental `text/event-stream` parser: feed it chunks, get whole messages.
 *
 * `event:` names the type, `data:` accumulates (joined by newlines), a `:` line is a comment and a
 * keep-alive, and `retry:` is the server's reconnection time in milliseconds. An empty line
 * dispatches. A message is emitted when it named an event or carried data, which is what lets a
 * `complete` event with no `data:` field still complete the subscription, and what makes a bare
 * `data:` line the legacy spelling of `next`.
 */
function createSseParser(): (chunk: string) => SseParseResult {
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];
  return (chunk) => {
    buffer += chunk;
    const messages: SseMessage[] = [];
    let retry: number | null = null;
    for (;;) {
      const match = LINE_BREAK.exec(buffer);
      if (match === null) {
        break;
      }
      // a trailing CR may be the first half of a CRLF: hold it back until the next chunk
      if (match[0] === '\r' && match.index === buffer.length - 1) {
        break;
      }
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === '') {
        if (event !== null || data.length > 0) {
          messages.push({ event, data: data.join('\n') });
        }
        event = null;
        data = [];
        continue;
      }
      if (line.startsWith(':')) {
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const raw = colon === -1 ? '' : line.slice(colon + 1);
      const value = raw.startsWith(' ') ? raw.slice(1) : raw;
      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        data.push(value);
      } else if (field === 'retry' && /^\d+$/.test(value)) {
        retry = Number(value);
      }
      // `id` and anything else is accepted and not used by this transport
    }
    return { messages, retry };
  };
}

/** A structural view of the global object (this package has no `node`/`dom` runtime types). */
interface FetchCarrier {
  readonly Object: unknown;
  readonly fetch?: FetchLike;
}
