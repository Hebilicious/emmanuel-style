/**
 * Route params into GraphQL variables (REQ-2, REQ-5).
 *
 * A generated loader's variables come from the route's params, **by name**: the compiler knows the
 * document declares `$id: Int!`, so the `id` param (always a string, because a URL segment is a
 * string) is coerced to a number without the app writing `Number(route.params.id)` anywhere.
 *
 * ## Coercion table
 *
 * | GraphQL variable type        | JS value of the param                                  |
 * | ---------------------------- | ------------------------------------------------------ |
 * | `Int`, `Float`, a custom scalar whose config type is `number` | `Number(value)` when it is finite |
 * | `Boolean`                    | `true` for `"true"`/`"1"`, `false` for `"false"`/`"0"` |
 * | `String`, `ID`               | the string, unchanged                                  |
 * | a list type `[T!]!`          | unsupported: the param is passed through unchanged     |
 *
 * A param that **cannot** be coerced (`/bulbasaur` for `$id: Int!`) is dropped, so the document's
 * own default (`$id: Int! = 1`) applies; a required variable with no matching param is a diagnostic
 * at generation time, not a runtime surprise. An **absent** optional param is dropped too, so the
 * default applies rather than the document being sent `{ id: null }` for a non-null variable.
 *
 * ## Renaming
 *
 * The name match is the convention, and `routing.params` is the per-document override for the cases
 * where the param and the variable disagree:
 *
 * ```ts
 * routing: { params: { '/pokemon/:id': { speciesId: 'id' } } }
 * ```
 *
 * reads `params.speciesId` into `$id`. The key is the route's **path pattern** (the same string the
 * generated record carries), not the file name, so a route can be renamed without touching the hook.
 */

import { Kind, parse, type TypeNode, type ValueNode } from 'graphql';
import type { Variables } from '@flamme/runtime';

/** The scalar kinds the coercer knows, after unwrapping any custom-scalar mapping. */
export type VariableCoercion = 'int' | 'float' | 'string' | 'boolean' | 'unknown';

/** One GraphQL variable of a page's query, as the generated route record carries it. */
export interface RouteVariable {
  /** The GraphQL variable name, without the `$`. */
  readonly name: string;
  /** The variable's type as written, e.g. `Int!`, `[String!]!`. */
  readonly type: string;
  /** The named type without modifiers, e.g. `Int`. */
  readonly namedType: string;
  /** `true` when the type is a list at any depth; list params are passed through unchanged. */
  readonly list: boolean;
  /** `true` when the type is non-null at the top level. */
  readonly required: boolean;
  /** The coercer the loader applies to the param, or `undefined` to pass it through. */
  readonly coercion: VariableCoercion | undefined;
  /** The document's own default for this variable, when it declares one. */
  readonly defaultValue?: string | number | boolean | null;
}

/** The per-document param overrides a resolved config carries under `routing.params`. */
export type RouteParamOverrides = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** One param a generated loader reads: which param, into which variable, coerced how. */
export interface RouteParamSource {
  /** The GraphQL variable name the value is assigned to. */
  readonly variable: string;
  /** The route param name read from `route.params`, before any rename. */
  readonly param: string;
  /** The coercer, or `undefined` to pass the param through unchanged. */
  readonly coercion: VariableCoercion | undefined;
  /**
   * `true` when the variable's type is non-null. Generation-time metadata: it decides whether a
   * missing param is a warning (`FLM3003`), and the runtime resolver never reads it.
   */
  readonly required?: boolean;
}

/**
 * The numeric reading of a param: a number as it is, a string through `Number`, and a boolean
 * refused (a `true` is not an `Int`). `undefined` means "no number here", never `NaN`.
 */
