/**
 * Schema sourcing and the read-only schema surface (`spec/spec.md` §4.2).
 *
 * The compiler is Rust: it indexes the SDL, validates against it and emits from it.
 * What stays in TypeScript is the part that is not compilation: resolving the
 * configured source (an SDL file, an introspection JSON file or object, a URL),
 * printing an introspection payload to SDL, and the {@link SchemaIndex} view the
 * read-only inspectors read from the native response.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { buildClientSchema, printSchema, type IntrospectionQuery } from 'graphql';

import type { ScalarConfig, TypeConfig } from './config.js';
import { SchemaError, errorMessage } from './diagnostics.js';
import { toPosix } from './offsets.js';

/** Where a project's schema comes from. */
export interface SchemaSource {
  /** Project root the relative paths resolve against. */
  readonly projectDir: string;
  /** Path to an SDL file or an introspection JSON file. */
  readonly schemaPath?: string;
  /** Inline SDL text, or an introspection result. */
  readonly schema?: unknown;
  /** GraphQL endpoint to introspect. */
  readonly url?: string;
  /** Extra headers for the introspection request. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The schema index as the read-only inspectors read it.
 *
 * The native compiler builds the real index inside Rust; this is the subset it
 * sends back (`IrSchema` in `crates/flamme-core/src/request.rs`): key fields, the
 * possible types, the enum and input-object maps and the SDL. `flamme explain` and
 * `flamme refs` read key fields and nothing else.
 */
export interface SchemaIndex {
  /** `possibleTypes` per composite type: `{ Species: ['Species'] }`. */
  readonly possibleTypes: Readonly<Record<string, readonly string[]>>;
  /** Key fields per composite type, merged from schema `@key` and `config.types`. */
  readonly keyFields: Readonly<Record<string, readonly string[]>>;
  /** The key fields used for a type: schema `@key`, then `config.types`, then `defaultKeys`. */
  keyFieldsForType(type: string): readonly string[];
  /** `true` when the type has no available key field and is therefore stored inline. */
  isEmbedded(type: string): boolean;
  /** Enum name → its values. */
  readonly enums: Readonly<Record<string, readonly string[]>>;
  /** Input object name → field name → type string. */
  readonly inputTypes: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** `sha256` of the SDL the index was built from; the `schemaHash` in `manifest.json`. */
  readonly hash: string;
  /** The user's SDL, verbatim. */
  readonly sdl: string;
}

/** Options carried through the native request; kept for the public shape. */
export interface SchemaIndexOptions {
  /** Custom scalar mapping; only `type` is needed for indexing. */
  readonly scalars?: Readonly<Record<string, ScalarConfig>>;
  /** Per-type key configuration. */
  readonly types?: Readonly<Record<string, TypeConfig>>;
  /** Fallback key fields. Default `['id']`. */
  readonly defaultKeys?: readonly string[];
}

/** Timeout for the introspection request, in milliseconds (E4). */
const INTROSPECTION_TIMEOUT_MS = 10_000;

/** The introspection query an SDL-less project sends (`graphql`'s `getIntrospectionQuery`). */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
    directives { name locations args { ...InputValue } }
  }
}
fragment FullType on __Type {
  kind name
  fields(includeDeprecated: true) { name args { ...InputValue } type { ...TypeRef } }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) { name }
  possibleTypes { ...TypeRef }
}
fragment InputValue on __InputValue { name type { ...TypeRef } defaultValue }
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }
}
`;

/**
 * The schema source the native compiler receives: the SDL text and the file it came
 * from. The native side builds the index from the SDL.
 */
export async function readSchemaSourceForCompiler(
  source: SchemaSource,
): Promise<{ readonly sdl: string; readonly file: string }> {
  return readSchemaSource(source);
}

async function readSchemaSource(
  source: SchemaSource,
): Promise<{ readonly sdl: string; readonly file: string }> {
  const root = source.projectDir;
  const absolute = (path: string): string => (isAbsolute(path) ? path : resolve(root, path));

  if (source.schemaPath !== undefined) {
    const path = absolute(source.schemaPath);
    try {
      return { sdl: await readFile(path, 'utf8'), file: toPosix(path) };
    } catch (error) {
      throw new SchemaError(`Cannot read schema file "${toPosix(path)}": ${errorMessage(error)}`);
    }
  }
  if (typeof source.schema === 'string') {
    const looksLikeSdl =
      /^\s*(schema|type|interface|union|enum|input|scalar|directive|extend)\b/m.test(source.schema);
    if (!looksLikeSdl) {
      const path = absolute(source.schema);
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        throw new SchemaError(`Cannot read schema file "${toPosix(path)}": ${errorMessage(error)}`);
      }
      // A JSON file is an introspection result, not SDL.
      if (text.trimStart().startsWith('{')) {
        return fromIntrospection(parseJson(text, toPosix(path)), toPosix(path));
      }
      return { sdl: text, file: toPosix(path) };
    }
    return { sdl: source.schema, file: '<inline>' };
  }
  if (typeof source.schema === 'object' && source.schema !== null) {
    return fromIntrospection(source.schema, '<introspection>');
  }
  if (source.url !== undefined) {
    let response: Response;
    try {
      // An endpoint that accepts the connection and never answers must not hang the
      // build forever: the fetch carries an abort timeout (E4).
      response = await fetch(source.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...source.headers },
        body: JSON.stringify({ query: INTROSPECTION_QUERY }),
        signal: AbortSignal.timeout(INTROSPECTION_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SchemaError(
        `Cannot introspect "${source.url}": ${errorMessage(error)} (timeout ${INTROSPECTION_TIMEOUT_MS} ms).`,
      );
    }
    if (!response.ok) {
      throw new SchemaError(`Cannot introspect "${source.url}": HTTP ${response.status}.`);
    }
    const payload: unknown = await response.json();
    return fromIntrospection(payload, source.url);
  }
  throw new SchemaError('No schema source configured.');
}

/** True for a plain object. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/**
 * True for a payload that carries the introspection shape `buildClientSchema`
 * needs: an object with a `__schema` object holding `types` and root type names.
 * The deeper structure is graphql-js's contract, and it throws on garbage.
 */
function isIntrospectionPayload(value: unknown): value is IntrospectionQuery {
  if (!isRecord(value)) {
    return false;
  }
  const schema: unknown = Reflect.get(value, '__schema');
  return isRecord(schema) && 'types' in schema && 'queryType' in schema;
}

/** Parses introspection JSON, reporting a `SchemaError` for malformed input. */
function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SchemaError(`Cannot parse "${file}" as JSON: ${errorMessage(error)}`);
  }
}

function fromIntrospection(
  payload: unknown,
  file: string,
): { readonly sdl: string; readonly file: string } {
  const inner: unknown = isRecord(payload) ? (payload['data'] ?? payload) : payload;
  if (!isIntrospectionPayload(inner)) {
    throw new SchemaError(`Introspection payload from "${file}" has no __schema field.`);
  }
  try {
    const schema = buildClientSchema(inner);
    return { sdl: printSchema(schema), file };
  } catch (error) {
    throw new SchemaError(`Invalid introspection payload from "${file}": ${errorMessage(error)}`);
  }
}
