#!/usr/bin/env node
/**
 * The graphql-js oracle for `graphql_frontend.rs`.
 *
 * Runs the repository's installed `graphql` package over the fixtures under
 * `tests/fixtures/graphql/` and prints, as one JSON object, everything the Rust
 * front end has to reproduce:
 *
 *   - `valid/<name>.gql`       `print(parse(text))` and its round trip
 *   - `sdl/<name>.graphql`     a structural summary of every type system definition
 *   - `invalid/<name>.gql`     the syntax error's message, line and column
 *   - `invalidSdl/<name>.graphql` the same, for `parse` used as `buildSchema` does
 *   - `types/<name>.graphql`   `print(parseType(text))`
 *   - `offsets/<name>.gql`     every node location the Rust walker collects
 *
 * `graphql` is a dependency of `packages/core`, not of the repository root, so it
 * is required through `createRequire` anchored at that package.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const { parse, parseType, print } = require('graphql');

const FIXTURES = fileURLToPath(new URL('./fixtures/graphql/', import.meta.url));

/** Reads one fixture directory, sorted by file name. */
function readFixtureDir(directory) {
  let entries;
  try {
    entries = readdirSync(join(FIXTURES, directory));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.startsWith('.'))
    .sort()
    .map((entry) => ({
      name: entry,
      text: readFileSync(join(FIXTURES, directory, entry), 'utf8'),
    }));
}

/** `error.message` and `error.locations[0]`, which is all a syntax error carries. */
function errorShape(error) {
  const location = Array.isArray(error.locations) ? error.locations[0] : undefined;
  return {
    message: String(error.message),
    line: location === undefined ? null : location.line,
    column: location === undefined ? null : location.column,
  };
}

// ---------------------------------------------------------------------------
// Type system summaries: the same shape `graphql_frontend.rs` builds from the AST.
// ---------------------------------------------------------------------------

function descriptionOf(node) {
  return node.description ? node.description.value : null;
}

function directivesOf(node) {
  return (node.directives ?? []).map((directive) => ({
    name: directive.name.value,
    arguments: directive.arguments.map((argument) => [argument.name.value, print(argument.value)]),
  }));
}

function inputValueShape(node) {
  return {
    description: descriptionOf(node),
    name: node.name.value,
    type: print(node.type),
    defaultValue: node.defaultValue ? print(node.defaultValue) : null,
    directives: directivesOf(node),
  };
}

function fieldShape(node) {
  return {
    description: descriptionOf(node),
    name: node.name.value,
    arguments: node.arguments.map(inputValueShape),
    type: print(node.type),
    directives: directivesOf(node),
  };
}

function enumValueShape(node) {
  return {
    description: descriptionOf(node),
    name: node.name.value,
    directives: directivesOf(node),
  };
}

function definitionShape(node) {
  // A schema extension has no name, so the shared fields are built per case.
  const directives = directivesOf(node);
  const named = () => ({
    kind: node.kind,
    description: descriptionOf(node),
    name: node.name.value,
  });
  switch (node.kind) {
    case 'SchemaDefinition':
    case 'SchemaExtension':
      return {
        kind: node.kind,
        description: descriptionOf(node),
        directives,
        operationTypes: node.operationTypes.map((operationType) => [
          operationType.operation,
          operationType.type.name.value,
        ]),
      };
    case 'ScalarTypeDefinition':
    case 'ScalarTypeExtension':
      return { ...named(), directives };
    case 'ObjectTypeDefinition':
    case 'ObjectTypeExtension':
    case 'InterfaceTypeDefinition':
    case 'InterfaceTypeExtension':
      return {
        ...named(),
        interfaces: node.interfaces.map((type) => type.name.value),
        directives,
        fields: node.fields.map(fieldShape),
      };
    case 'UnionTypeDefinition':
    case 'UnionTypeExtension':
      return { ...named(), directives, types: node.types.map((type) => type.name.value) };
    case 'EnumTypeDefinition':
    case 'EnumTypeExtension':
      return { ...named(), directives, values: node.values.map(enumValueShape) };
    case 'InputObjectTypeDefinition':
    case 'InputObjectTypeExtension':
      return { ...named(), directives, fields: node.fields.map(inputValueShape) };
    case 'DirectiveDefinition':
      return {
        kind: node.kind,
        description: descriptionOf(node),
        name: node.name.value,
        arguments: node.arguments.map(inputValueShape),
        repeatable: node.repeatable,
        locations: node.locations.map((location) => location.value),
      };
    default:
      throw new Error(`summary does not know ${node.kind}`);
  }
}

// ---------------------------------------------------------------------------
// Locations: the walker mirrors the one in `graphql_frontend.rs`.
// ---------------------------------------------------------------------------

function collectLocs(document) {
  const out = [];
  for (const definition of document.definitions) {
    collectDefinition(definition, out);
  }
  return out;
}

function loc(kind, label, node) {
  return [kind, label, node.loc.start, node.loc.end];
}

