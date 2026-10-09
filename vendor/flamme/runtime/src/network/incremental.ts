/**
 * Incremental delivery over HTTP (§7.13).
 *
 * The request advertises the 20220824 `@defer`/`@stream` specification with
 * `accept: multipart/mixed; deferSpec=20220824, application/json`; the response is `multipart/mixed`
 * with one JSON payload per part. This module owns both directions:
 *
 * * {@link INCREMENTAL_ACCEPT} is the header value, spelled exactly as the specification and Apollo
 *   Client's `Defer20220824Handler` spell it, with the normal `application/json` fallback appended so
 *   a server that ignores the parameter still answers a single-part response.
 * * {@link readTransportResponse} turns a `Response` into the runtime's `TransportResponse`,
 *   streaming the parts when the body is a stream and falling back to one `text()` read when it is
 *   not (jsdom, a polyfilled fetch). The first part is the initial payload and every later part is
 *   normalized into {@link IncrementalPatch} entries.
 *
 * Both incremental payload shapes are understood, because both are on the wire in 2026:
 *
 * * **20220824** (what this client asks for): subsequent parts are
 *   `{ "incremental": [{ "data" | "items", "path", "label"?, "errors"? }], "hasNext": bool }`.
 * * **2024 working draft** (graphql-js 17 and the current spec text): the first part carries
 *   `pending: [{ id, path, label }]` and later parts carry `incremental: [{ id, data | items,
 *   subPath? }]` and `completed: [{ id, errors? }]`. The `id` is resolved back to the `pending`
 *   entry, and `subPath` is appended to its `path`.
 *
 * A part that is neither (a plain single-part JSON body) is passed through untouched.
 */
import type { GraphQLResponseError, TransportResponse } from '../client.js';
import { GraphQLHttpError } from '../errors.js';
import type { IncrementalPatch } from '../incremental.js';

/** The `accept` value that asks for 20220824 incremental delivery. */
export const INCREMENTAL_ACCEPT = 'multipart/mixed; deferSpec=20220824, application/json';

/** The `content-type` prefix of an incremental response. */
const MULTIPART = 'multipart/mixed';

/** `true` when this response is a multipart incremental response rather than one JSON body. */
export function isMultipart(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').toLowerCase().startsWith(MULTIPART);
}

/** The boundary of a `multipart/mixed` content type, or `-` (the spec's example) when absent. */
export function boundaryOf(contentType: string): string {
  const match = /boundary\s*=\s*"?([^";]+)"?/i.exec(contentType);
  return match?.[1]?.trim() ?? '-';
}

/** One part of a multipart body, normalized: the initial payload plus the patches it carries. */
export interface IncrementalPart {
  readonly data?: unknown;
  readonly errors?: readonly GraphQLResponseError[];
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly hasNext: boolean;
  readonly patches: readonly IncrementalPatch[];
}

/**
 * Reads a `Response` into a `TransportResponse`. A multipart body yields the first part as the
 * response and the rest as a lazily consumed `patches` iterable, so a deferred patch reaches the
 * store before the next part is even parsed; anything else goes through `classifyJson`.
 */
export async function readTransportResponse(
  response: Response,
  classifyJson: (response: Response, text: string) => TransportResponse,
): Promise<TransportResponse> {
  if (!response.ok || !isMultipart(response)) {
    return classifyJson(response, await safeText(response));
  }
  return readMultipartResponse(response);
}

/**
 * Reads a `Response` that is already known to be `multipart/mixed` (§7.13). A hand-written transport
 * uses this after its own status handling, so it does not have to re-implement the framing.
 */
export async function readMultipartResponse(response: Response): Promise<TransportResponse> {
  const parts = parseMultipart(bodyChunks(response), boundaryOf(response.headers.get('content-type') ?? ''));
  const first = await parts.next();
  if (first.done === true) {
    throw new GraphQLHttpError(
      'The GraphQL endpoint answered multipart/mixed with no parts.',
      response.status,
      '',
      { hint: 'the response must contain at least the initial payload' },
    );
  }
  const pending = new Map<string, PendingTarget>();
  const initial = normalizePart(first.value, pending);
  const rest = collectPatches(parts, pending);
  const patches =
    initial.patches.length === 0 ? rest : chainPatches(initial.patches, rest);
  const data = asObject(initial.data);
  const result: TransportResponse = {
    hasNext: initial.hasNext,
    patches,
    ...(data === undefined ? {} : { data }),
    ...(initial.errors === undefined ? {} : { errors: initial.errors }),
    ...(initial.extensions === undefined ? {} : { extensions: initial.extensions }),
  };
  return result;
}

