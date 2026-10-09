/**
 * Naming rules for generated files: the FNV-1a-32 helper used by fragment-argument
 * clones and the artifact path builders (`spec/spec.md` §4.6).
 */

import type { GraphQLValue } from './contract.js';

const FNV_OFFSET_BASIS = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;
/** 2^32, as a float; keeps the multiply in exact double range without `Math.imul` overflow. */
const UINT32 = 4_294_967_296;

/** FNV-1a 32-bit hash of a string, as an unsigned integer. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // Multiply by the FNV prime modulo 2^32, then keep the low 32 bits.
    hash = (hash * FNV_PRIME) % UINT32;
    hash >>>= 0;
  }
  return hash >>> 0;
}

/** Base-36 rendering of a 32-bit hash, left-padded to `length` characters. */
export function base36(value: number, length: number): string {
  return (value >>> 0).toString(36).padStart(length, '0').slice(-length);
}

/** Canonical JSON for a resolved fragment-argument map: keys sorted, no whitespace. */
export function canonicalJson(value: GraphQLValue | Readonly<Record<string, GraphQLValue>>): string {
  if (isGraphQLValue(value)) {
    return canonicalValue(value);
  }
  const parts = Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key] ?? { kind: 'NullValue' })}`);
  return `{${parts.join(',')}}`;
}

function isGraphQLValue(
  value: GraphQLValue | Readonly<Record<string, GraphQLValue>>,
): value is GraphQLValue {
  return 'kind' in value;
}

function canonicalValue(value: GraphQLValue): string {
  switch (value.kind) {
    case 'Variable':
      return `{"kind":"Variable","name":${JSON.stringify(value.name)}}`;
    case 'IntValue':
    case 'FloatValue':
    case 'StringValue':
    case 'EnumValue':
      return `{"kind":${JSON.stringify(value.kind)},"value":${JSON.stringify(value.value)}}`;
    case 'BooleanValue':
      return `{"kind":"BooleanValue","value":${String(value.value)}}`;
    case 'NullValue':
      return '{"kind":"NullValue"}';
    case 'ListValue':
      return `{"kind":"ListValue","values":[${value.values.map(canonicalValue).join(',')}]}`;
    case 'ObjectValue':
      return canonicalJson(value.fields);
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/**
 * The artifact name of a fragment-argument clone: `<Name>_<6 base36 chars of
 * FNV-1a-32 over the canonical JSON of the resolved arguments>` (§4.6). Reserved
 * in v1 (fragment arguments are FLM1008) but specified, so the naming decision is
 * fixed before the feature lands.
 */
export function cloneFragmentName(
  name: string,
  args: Readonly<Record<string, GraphQLValue>>,
): string {
  return `${name}_${base36(fnv1a32(canonicalJson(args)), 6)}`;
}

/** The artifact module path relative to the generated directory (`artifacts/<Name>.ts`). */
export function artifactModulePath(name: string): string {
  return `artifacts/${name}.ts`;
}

/** True when `name` is a legal TypeScript identifier and can be emitted unquoted. */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/**
 * A locale-independent string comparison (code-unit order). Every sort in the
 * compiler uses this: `localeCompare` without a locale argument makes the emitted
 * bytes depend on `LANG`/`LC_ALL` (Turkish collation reorders `i`/`I`), which
 * breaks the reproducibility guarantee of §4.6.
 */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Names that cannot be used verbatim as the exported type alias and the barrel
 * binding of an artifact: reserved words, `true`/`false`/`null`, and contextual
 * names a `export type X` / `export { default as X }` rejects. Emitting them
 * produces a syntactically invalid module, so the compiler rejects the document
 * with FLM1019 instead (A11).
 */
const RESERVED_TYPE_NAMES = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'let', 'static', 'yield', 'await', 'implements',
  'interface', 'package', 'private', 'protected', 'public', 'arguments', 'eval',
]);

/** True when `name` is safe to emit verbatim as an exported type alias and binding. */
export function isUsableDocumentName(name: string): boolean {
  return isIdentifier(name) && !RESERVED_TYPE_NAMES.has(name);
}
