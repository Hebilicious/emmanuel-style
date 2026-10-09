/**
 * The HTTP transport seam (§5.1, §12.1).
 *
 * The runtime never assumes a DOM and never imports `graphql`: a `TransportRequest` is a document
 * string plus variables, so this module is the only place that knows how to turn one into an HTTP
 * call. Every failure it maps to the §12.1 taxonomy: a non-2xx response is `HttpError` (FLM3002) and
 * a 2xx body that is not JSON, or an `errors`-only body with no `data` key, is `GraphQLHttpError`
 * (FLM3003). A transport rejection with no response (a socket failure) is left to the client, which
 * wraps it in `NetworkError` (FLM3001).
 *
 * Persisted queries (`TransportRequest.persistedQuery`, `research/answers-report.md` Q4) add one
 * shape: when the marker says `sendDocument: false` the body is
 * `{ variables, operationName, extensions: { persistedQuery: { version: 1, sha256Hash } } }` with no
 * `query` member, and an answer that asks for the document (`PersistedQueryNotFound`,
 * `PersistedQueryNotSupported`, or their `PERSISTED_QUERY_*` codes) is retried exactly once with the
 * full document. The retry happens here rather than in the plugin because an APQ miss is normally a
 * 2xx `errors`-only body, which this transport would otherwise classify as `GraphQLHttpError` before
 * any plugin could see it. Without the marker the body and every error path are byte-identical to
 * the pre-persisted behaviour.
 */
import type {
  GraphQLResponseError,
  TransportFn,
  TransportRequest,
  TransportResponse,
} from '../client.js';
import { GraphQLHttpError, HttpError } from '../errors.js';
import { INCREMENTAL_ACCEPT, readTransportResponse } from './incremental.js';

/** The `fetch` shape this transport needs; injected so tests never touch the network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface FetchTransportOptions {
  /** The GraphQL endpoint. */
  readonly url: string;
  /** Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike;
  readonly headers?: Readonly<Record<string, string>>;
  readonly credentials?: RequestCredentials;
  /** Extra body members merged in after `query`/`variables`/`operationName` (client name, …). */
  readonly body?: Readonly<Record<string, unknown>>;
  /** How much of a failing body the error carries. Default 2048 bytes (§12.1). */
  readonly bodyLimit?: number;
}

/** Builds the `TransportFn` a `Client` is configured with. */
export function createFetchTransport(options: FetchTransportOptions): TransportFn {
  const limit = options.bodyLimit ?? 2048;
  return async (request: TransportRequest, signal: AbortSignal): Promise<TransportResponse> => {
    const impl = options.fetch ?? defaultFetch();
    const first = await post(impl, options, request, signal);
    if (retryAllowed(request)) {
      const text = await safeText(first);
      if (isPersistedQueryMissText(text)) {
        // Exactly one retry: `post` is called with `document: true`, which no
        // longer satisfies `retryAllowed`, so a second miss is reported.
        const retry = await post(impl, options, request, signal, true);
        return classify(retry, limit, await safeText(retry));
      }
      return classify(first, limit, text);
    }
    return readTransportResponse(first, (response, text) => classify(response, limit, text));
  };
}

/** True when this request may be retried once with the full document. */
function retryAllowed(request: TransportRequest): boolean {
  const spec = request.persistedQuery;
  return spec !== undefined && !spec.sendDocument && spec.retryOnNotFound;
}

/** One HTTP round trip, with the APQ body the request asked for. */
function post(
  impl: FetchLike,
  options: FetchTransportOptions,
  request: TransportRequest,
  signal: AbortSignal,
  document = request.persistedQuery?.sendDocument === true,
): Promise<Response> {
  const spec = request.persistedQuery;
  const persisted =
    spec === undefined
      ? {}
      : { extensions: { persistedQuery: { version: 1, sha256Hash: spec.hash } } };
  const body =
    spec !== undefined && !document
      ? { variables: request.variables, operationName: request.operationName, ...persisted, ...options.body }
      : {
          query: request.query,
          variables: request.variables,
          operationName: request.operationName,
          ...persisted,
          ...options.body,
        };
  return impl(options.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // §7.13: a document with `@defer`/`@stream` asks for incremental delivery, and only such a
      // document does — every other request keeps the exact header set it had before.
      ...(request.artifact.deferred === undefined || request.artifact.deferred.length === 0
        ? {}
        : { accept: INCREMENTAL_ACCEPT }),
      ...options.headers,
    },
    body: JSON.stringify(body),
    signal,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
  });
}

