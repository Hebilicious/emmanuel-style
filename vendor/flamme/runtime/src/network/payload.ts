/**
 * The payload shapes both subscription transports read (§5.1, §8.6).
 *
 * `graphql-transport-ws` frames and `graphql-sse` messages carry the same thing — an
 * `ExecutionResult` — so the two transports share one reading of it rather than each narrowing
 * `unknown` in its own way. Nothing here knows about a socket or a stream: it turns a parsed payload
 * into the `TransportResponse` `next` takes, and an `error` payload into the result's `errors`.
 */
import type { GraphQLResponseError, TransportResponse } from '../client.js';

/** A frame's or message's payload as the `TransportResponse` `next` takes. */
export function asResponse(payload: unknown): TransportResponse {
  const record = asObject(payload);
  if (record === null) {
    return {};
  }
  const data = asObject(record['data']);
  const errors = Array.isArray(record['errors']) ? errorPayload(record['errors']) : null;
  const extensions = asObject(record['extensions']);
  return {
    ...(data === null ? {} : { data }),
    ...(errors === null ? {} : { errors }),
    ...(extensions === null ? {} : { extensions }),
    hasNext: record['hasNext'] === true,
  };
}

/** An `error` frame's payload (a GraphQL error array) as the result's `errors`. */
export function errorPayload(payload: unknown): readonly GraphQLResponseError[] {
  const entries = Array.isArray(payload) ? payload : [payload];
  const errors: GraphQLResponseError[] = [];
  for (const entry of entries) {
    const record = asObject(entry);
    const message = record?.['message'];
    const extensions = asObject(record?.['extensions']);
    errors.push({
      message: typeof message === 'string' ? message : 'The subscription failed.',
      ...(extensions === null ? {} : { extensions }),
    });
  }
  return errors;
}

/** The object view of a parsed payload, or `null`; the one place these transports narrow `unknown`. */
export function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a parsed JSON object is a plain record
  return value as Record<string, unknown>;
}
