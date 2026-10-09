/**
 * The key maker (§6.3).
 *
 * Four pure functions and the one deterministic hash the degraded `computeID` path needs. Nothing
 * here reads module-level state, calls a clock or allocates an identity: given the same inputs the
 * same string comes out, which is what lets a compiler-emitted `keyRaw` collide with a page key
 * built at runtime.
 */
import type { GraphQLValue, SubscriptionSelection, Variables } from '../artifact.js';
import type { CacheConfig } from '../cache.js';
import { MissingRecordError } from '../errors.js';

/** The fallback key field set when neither `config.keys[type]` nor `config.defaultKeys` is set. */
const DEFAULT_KEY_FIELDS: readonly string[] = ['id'];

/** The separator `computeID` joins key values with (§6.3). */
const KEY_SEPARATOR = '__';

/** Variable-name characters, matching GraphQL's `Name` production. */
const VARIABLE_CHARS = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789');

/**
 * Builds a field key from the field name and its arguments, with argument names sorted, so
 * `species(id: $id)` and a hand-written `species(id: 1)` collide correctly (§6.3).
 */
export function computeKey(field: string, args?: Readonly<Record<string, GraphQLValue>>): string {
  if (args === undefined) {
    return field;
  }
  const names = Object.keys(args).toSorted();
  if (names.length === 0) {
    return field;
  }
  return `${field}(${names.map((name) => `${name}: ${literal(args[name])}`).join(', ')})`;
}

/**
 * Resolves `$var` occurrences in a `keyRaw` while tracking string state, so a `$` inside a quoted
 * string is left alone and an escaped quote does not end the string (§6.3).
 */
export function evaluateKey(keyRaw: string, variables: Variables): string {
  // fast path: no variable interpolation needed
  if (!keyRaw.includes('$')) {
    return keyRaw;
  }

  let evaluated = '';
  let index = 0;
  let inString = false;
  let variableName = '';

  while (index < keyRaw.length) {
    const char = keyRaw[index] ?? '';

    // we are in the middle of a variable name
    if (variableName !== '') {
      if (VARIABLE_CHARS.has(char)) {
        variableName += char;
        index += 1;
        continue;
      }
      // the variable name ended: substitute it and re-handle this character
      evaluated += jsonValue(variables[variableName.slice(1)]);
      variableName = '';
      continue;
    }

    if (char === '$' && !inString) {
      variableName = '$';
      index += 1;
      continue;
    }

    // an escape sequence inside a string consumes the next character verbatim, so `\"` does not
    // toggle the string state
    if (inString && char === '\\') {
      evaluated += char + (keyRaw[index + 1] ?? '');
      index += 2;
      continue;
    }

    if (char === '"') {
      inString = !inString;
    }

    evaluated += char;
    index += 1;
  }

  // a variable that ends the key is still substituted
  if (variableName !== '') {
    evaluated += jsonValue(variables[variableName.slice(1)]);
  }

  return evaluated;
}

/**
 * Joins the key field values with `__`, or takes the connection-field form
 * `<type>:<parentId>:<keyRaw>` when the payload is `{ parent, keyRaw }` (§6.3).
 *
 * When a type is configured with keys and the payload provides none of them, the id degrades to
 * `<__typename>-<hash of payload>` in production and raises `MissingRecordError` (FLM4001) in dev.
 * A key-less payload under the default keys is the embedded case: the writer never calls this for
 * it, and a caller that does gets the same stable payload id.
 */
export function computeID(config: CacheConfig, type: string, data: unknown): string {
  const record = asRecord(data);

  // third form: a connection field whose element type is embedded
  if (record !== null && typeof record['parent'] === 'string' && typeof record['keyRaw'] === 'string') {
    return `${type}:${record['parent']}:${record['keyRaw']}`;
  }

  const fields = keyFieldsForType(config, type);
  const values: string[] = [];
  let complete = fields.length > 0;
  for (const field of fields) {
    const value = record === null ? undefined : record[field];
    if (value === undefined || value === null) {
      complete = false;
      break;
    }
    values.push(scalarText(value));
  }

  if (complete) {
    return values.join(KEY_SEPARATOR);
  }

  // a type with no configured key set is embedded; this is only reachable through a direct call
  if (config.keys?.[type] === undefined || isProduction()) {
    return payloadID(type, record);
  }

  throw new MissingRecordError(
    `Type "${type}" is configured with key fields [${fields.join(', ')}] but the payload provides no value for every one of them.`,
    type,
    {
      hint: `select ${fields.join(', ')} on every "${type}" composite, or fix types: { ${type}: { keys: [...] } } in flamme.config.ts`,
    },
  );
}

/** `config.keys[type]` → `config.defaultKeys` → `['id']` (§6.3). */
export function keyFieldsForType(config: CacheConfig, type: string): readonly string[] {
  const configured = config.keys?.[type];
  if (configured !== undefined) {
    return configured;
  }
  return config.defaultKeys ?? DEFAULT_KEY_FIELDS;
}