function collectDefinition(definition, out) {
  if (definition.kind === 'FragmentDefinition') {
    out.push(loc('FragmentDefinition', definition.name.value, definition));
    out.push(
      loc(definition.typeCondition.kind, print(definition.typeCondition), definition.typeCondition),
    );
    for (const directive of definition.directives) {
      out.push(loc('Directive', directive.name.value, directive));
    }
    collectSelectionSet(definition.selectionSet, out);
    return;
  }
  out.push(loc('OperationDefinition', definition.name ? definition.name.value : '', definition));
  for (const variableDefinition of definition.variableDefinitions) {
    out.push(loc('VariableDefinition', '', variableDefinition));
    out.push(loc('Variable', variableDefinition.variable.name.value, variableDefinition.variable));
    out.push(
      loc(variableDefinition.type.kind, print(variableDefinition.type), variableDefinition.type),
    );
    if (variableDefinition.defaultValue) {
      collectValue(variableDefinition.defaultValue, out);
    }
    for (const directive of variableDefinition.directives) {
      out.push(loc('Directive', directive.name.value, directive));
    }
  }
  for (const directive of definition.directives) {
    out.push(loc('Directive', directive.name.value, directive));
  }
  collectSelectionSet(definition.selectionSet, out);
}

function collectSelectionSet(selectionSet, out) {
  for (const selection of selectionSet.selections) {
    if (selection.kind === 'Field') {
      const responseKey = `${selection.alias ? `${selection.alias.value}:` : ''}${selection.name.value}`;
      out.push(loc('Field', responseKey, selection));
      out.push(loc('FieldName', selection.name.value, selection.name));
      for (const argument of selection.arguments) {
        out.push(loc('Argument', argument.name.value, argument));
        collectValue(argument.value, out);
      }
      for (const directive of selection.directives) {
        out.push(loc('Directive', directive.name.value, directive));
      }
      if (selection.selectionSet) {
        collectSelectionSet(selection.selectionSet, out);
      }
      continue;
    }
    if (selection.kind === 'FragmentSpread') {
      out.push(loc('FragmentSpread', selection.name.value, selection));
      for (const directive of selection.directives) {
        out.push(loc('Directive', directive.name.value, directive));
      }
      continue;
    }
    out.push(
      loc(
        'InlineFragment',
        selection.typeCondition ? print(selection.typeCondition) : '',
        selection,
      ),
    );
    for (const directive of selection.directives) {
      out.push(loc('Directive', directive.name.value, directive));
    }
    collectSelectionSet(selection.selectionSet, out);
  }
}

function collectValue(value, out) {
  switch (value.kind) {
    case 'Variable':
      out.push(loc('Variable', value.name.value, value));
      break;
    case 'IntValue':
    case 'FloatValue':
    case 'EnumValue':
      out.push(loc(value.kind, value.value, value));
      break;
    case 'StringValue':
      out.push(loc('StringValue', value.value, value));
      break;
    case 'BooleanValue':
      out.push(loc('BooleanValue', value.value ? 'true' : 'false', value));
      break;
    case 'NullValue':
      out.push(loc('NullValue', '', value));
      break;
    case 'ListValue':
      out.push(loc('ListValue', '', value));
      for (const item of value.values) {
        collectValue(item, out);
      }
      break;
    case 'ObjectValue':
      out.push(loc('ObjectValue', '', value));
      for (const field of value.fields) {
        out.push(loc('ObjectField', field.name.value, field));
        collectValue(field.value, out);
      }
      break;
    default:
      throw new Error(`locs do not know ${value.kind}`);
  }
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

const report = {
  valid: {},
  sdl: {},
  invalid: {},
  invalidSdl: {},
  types: {},
  offsets: {},
};

for (const { name, text } of readFixtureDir('valid')) {
  try {
    const printed = print(parse(text));
    report.valid[name] = { error: null, printed, reprinted: print(parse(printed)) };
  } catch (error) {
    report.valid[name] = { error: errorShape(error), printed: null, reprinted: null };
  }
}

for (const { name, text } of readFixtureDir('sdl')) {
  try {
    const document = parse(text);
    report.sdl[name] = { error: null, shapes: document.definitions.map(definitionShape) };
  } catch (error) {
    report.sdl[name] = { error: errorShape(error), shapes: null };
  }
}

for (const [section, directory] of [
  ['invalid', 'invalid'],
  ['invalidSdl', 'invalid-sdl'],
]) {
  for (const { name, text } of readFixtureDir(directory)) {
    try {
      report[section][name] = { error: null, printed: print(parse(text)) };
    } catch (error) {
      report[section][name] = { error: errorShape(error), printed: null };
    }
  }
}

for (const { name, text } of readFixtureDir('types')) {
  try {
    report.types[name] = { error: null, printed: print(parseType(text)) };
  } catch (error) {
    report.types[name] = { error: errorShape(error), printed: null };
  }
}

for (const { name, text } of readFixtureDir('offsets')) {
  try {
    report.offsets[name] = {
      error: null,
      printed: print(parse(text)),
      locs: collectLocs(parse(text)),
    };
  } catch (error) {
    report.offsets[name] = { error: errorShape(error), printed: null, locs: null };
  }
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