/** The first part's own patches, then the stream's. */
async function* chainPatches(
  first: readonly IncrementalPatch[],
  rest: AsyncGenerator<IncrementalPatch>,
): AsyncGenerator<IncrementalPatch> {
  for (const patch of first) {
    yield patch;
  }
  yield* rest;
}

/** The trailing parts as normalized patches, consumed once by the client's cache stage. */
async function* collectPatches(
  parts: AsyncGenerator,
  pending: Map<string, PendingTarget>,
): AsyncGenerator<IncrementalPatch> {
  for await (const part of parts) {
    const normalized = normalizePart(part, pending);
    for (const patch of normalized.patches) {
      yield patch;
    }
    if (!normalized.hasNext) {
      return;
    }
  }
}

interface PendingTarget {
  readonly path: readonly (string | number)[];
  readonly label?: string;
}

/** The `pending` bookkeeping of one part: `id` → the target a later `incremental` entry belongs to. */
function registerPending(part: Record<string, unknown>, pending: Map<string, PendingTarget>): void {
  for (const entry of asArray(part['pending'])) {
    if (!isObject(entry)) {
      continue;
    }
    const id = entry['id'];
    if (typeof id !== 'string' && typeof id !== 'number') {
      continue;
    }
    pending.set(String(id), {
      path: asArray(entry['path']).filter(isPathPart),
      ...(typeof entry['label'] === 'string' ? { label: entry['label'] } : {}),
    });
  }
}

/** One parsed JSON part → the initial payload fields and the patches it carries. */
export function normalizePart(value: unknown, pending: Map<string, PendingTarget>): IncrementalPart {
  if (!isObject(value)) {
    throw new GraphQLHttpError(
      'A multipart/mixed part is not a JSON object.',
      200,
      truncate(JSON.stringify(value) ?? '', 2048),
      { hint: 'every part of a multipart GraphQL response is a JSON object' },
    );
  }
  registerPending(value, pending);
  const hasNext = value['hasNext'] === true;
  const patches: IncrementalPatch[] = [];
  const errors = asErrors(value['errors']);
  const extensions = asObject(value['extensions']);

  for (const entry of asArray(value['incremental'])) {
    if (!isObject(entry)) {
      continue;
    }
    const target = targetOf(entry, pending);
    const entryErrors = asErrors(entry['errors']);
    if (Array.isArray(entry['items'])) {
      patches.push({
        path: target.path,
        items: entry['items'],
        hasNext,
        ...(target.label === undefined ? {} : { label: target.label }),
        ...(entryErrors === undefined ? {} : { errors: entryErrors }),
      });
      continue;
    }
    // `data: null` is not merged (Apollo's rule): a null data member on a defer patch means "nothing
    // to merge here", and writing null would destroy the object the patch names.
    const data = entry['data'];
    patches.push({
      path: target.path,
      hasNext,
      ...(isObject(data) ? { data } : {}),
      ...(target.label === undefined ? {} : { label: target.label }),
      ...(entryErrors === undefined ? {} : { errors: entryErrors }),
    });
  }

  // The older single-payload form: a part with a top-level `path` and `data`.
  if (patches.length === 0 && value['path'] !== undefined) {
    patches.push({
      path: asArray(value['path']).filter(isPathPart),
      hasNext,
      ...(isObject(value['data']) ? { data: value['data'] } : {}),
      ...(errors === undefined ? {} : { errors }),
    });
  }

  // `completed: [{ id, errors? }]` (2024 shape) carries no data; its errors belong to the result.
  const completedErrors = asArray(value['completed']).flatMap((entry) =>
    isObject(entry) ? (asErrors(entry['errors']) ?? []) : [],
  );
  const allErrors =
    completedErrors.length === 0 ? errors : [...(errors ?? []), ...completedErrors];

  return {
    hasNext,
    patches,
    ...(value['data'] === undefined ? {} : { data: value['data'] }),
    ...(allErrors === undefined ? {} : { errors: allErrors }),
    ...(extensions === undefined ? {} : { extensions }),
  };
}