/**
 * The record id a composite payload produces, or `null` when the type is embedded (§4.5.1).
 *
 * Decided per payload, because the runtime has no schema: a type with no configured key set whose
 * payload has no key value is Houdini's `isEmbedded()` case and is stored inline in its parent.
 */
export function recordIdFor(config: CacheConfig, type: string, data: unknown): string | null {
  const fields = keyFieldsForType(config, type);
  if (fields.length === 0) {
    return null;
  }
  const record = asRecord(data);
  if (
    record !== null &&
    fields.every((field) => record[field] !== undefined && record[field] !== null)
  ) {
    return `${type}:${computeID(config, type, data)}`;
  }
  // an explicitly configured key set is a contract: a payload that cannot satisfy it degrades in
  // production and throws in dev, it never becomes an embedded record by accident
  if (config.keys?.[type] !== undefined) {
    return `${type}:${computeID(config, type, data)}`;
  }
  return null;
}

/** The field name a `keyRaw` starts with: its arguments and any `::paginated` suffix removed. */
export function fieldNameOf(keyRaw: string): string {
  const open = keyRaw.indexOf('(');
  const base = open < 0 ? keyRaw : keyRaw.slice(0, open);
  const marker = base.indexOf('::');
  return marker < 0 ? base : base.slice(0, marker);
}

/**
 * The response key a selection carries a schema field under (`myEdges: edges` → `myEdges`).
 *
 * `keyRaw` holds the field name (§3.2), so looking a field up by name finds its entry however the
 * response key was aliased; the returned key is what indexes a read result or a payload object, and
 * is what `read`/`write` must use instead of the schema name (C3).
 */
export function responseKeyFor(
  selection: SubscriptionSelection | undefined,
  fieldName: string,
): string | undefined {
  for (const [name, spec] of Object.entries(selection?.fields ?? {})) {
    if (fieldNameOf(spec.keyRaw) === fieldName) {
      return name;
    }
  }
  return undefined;
}

/** `true` when `value` is a non-null, non-array object usable as a record payload. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The record view of a payload, or `null` when it is not an object. */
export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

/** The text form of a key field value. Objects and arrays render as canonical JSON. */
function scalarText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return canonicalJSON(value);
}

/** The GraphQL literal spelling of one artifact value (graphql-js's printer rules). */
function literal(value: GraphQLValue | undefined): string {
  if (value === undefined) {
    return 'null';
  }
  switch (value.kind) {
    case 'Variable':
      return `$${value.name}`;
    case 'IntValue':
    case 'FloatValue':
      return value.value;
    case 'StringValue':
      return JSON.stringify(value.value);
    case 'EnumValue':
      return value.value;
    case 'BooleanValue':
      return value.value ? 'true' : 'false';
    case 'NullValue':
      return 'null';
    case 'ListValue':
      return `[${value.values.map((entry) => literal(entry)).join(', ')}]`;
    case 'ObjectValue': {
      const names = Object.keys(value.fields).toSorted();
      return `{${names.map((name) => `${name}: ${literal(value.fields[name])}`).join(', ')}}`;
    }
    default:
      return 'null';
  }
}

/** The variable substitution rules: `JSON.stringify`, with a missing variable as `null`. */
function jsonValue(value: unknown): string {
  return JSON.stringify(value ?? null) ?? 'null';
}

/** `<__typename>-<hash>`: the degraded id of a payload that cannot compute one (§6.3). */
function payloadID(type: string, record: Readonly<Record<string, unknown>> | null): string {
  const typename =
    record !== null && typeof record['__typename'] === 'string' ? record['__typename'] : type;
  return `${typename}-${fnv1a32(canonicalJSON(record))}`;
}

/** FNV-1a 32 over a canonical JSON string, as 8 lowercase hex characters (deterministic). */
export function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** JSON with object keys sorted at every level, so the same payload always hashes the same. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJSON(entry)).join(',')}]`;
  }
  if (!isRecord(value)) {
    return 'null';
  }
  const keys = Object.keys(value).toSorted();
  return `{${keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`)
    .join(',')}}`;
}

/**
 * `true` when the process reports a production build. Read through a structural carrier because
 * this package has no `node` types; it decides only whether a bad payload throws or degrades.
 */
function isProduction(): boolean {
  const carrier: RuntimeEnvCarrier = globalThis;
  return carrier.process?.env?.['NODE_ENV'] === 'production';
}

/**
 * A structural view of the global object. `Object` is declared because it is a property every
 * JavaScript global has: without a common member the assignment below would hit TS2559 (a type with
 * only optional members has no overlap with `typeof globalThis`).
 */
interface RuntimeEnvCarrier {
  readonly Object: unknown;
  readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> };
}
