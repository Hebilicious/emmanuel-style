/**
 * The public runtime error taxonomy (§12.1, §12.2).
 *
 * Every class extends `FlammeRuntimeError` so a caller can catch the family, sets its own `name`,
 * and carries its `FLMxxxx` code as a literal field so tests and callers assert the taxonomy rather
 * than the message text. `hint` is the one line naming the concrete fix and is supplied by the
 * throwing site; it is absent (not `undefined`) when there is none, so `'hint' in error` is a
 * meaningful check.
 *
 * Constructors take the message first, then the code-specific fields, then the shared options: the
 * message is the log line, the fields are what a program switches on.
 */
import type { RecordId } from './artifact.js';

export interface FlammeRuntimeErrorOptions {
  /** One line naming the concrete fix. */
  readonly hint?: string;
  /** The underlying failure, kept for logs; never serialized into a `QueryResult`. */
  readonly cause?: unknown;
}

export abstract class FlammeRuntimeError extends Error {
  /** The `FLMxxxx` code of this error family, as a literal type on every concrete class. */
  abstract readonly code: `FLM${number}`;

  /** One line naming the concrete fix; absent when the throwing site has none. */
  declare readonly hint?: string;

  protected constructor(message: string, options: FlammeRuntimeErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    if (options.hint !== undefined) {
      this.hint = options.hint;
    }
  }
}

/** FLM3001: the transport rejected before a response existed. */
export class NetworkError extends FlammeRuntimeError {
  readonly code = 'FLM3001';
  declare readonly cause?: unknown;

  constructor(message: string, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

/** FLM3002: a non-2xx response. `status` is the HTTP status, `body` the raw text. */
export class HttpError extends FlammeRuntimeError {
  readonly code = 'FLM3002';
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** FLM3003: 2xx with a body that is not JSON, or an `errors`-only body with no `data` key. */
export class GraphQLHttpError extends FlammeRuntimeError {
  readonly code = 'FLM3003';
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'GraphQLHttpError';
    this.status = status;
    this.body = body;
  }
}

/** FLM3004: the subscription transport errored or closed before `complete`. */
export class SubscriptionTransportError extends FlammeRuntimeError {
  readonly code = 'FLM3004';

  constructor(message: string, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'SubscriptionTransportError';
  }
}

/** FLM4001: a payload had no value for any configured key field (dev only; see §6.3 for the fallback). */
export class MissingRecordError extends FlammeRuntimeError {
  readonly code = 'FLM4001';
  readonly type: string;

  constructor(message: string, type: string, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'MissingRecordError';
    this.type = type;
  }
}

/** FLM4002: `useFragment` was handed a reference whose ` $fragments` lacks the fragment. */
export class MissingFragmentSpreadError extends FlammeRuntimeError {
  readonly code = 'FLM4002';
  readonly fragment: string;
  readonly parent: RecordId;

  constructor(message: string, fragment: string, parent: RecordId, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'MissingFragmentSpreadError';
    this.fragment = fragment;
    this.parent = parent;
  }
}

/** FLM4003: a `@list` operation named a list that was never registered. */
export class UnknownListError extends FlammeRuntimeError {
  readonly code = 'FLM4003';
  readonly list: string;

  constructor(message: string, list: string, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'UnknownListError';
    this.list = list;
  }
}

/** FLM4004: a page request on an artifact with no `refetch` spec. */
export class UnknownPaginationError extends FlammeRuntimeError {
  readonly code = 'FLM4004';
  readonly artifact: string;

  constructor(message: string, artifact: string, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'UnknownPaginationError';
    this.artifact = artifact;
  }
}

/** FLM4005: `hydrate` saw an unknown snapshot version or a different compiler major. */
export class SnapshotVersionMismatchError extends FlammeRuntimeError {
  readonly code = 'FLM4005';
  readonly found: number;
  readonly expected = 1;

  constructor(message: string, found: number, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'SnapshotVersionMismatchError';
    this.found = found;
  }
}

/** FLM4006: any store call after `client.dispose()`. Throws in every build. */
export class ClientDisposedError extends FlammeRuntimeError {
  readonly code = 'FLM4006';

  constructor(message: string, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'ClientDisposedError';
  }
}

/** FLM4007: a read of a field that masking excluded. Throws in DEV; returns `undefined` in production. */
export class MaskedFieldReadError extends FlammeRuntimeError {
  readonly code = 'FLM4007';
  readonly field: string;
  readonly recordId: RecordId;

  constructor(message: string, field: string, recordId: RecordId, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'MaskedFieldReadError';
    this.field = field;
    this.recordId = recordId;
  }
}

/** FLM4008: a write into a frozen snapshot. Throws in every build. */
export class FrozenSnapshotError extends FlammeRuntimeError {
  readonly code = 'FLM4008';
  readonly recordId: RecordId;

  constructor(message: string, recordId: RecordId, options: FlammeRuntimeErrorOptions = {}) {
    super(message, options);
    this.name = 'FrozenSnapshotError';
    this.recordId = recordId;
  }
}
