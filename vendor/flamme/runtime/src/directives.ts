/**
 * Read-time directive evaluation, shared by the two halves of the cache walk.
 *
 * `@include`/`@skip` are standard GraphQL and stay in `raw`, so the server applies the same
 * condition; `@when`/`@when_not` are compiler-only and the artifact records them on the spread's
 * fields, so the **writer** and the **reader** must agree on which fields the selection holds.
 * They live here, next to each other, so they cannot drift.
 *
 * `@when`/`@when_not` entries on one field are a **disjunction** (a field contributed by several
 * conditional spreads is present when any of their conditions holds); `@include`/`@skip` are
 * conjunctive filters, exactly as in GraphQL. A condition whose variable is absent from the read's
 * variables holds only for `@when_not`.
 */
import type { DirectiveSpec, GraphQLValue, Variables, WhenCondition } from './artifact.js';

/** Evaluates one serialized GraphQL value against a variable set. */
export function evaluateValue(value: GraphQLValue, variables: Variables): unknown {
  switch (value.kind) {
    case 'Variable':
      return variables[value.name];
    case 'IntValue':
    case 'FloatValue':
      return Number(value.value);
    case 'StringValue':
    case 'EnumValue':
      return value.value;
    case 'BooleanValue':
      return value.value;
    case 'NullValue':
      return null;
    case 'ListValue':
      return value.values.map((entry) => evaluateValue(entry, variables));
    case 'ObjectValue': {
      const out: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(value.fields)) {
        out[name] = evaluateValue(entry, variables);
      }
      return out;
    }
    default:
      return null;
  }
}

/** `true` when a field is part of the selection under `variables` (`@include`/`@skip`/`@when`). */
export function isIncluded(
  spec: { readonly directives?: readonly DirectiveSpec[] },
  variables: Variables,
): boolean {
  let conditional = false;
  let conditionalHolds = false;
  for (const directive of spec.directives ?? []) {
    if (directive.name === 'when' || directive.name === 'when_not') {
      const variable = stringArgument(directive, 'argument');
      if (variable === null) {
        continue;
      }
      conditional = true;
      // `@when_not` holds for anything that is not the boolean `true`, so a variable the caller
      // never passed still excludes a `@when` field and includes a `@when_not` one
      if ((variables[variable] === true) === (directive.name === 'when')) {
        conditionalHolds = true;
      }
      continue;
    }
    const when = directiveIf(directive, variables);
    if (when === null) {
      continue;
    }
    if (directive.name === 'include' && !when) {
      return false;
    }
    if (directive.name === 'skip' && when) {
      return false;
    }
  }
  return !conditional || conditionalHolds;
}

/** `true` when a spread's `when` metadata holds under `variables` (a disjunction). */
export function whenSatisfied(
  conditions: readonly WhenCondition[],
  variables: Variables,
): boolean {
  return conditions.some(
    (condition) => (variables[condition.variable] === true) === condition.polarity,
  );
}

/** The string literal of a directive argument, or `null` when it is missing or not a string. */
function stringArgument(directive: DirectiveSpec, name: string): string | null {
  const argument = directive.arguments[name];
  return argument !== undefined && argument.kind === 'StringValue' ? argument.value : null;
}

/** `@include(if:)` / `@skip(if:)`, or `null` when the directive has no boolean `if` value. */
function directiveIf(directive: DirectiveSpec, variables: Variables): boolean | null {
  const argument = directive.arguments['if'];
  if (argument === undefined) {
    return null;
  }
  const value = evaluateValue(argument, variables);
  return typeof value === 'boolean' ? value : null;
}