/** The target an `incremental` entry belongs to: its `pending` entry id, else its own `path`. */
function targetOf(entry: Record<string, unknown>, pending: Map<string, PendingTarget>): PendingTarget {
  const id = entry['id'];
  const known =
    typeof id === 'string' || typeof id === 'number' ? pending.get(String(id)) : undefined;
  const subPath = asArray(entry['subPath']).filter(isPathPart);
  const ownPath = asArray(entry['path']).filter(isPathPart);
  const base = known?.path ?? ownPath;
  const label = known?.label ?? (typeof entry['label'] === 'string' ? entry['label'] : undefined);
  return {
    path: [...base, ...subPath],
    ...(label === undefined ? {} : { label }),
  };
}

/** The byte stream of a response body, or a single chunk when the transport has no stream. */
async function* bodyChunks(response: Response): AsyncGenerator<Uint8Array> {
  const body: ReadableStream<Uint8Array> | null | undefined = response.body;
  if (body === null || body === undefined) {
    yield new TextEncoder().encode(await safeText(response));
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read one chunk at a time
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value !== undefined) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Splits a `multipart/mixed` byte stream into its JSON payloads. Parts are separated by
 * `CRLF --boundary CRLF`; the body of a part is everything between its header block and the next
 * delimiter. The terminating `--boundary--` ends the stream.
 *
 * A part is emitted as soon as **its own bytes are complete**, not when the delimiter that follows
 * it arrives. That matters for incremental delivery: a `@defer` response whose first patch is
 * parked (or slow) still hands its initial payload to the caller straight away, which is what lets
 * a route loader settle and the cache write land while the rest of the stream is still on the wire.
 * Three signals say "complete", in this order:
 *
 * * a `content-length` header: the body is exactly that many bytes, so the part is emitted the
 *   moment they have arrived and never before, even when a shorter prefix already parses;
 * * the buffered body (after the header block) parses as JSON: the delimiter that ends the part has
 *   simply not been written yet, which is the case a chunk boundary leaves behind;
 * * the next delimiter, which is what a well-formed stream always sends: the part is everything
 *   before it, exactly as before.
 */
export async function* parseMultipart(
  chunks: AsyncIterable<Uint8Array>,
  boundary: string,
): AsyncGenerator {
  const delimiter = `--${boundary}`;
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  let finished = false;

  const emit = (head: string): string | undefined => {
    const { body } = splitHeaders(head);
    const text = body.trim();
    return text.length === 0 ? undefined : text;
  };

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      if (!started) {
        // before the first delimiter (or after a part that was already emitted): the delimiter opens
        // the next part, and everything in front of it is preamble
        const index = buffer.indexOf(delimiter);
        if (index === -1) {
          break;
        }
        buffer = buffer.slice(index + delimiter.length);
        if (buffer.startsWith('--')) {
          finished = true;
          break;
        }
        started = true;
        buffer = buffer.replace(/^[\r\n]+/, '');
        continue;
      }
      const index = buffer.indexOf(delimiter);
      if (index === -1) {
        // no delimiter yet: the part is still emitted when its own body is complete
        const complete = completePart(buffer);
        if (complete === undefined) {
          break;
        }
        buffer = complete.rest;
        started = false;
        if (complete.text.length > 0) {
          yield parseJsonPart(complete.text);
        }
        continue;
      }
      const text = emit(buffer.slice(0, index));
      buffer = buffer.slice(index + delimiter.length);
      started = false;
      if (text !== undefined) {
        yield parseJsonPart(text);
      }
      if (buffer.startsWith('--')) {
        finished = true;
        break;
      }
      started = true;
      buffer = buffer.replace(/^[\r\n]+/, '');
    }
    if (finished) {
      return;
    }
  }
  // A body that never sent its terminating boundary still has one last part to deliver.
  if (started) {
    const text = emit(buffer);
    if (text !== undefined) {
      yield parseJsonPart(text);
    }
  }
}