function numeric(value: string | number | boolean): number | undefined {
  if (typeof value === 'boolean') {
    return undefined;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** The coercer for one named GraphQL type. */
export function coercionOf(
  namedType: string,
  config?: { readonly scalars?: Readonly<Record<string, { readonly type: string }>> },
): VariableCoercion {
  switch (namedType) {
    case 'Int':
      return 'int';
    case 'Float':
      return 'float';
    case 'Boolean':
      return 'boolean';
    case 'String':
    case 'ID':
      return 'string';
    default:
      break;
  }
  // A custom scalar is only coercible when the config says what TS type it parses to.
  const scalar = config?.scalars?.[namedType];
  if (scalar === undefined) {
    return 'unknown';
  }
  if (scalar.type === 'number') {
    return 'float';
  }
  if (scalar.type === 'boolean') {
    return 'boolean';
  }
  return 'string';
}

/** Unwraps a GraphQL type node into its named type, list-ness and top-level requiredness. */
export function describeType(node: TypeNode): {
  readonly type: string;
  readonly namedType: string;
  readonly list: boolean;
  readonly required: boolean;
} {
  const list = isListDeep(node);
  const required = node.kind === Kind.NON_NULL_TYPE;
  return { type: printType(node), namedType: namedTypeOf(node), list, required };
}

/** `true` when a list appears anywhere in the type. */
function isListDeep(node: TypeNode): boolean {
  if (node.kind === Kind.LIST_TYPE) {
    return true;
  }
  if (node.kind === Kind.NON_NULL_TYPE) {
    return isListDeep(node.type);
  }
  return false;
}

/** The named type at the bottom of a type node. */
export function namedTypeOf(node: TypeNode): string {
  return node.kind === Kind.NAMED_TYPE ? node.name.value : namedTypeOf(node.type);
}

/** The type as written (`Int!`, `[String!]!`). */
export function printType(node: TypeNode): string {
  switch (node.kind) {
    case Kind.NAMED_TYPE:
      return node.name.value;
    case Kind.LIST_TYPE:
      return `[${printType(node.type)}]`;
    case Kind.NON_NULL_TYPE:
      return `${printType(node.type)}!`;
    default:
      return 'unknown';
  }
}

/**
 * Every `$name: Type = default` of a document's operations, as route variables. Fragments declare
 * no variables of their own, and a document with several operations (which a page's query is not)
 * unions them in source order.
 */
export function variablesOfDocument(
  source: string,
  config?: { readonly scalars?: Readonly<Record<string, { readonly type: string }>> },
): readonly RouteVariable[] {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source);
  } catch {
    return [];
  }
  const found: RouteVariable[] = [];
  const seen = new Set<string>();
  for (const definition of ast.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) {
      continue;
    }
    for (const variable of definition.variableDefinitions ?? []) {
      const name = variable.variable.name.value;
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const described = describeType(variable.type);
      const coercion = described.list ? undefined : coercionOf(described.namedType, config);
      const defaultValue = literalOf(variable.defaultValue);
      found.push({
        name,
        ...described,
        coercion,
        ...(defaultValue === undefined ? {} : { defaultValue }),
      });
    }
  }
  return found;
}

/**
 * The JS value of a GraphQL default, or `undefined` when the variable has no default or its default
 * is not a scalar literal (an enum or a variable is not a value a route param could carry).
 */
export function literalOf(node: ValueNode | undefined): string | number | boolean | null | undefined {
  if (node === undefined) {
    return undefined;
  }
  switch (node.kind) {
    case Kind.INT:
      return Number.parseInt(node.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(node.value);
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.BOOLEAN:
      return node.value;
    case Kind.NULL:
      return null;
    default:
      return undefined;
  }
}

/** The params one route's loaders read, after the per-document `routing.params` override. */
export function paramSources(
  pathPattern: string,
  variables: readonly RouteVariable[],
  params: readonly string[],
  overrides: RouteParamOverrides | undefined,
): readonly RouteParamSource[] {
  const renamed = overrides?.[pathPattern] ?? {};
  // A rename is `{ param: variable }`; invert it so the lookup stays variable-first.
  const byVariable = new Map<string, string>();
  for (const [param, variable] of Object.entries(renamed)) {
    byVariable.set(variable, param);
  }
  const available = new Set(params);
  const sources: RouteParamSource[] = [];
  for (const variable of variables) {
    const param = byVariable.get(variable.name) ?? variable.name;
    if (!available.has(param)) {
      continue;
    }
    sources.push({
      variable: variable.name,
      param,
      coercion: variable.coercion,
      required: variable.required,
    });
  }
  return sources;
}

/**
 * The variables one navigation resolves (REQ-5): each source reads its param, coerces it, and is
 * dropped when it is absent or uncoercible so the document's own default applies.
 *
 * The emitted route module carries the sources as data and calls this, so the resolution rule lives
 * in one place and is unit-testable without a generated file.
 */
export function resolveRouteVariables(
  sources: readonly RouteParamSource[],
  params: Readonly<Record<string, unknown>>,
): Variables {
  const variables: Record<string, unknown> = {};
  for (const source of sources) {
    const raw = params[source.param];
    const value = coerceParam(raw, source.coercion);
    if (value !== undefined) {
      variables[source.variable] = value;
    }
  }
  return variables;
}

/**
 * One param value coerced to its variable's type, or `undefined` when it cannot be. A route param is
 * a string (or a number, when a caller passes an id the app already holds); anything else addresses
 * no variable and is refused rather than stringified.
 */
export function coerceParam(value: unknown, coercion: VariableCoercion | undefined): unknown {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return undefined;
  }
  switch (coercion) {
    case 'int': {
      const parsed = numeric(value);
      return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
    }
    case 'float': {
      const parsed = numeric(value);
      return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
    }
    case 'boolean':
      if (typeof value === 'boolean') {
        return value;
      }
      if (value === 'true' || value === '1') {
        return true;
      }
      if (value === 'false' || value === '0') {
        return false;
      }
      return undefined;
    case 'string':
      return typeof value === 'string' ? value : value.toString();
    default:
      // An unknown scalar (or a list type) is handed over as the param carried it: the param is a
      // string, and the runtime's own marshaling decides what to send.
      return value;
  }
}