/** Maps one response to the §12.1 taxonomy, reusing the text already read for the miss check. */
function classify(response: Response, limit: number, text: string): TransportResponse {
  if (!response.ok) {
    throw new HttpError(
      `The GraphQL endpoint answered ${response.status} ${response.statusText}.`,
      response.status,
      truncate(text, limit),
      { hint: 'check the endpoint URL and the server logs for this request' },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new GraphQLHttpError(
      'The GraphQL endpoint answered 2xx with a body that is not JSON.',
      response.status,
      truncate(text, limit),
      { cause, hint: 'check that the URL points at a GraphQL endpoint, not at an HTML page' },
    );
  }

  const record = asObject(parsed);
  if (record === null) {
    throw new GraphQLHttpError(
      'The GraphQL endpoint answered 2xx with a JSON body that is not an object.',
      response.status,
      truncate(text, limit),
      { hint: 'a GraphQL response is an object with a data and/or errors member' },
    );
  }

  if (!('data' in record) && record['errors'] !== undefined) {
    throw new GraphQLHttpError(
      'The GraphQL endpoint answered 2xx with errors but no data key.',
      response.status,
      truncate(text, limit),
      { hint: 'the endpoint must answer {"data":null,"errors":[…]} for an execution error' },
    );
  }

  const payload: {
    data?: Readonly<Record<string, unknown>> | null;
    errors?: readonly GraphQLResponseError[] | null;
    extensions?: Readonly<Record<string, unknown>> | null;
  } = {};
  if (record['data'] !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the wire body's data is the caller's payload
    payload.data = record['data'] as Readonly<Record<string, unknown>> | null;
  }
  if (record['errors'] !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the wire body's errors are the caller's GraphQL error list
    payload.errors = record['errors'] as readonly GraphQLResponseError[] | null;
  }
  if (record['extensions'] !== undefined) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the wire body's extensions are the caller's payload
    payload.extensions = record['extensions'] as Readonly<Record<string, unknown>>;
  }
  return payload;
}

/** `PersistedQueryNotFound`/`NotSupported`, by message or by the Apollo extension code. */
const PERSISTED_MISS_MESSAGE = /^PersistedQuery(NotFound|NotSupported)$/;
const PERSISTED_MISS_CODE = /^PERSISTED_QUERY_(NOT_FOUND|NOT_SUPPORTED)$/;

/**
 * True when an answer asks for the document instead of executing it. Accepts both
 * a parsed JSON body (the transport's own check) and a `TransportResponse` (the
 * fetch plugin's check for transports that implement APQ themselves).
 */
export function isPersistedQueryMiss(payload: unknown): boolean {
  const record = asObject(payload);
  const errors = record?.['errors'];
  if (!Array.isArray(errors)) {
    return false;
  }
  return errors.some((entry) => {
    const error = asObject(entry);
    if (error === null) {
      return false;
    }
    const message = error['message'];
    if (typeof message === 'string' && PERSISTED_MISS_MESSAGE.test(message)) {
      return true;
    }
    const extensions = asObject(error['extensions']);
    const code = extensions?.['code'];
    return typeof code === 'string' && PERSISTED_MISS_CODE.test(code);
  });
}

/** {@link isPersistedQueryMiss} over an unparsed body; a body that is not JSON is not a miss. */
function isPersistedQueryMissText(text: string): boolean {
  try {
    return isPersistedQueryMiss(JSON.parse(text));
  } catch {
    return false;
  }
}

/** `globalThis.fetch` behind a structural carrier (this package has no `node`/`dom` runtime types). */
function defaultFetch(): FetchLike {
  const carrier: FetchCarrier = globalThis;
  const impl = carrier.fetch;
  if (impl === undefined) {
    throw new Error(
      'No global fetch is available. Pass `fetch` to createFetchTransport (or a full TransportFn to createClient).',
    );
  }
  return impl;
}

/** The object view of a parsed body, or `null`; the one place this module narrows `unknown`. */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a parsed JSON object is a plain record
  return value as Record<string, unknown>;
}

/** Reads a body without letting a stream failure hide the status information. */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

interface FetchCarrier {
  readonly Object: unknown;
  readonly fetch?: FetchLike;
}
