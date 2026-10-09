/**
 * Text rendering for the agent-facing surfaces (`research/answers-report.md`
 * Q1): `flamme explain` and `flamme refs`.
 *
 * The output is deliberately line-oriented and column-stable: an agent (or a
 * golden test) reads it as text, there is no colour, and every value the
 * compiler knows about the document appears exactly once.
 */

import type {
  DocumentExplanation,
  ExplainList,
  ExplainSelection,
  FragmentReferences,
} from '@flamme/core';

/** The label column every explanation line pads to. */
const LABEL = 12;

/** The column the selection tree pads each key to. */
const KEY_COLUMN = 26;

/** `(none)` for an empty value; a stable marker beats an empty line. */
function orNone(text: string): string {
  return text.length === 0 ? '(none)' : text;
}

/** `label` in the label column, padded for the value column. */
function line(label: string, value: string): string {
  return `${label.padEnd(LABEL)}${value}`;
}

/** `key = value` for a defaulted variable, `key` alone otherwise. */
function variableText(entry: DocumentExplanation['variables'][number]): string {
  return `${entry.name}: ${entry.type}${entry.hasDefault ? ' = <default>' : ''}`;
}

/** `Name (Type)` per `@list` registration. */
function listText(entry: ExplainList): string {
  return `${entry.name} (${entry.type}${entry.connection ? ', connection' : ''})`;
}

/** `path (method, mode, pageSize n)` per `@paginate` field. */
function paginationText(explanation: DocumentExplanation): string {
  return explanation.paginated
    .map((path) => {
      const field = findField(explanation.selection, path);
      const spec = field?.pagination;
      return spec === undefined
        ? path.join('.')
        : `${path.join('.')} (${spec.method}, ${spec.mode}, pageSize ${spec.pageSize})`;
    })
    .join(', ');
}

/** The selection row at a document-relative field path, if the tree has one. */
function findField(
  rows: readonly ExplainSelection[],
  path: readonly string[],
): ExplainSelection | undefined {
  let current: readonly ExplainSelection[] | undefined = rows;
  let found: ExplainSelection | undefined;
  for (const key of path) {
    found = (current ?? []).find((row) => row.key === key);
    current = found?.fields;
  }
  return found;
}

/** The flags of one tree row, in a fixed order. */
function flagsOf(row: ExplainSelection): string {
  const flags: string[] = [];
  if (row.isKey === true) {
    flags.push('key');
  }
  if (!row.visible) {
    flags.push('visible=false');
  }
  if (row.nullable) {
    flags.push('nullable');
  }
  if (row.inlined === true) {
    flags.push('inlined');
  }
  if (row.loading !== undefined) {
    const count = row.loading.list === undefined ? '' : `, count: ${row.loading.list.count}`;
    flags.push(`@loading(${row.loading.kind}${count})`);
  }
  if (row.list !== undefined) {
    flags.push(`@list(${row.list.name})`);
  }
  if (row.pagination !== undefined) {
    flags.push(`@paginate(${row.pagination.mode})`);
  }
  if (row.updates !== undefined) {
    flags.push(`@updates(${row.updates.join(',')})`);
  }
  if (row.kind === 'fragment' && Object.keys(row.arguments ?? {}).length > 0) {
    flags.push(`arguments=${JSON.stringify(row.arguments)}`);
  }
  return flags.length === 0 ? '' : `  ${flags.join(' ')}`;
}

/** One tree row: indentation, key, type and flags. */
function treeLine(row: ExplainSelection, depth: number): string {
  const indent = '  '.repeat(depth);
  const key = row.key.length >= KEY_COLUMN ? `${row.key} ` : row.key.padEnd(KEY_COLUMN);
  const type = row.kind === 'field' ? row.modifiers : `on ${orNone(row.type)}`;
  return `${indent}${key}${type}${flagsOf(row)}`;
}

/** The whole tree, depth first. */
function treeLines(rows: readonly ExplainSelection[], depth = 0): readonly string[] {
  return rows.flatMap((row) => [
    treeLine(row, depth),
    ...treeLines(row.fields ?? [], depth + 1),
  ]);
}

/** Every line `flamme explain` prints for one document. */
export function formatExplanation(explanation: DocumentExplanation): readonly string[] {
  const lines = [
    `${explanation.name} — ${explanation.kind}`,
    line('rootType', explanation.rootType),
    line('hash', explanation.hash),
    line('source', explanation.source),
    line('types', explanation.types.join(', ')),
    line('variables', orNone(explanation.variables.map(variableText).join(', '))),
    line('loading', orNone(explanation.loading ?? '')),
    line('policy', orNone(explanation.policy ?? '')),
    line('partial', explanation.partial === true ? 'true' : 'false'),
    line('lists', orNone(explanation.lists.map(listText).join(', '))),
    line('pagination', orNone(paginationText(explanation))),
  ];
  if (explanation.keys.length === 0) {
    lines.push(line('keys', '(none)'));
  } else {
    explanation.keys.forEach((entry, index) => {
      const path = entry.path.length === 0 ? '(root)' : entry.path.join('.');
      const fields = entry.fields.length === 0 ? '(none)' : entry.fields.join(', ');
      const injected = entry.injected ? ' [injected]' : '';
      const value = `${path}  ${entry.type}  ${fields}${injected}`;
      lines.push(index === 0 ? line('keys', value) : line('', value));
    });
  }
  lines.push('raw:');
  lines.push(
    ...explanation.raw
      .trimEnd()
      .split('\n')
      .map((text) => (text.length === 0 ? '' : `  ${text}`)),
  );
  lines.push('selection:');
  const tree = treeLines(explanation.selection);
  lines.push(...(tree.length === 0 ? ['  (none)'] : tree));
  return lines;
}

/** Every line `flamme refs` prints for one fragment. */
export function formatReferences(references: FragmentReferences): readonly string[] {
  const onType = references.definition?.onType ?? '';
  const lines = [
    `${references.fragment} — fragment${onType === '' ? '' : ` on ${onType}`}`,
    line(
      'definition',
      references.definition === undefined
        ? '(none)'
        : `${references.definition.file}:${references.definition.line}:${references.definition.column}`,
    ),
    line('spreads', String(references.references.length)),
  ];
  for (const entry of references.references) {
    lines.push(
      `  ${entry.document.padEnd(KEY_COLUMN)}${entry.file}:${entry.line}:${entry.column}  ${entry.kind}`,
    );
  }
  return lines;
}