/**
 * The part a buffered, delimiter-less body already holds, or `undefined` while it is incomplete. The
 * returned `rest` is what follows the part's own bytes in the buffer (only a `content-length` part
 * can leave any: without one, the body is the whole buffer).
 */
function completePart(
  buffer: string,
): { readonly text: string; readonly rest: string } | undefined {
  const { headers, body } = splitHeaders(buffer);
  const bodyStart = buffer.length - body.length;
  const declared = contentLengthOf(headers);
  if (declared !== undefined) {
    const encoded = new TextEncoder().encode(body);
    if (encoded.length < declared) {
      return undefined;
    }
    const text = new TextDecoder().decode(encoded.subarray(0, declared));
    return { text: text.trim(), rest: buffer.slice(bodyStart + text.length) };
  }
  const text = body.trim();
  // cheap guard before the parse: a part is a JSON object (or array); anything else waits for the
  // delimiter and is reported by the same "not valid JSON" diagnostic the delimiter path uses
  if (!(text.startsWith('{') && text.endsWith('}')) && !(text.startsWith('[') && text.endsWith(']'))) {
    return undefined;
  }
  return parsesAsJson(text) ? { text, rest: buffer.slice(bodyStart + body.length) } : undefined;
}

/** The `content-length` a part's header block declares, when it declares a usable one. */
function contentLengthOf(headers: string): number | undefined {
  const match = /^content-length\s*:\s*(\d+)\s*$/im.exec(headers);
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** `true` when the text is one complete JSON value; the parse result itself is not needed here. */
function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Splits one part into its header block and body. A part without headers is all body: the split is
 * only taken when the text before the blank line actually looks like a header list, so a body that
 * happens to start with a blank line (`\r\n\r\n{...}`) is not mistaken for headers.
 */
function splitHeaders(head: string): { readonly headers: string; readonly body: string } {
  for (const separator of ['\r\n\r\n', '\n\n']) {
    const index = head.indexOf(separator);
    if (index === -1) {
      continue;
    }
    const headers = head.slice(0, index);
    if (/^[\w-]+\s*:/m.test(headers)) {
      return { headers, body: head.slice(index + separator.length) };
    }
  }
  return { headers: '', body: head };
}

/** One part's text into JSON, with the same 2xx taxonomy the single-part path uses. */
function parseJsonPart(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new GraphQLHttpError(
      'A multipart/mixed part is not valid JSON.',
      200,
      truncate(text, 2048),
      { cause, hint: 'every part of a multipart GraphQL response is a JSON object' },
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isObject(value) ? value : undefined;
}

function asErrors(value: unknown): readonly GraphQLResponseError[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const errors: GraphQLResponseError[] = [];
  for (const entry of value) {
    const error = toResponseError(entry);
    if (error !== undefined) {
      errors.push(error);
    }
  }
  return errors.length === 0 ? undefined : errors;
}

/**
 * One wire error as the runtime's `GraphQLResponseError`: `message` is required, everything else is
 * copied only when it has the documented shape. Building the object rather than asserting a type is
 * also what keeps a malformed member out of the result.
 */
function toResponseError(value: unknown): GraphQLResponseError | undefined {
  if (!isObject(value) || typeof value['message'] !== 'string') {
    return undefined;
  }
  const path = Array.isArray(value['path']) ? value['path'].filter(isPathPart) : undefined;
  const locations = Array.isArray(value['locations'])
    ? value['locations'].flatMap(toLocation)
    : undefined;
  const extensions = asObject(value['extensions']);
  return {
    message: value['message'],
    ...(path === undefined ? {} : { path }),
    ...(locations === undefined ? {} : { locations }),
    ...(extensions === undefined ? {} : { extensions }),
  };
}

/** One `{ line, column }` of an error's location list, or nothing when the members are not numbers. */
function toLocation(value: unknown): readonly { readonly line: number; readonly column: number }[] {
  if (!isObject(value) || typeof value['line'] !== 'number' || typeof value['column'] !== 'number') {
    return [];
  }
  return [{ line: value['line'], column: value['column'] }];
}

function isPathPart(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number';
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
