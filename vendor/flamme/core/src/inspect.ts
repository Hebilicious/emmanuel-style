/**
 * The read-only inspection surface `flamme explain` and `flamme refs` read
 * (`research/answers-report.md` Q1 option (d)).
 *
 * Everything here is a fold over what the compiler already produces: a
 * document's IR (`selection`, `raw`, `hash`, key injections, list and pagination
 * metadata) and the parsed source ASTs extraction keeps for diagnostics. No new
 * semantics and no schema re-read: an agent asking "what does this document
 * actually compile to" gets one answer instead of a 32KB generated artifact.
 */
import { Kind, type ASTNode, type DocumentNode, type SelectionSetNode } from 'graphql';

import type {
  ArtifactKind,
  CachePolicy,
  FieldSpec,
  GraphQLValue,
  LoadingSpec,
  ListSpec,
  PaginationSpec,
  RefetchSpec,
  SubscriptionSelection,
} from './contract.js';
import type { ResolvedConfig } from './config.js';
import type { Diagnostic, SourceLocation } from './diagnostics.js';
import { compileDocuments } from './generate.js';
import type { RawDocument } from './extract.js';
import type { IrDocument } from './ir.js';
import { compareNames } from './naming.js';
import { locationAt } from './offsets.js';
import type { SchemaIndex } from './schema.js';

/** One row of a document's selection tree. */
export interface ExplainSelection {
  /** Response key for a field, `...Name` for a spread, `on Type` for an inline fragment. */
  readonly key: string;
  readonly kind: 'field' | 'fragment' | 'inline';
  /** The value's GraphQL type name; the type condition for a spread or inline row. */
  readonly type: string;
  /** The full GraphQL type string (`[Species!]!`); empty on spread and inline rows. */
  readonly modifiers: string;
  /**
   * `true` when a masked read of the parent keeps this row. A masked spread's
   * fields are `false`, which is exactly what `readDocument` filters on.
   */
  readonly visible: boolean;
  /** `true` when the schema type is nullable. */
  readonly nullable: boolean;
  /** `true` when the field is one of its parent record's cache key fields. */
  readonly isKey?: boolean;
  /** The spread's fragment name; absent on field and inline rows. */
  readonly fragment?: string;
  /**
   * `true` on a spread row the compiler inlined instead of recording a
   * ` $fragments` reference (`@mask_disable`, §7.12): the fragment's fields are
   * the parent's own and no child composable can read them from this result.
   */
  readonly inlined?: boolean;
  /** The spread's evaluated arguments; absent on field and inline rows. */
  readonly arguments?: Readonly<Record<string, GraphQLValue>>;
  readonly loading?: LoadingSpec;
  readonly list?: ListSpec;
  readonly pagination?: PaginationSpec;
  readonly updates?: readonly ('append' | 'prepend')[];
  /** Field and inline rows of a field, in the order the artifact stores them. */
  readonly fields?: readonly ExplainSelection[];
}

/** One record a document reads, with the key fields that identify it. */
export interface ExplainKey {
  /** Selection path of the record; `[]` is the document root, `[]` marks list items. */
  readonly path: readonly string[];
  /** The record's GraphQL type name. */
  readonly type: string;
  /** The key fields the cache computes the record id from. */
  readonly fields: readonly string[];
  /** `true` when the compiler injected at least one of those fields here. */
  readonly injected: boolean;
}

/** One `@list` a document takes part in. */
export interface ExplainList {
  readonly name: string;
  /** The element type name. */
  readonly type: string;
  /** `true` when the list field is a connection (edges/pageInfo). */
  readonly connection: boolean;
}

/** One variable of a document. */
export interface ExplainVariable {
  readonly name: string;
  /** The GraphQL type string, e.g. `Int!`. */
  readonly type: string;
  readonly hasDefault: boolean;
}

/** Everything `flamme explain` reports about one document. */
export interface DocumentExplanation {
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly rootType: string;
  /** `sha256(raw)`; the same id the persisted-query manifest commits. */
  readonly hash: string;
  /** Project-relative posix path of the source file. */
  readonly source: string;
  /** The printed document (operation plus its transitive fragments). */
  readonly raw: string;
  readonly selection: readonly ExplainSelection[];
  readonly keys: readonly ExplainKey[];
  /** `@loading` on the document definition. */
  readonly loading?: 'local' | 'global';
  readonly policy?: CachePolicy;
  readonly partial?: boolean;
  /** The `@list` registrations the document's selection uses, sorted by name. */
  readonly lists: readonly ExplainList[];
  /** `@paginate` field paths, in document order. */
  readonly paginated: readonly (readonly string[])[];
  readonly refetch?: RefetchSpec;
  readonly variables: readonly ExplainVariable[];
  /** The names the generated artifact module exports for this document. */
  readonly types: readonly string[];
}

/** One place that spreads a fragment. */
export interface FragmentSpreadSite {
  /** Name of the document that contains the spread. */
  readonly document: string;
  readonly kind: ArtifactKind;
  /** Project-relative posix path of the source file. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** Where a fragment is defined. */
export interface FragmentDefinitionSite {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  /** The fragment's type condition. */
  readonly onType: string;
}

/** The reverse spread index of one fragment. */
export interface FragmentReferences {
  readonly fragment: string;
  /** Absent when no document defines the fragment. */
  readonly definition?: FragmentDefinitionSite;
  /** Every document that spreads it, sorted by `(file, line, column)`. */
  readonly references: readonly FragmentSpreadSite[];
}

/** What `explainDocumentOf` returns. */
export interface ExplainResult {
  /** Absent when no document has that name. */
  readonly explanation?: DocumentExplanation;
  /** Every document name in the project, sorted; the "did you mean" list. */
  readonly names: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

/** What `findReferences` returns. */
export interface ReferencesResult extends FragmentReferences {
  readonly diagnostics: readonly Diagnostic[];
}

/** The generated export names of one document (`Info$result`, `Info$artifact`, …). */
export function artifactTypeNames(name: string, kind: ArtifactKind): readonly string[] {
  return kind === 'fragment'
    ? [`${name}$data`, `${name}$key`, `${name}$artifact`]
    : [`${name}$result`, `${name}$input`, `${name}$unmasked`, `${name}$artifact`];
}

/** Explains one compiled document: identity, selection tree, keys and metadata. */
export function explainDocument(document: IrDocument, schema: SchemaIndex): DocumentExplanation {
  const keys: ExplainKey[] = [];
  if (schema.keyFieldsForType(document.rootType).length > 0) {
    keys.push(keyEntry(document, schema, [], document.rootType));
  }
  const context: ExplainContext = {
    document,
    schema,
    keys,
    spreads: astSpreads(document.document.ast),
  };
  const selection = selectionRows(context, document.selection, [], document.rootType);
  const variables = Object.entries(document.input.fields)
    .toSorted((a, b) => compareNames(a[0], b[0]))
    .map(([name, type]) => ({
      name,
      type,
      hasDefault: Object.hasOwn(document.input.defaults, name),
    }));
  return {
    name: document.name,
    kind: document.kind,
    rootType: document.rootType,
    hash: document.hash,
    source: document.source,
    raw: document.raw,
    selection,
    keys: dedupeKeys(keys),
    ...(document.enableLoadingState === undefined ? {} : { loading: document.enableLoadingState }),
    ...(document.policy === undefined ? {} : { policy: document.policy }),
    ...(document.partial === undefined ? {} : { partial: document.partial }),
    lists: listRegistrations(selection),
    paginated: document.paginated,
    ...(document.refetch === undefined ? {} : { refetch: document.refetch }),
    variables,
    types: artifactTypeNames(document.name, document.kind),
  };
}

/** Key entries unique by `(path, type)`, sorted by path then type. */
function dedupeKeys(keys: readonly ExplainKey[]): readonly ExplainKey[] {
  const seen = new Map<string, ExplainKey>();
  for (const entry of keys) {
    seen.set(`${entry.path.join('.')}|${entry.type}`, entry);
  }
  return [...seen.values()].toSorted(
    (a, b) => compareNames(a.path.join('.'), b.path.join('.')) || compareNames(a.type, b.type),
  );
}

/** Every `@list` registration the selection tree uses, sorted by list name. */
function listRegistrations(selection: readonly ExplainSelection[]): readonly ExplainList[] {
  const lists = new Map<string, ExplainList>();
  const visit = (rows: readonly ExplainSelection[]): void => {
    for (const row of rows) {
      if (row.list !== undefined) {
        lists.set(row.list.name, {
          name: row.list.name,
          type: row.list.type,
          connection: row.list.connection,
        });
      }
      if (row.fields !== undefined) {
        visit(row.fields);
      }
    }
  };
  visit(selection);
  return [...lists.values()].toSorted((a, b) => compareNames(a.name, b.name));
}

/** What every recursion of {@link selectionRows} shares. */
interface ExplainContext {
  readonly document: IrDocument;
  readonly schema: SchemaIndex;
  /** Key entries, collected as the tree is walked. */
  readonly keys: ExplainKey[];
  /** Fragment names spread at each selection path, from the source AST. */
  readonly spreads: ReadonlyMap<string, readonly string[]>;
}

/** The selection rows of one selection set, collecting the key fields it reads. */
function selectionRows(
  context: ExplainContext,
  selection: SubscriptionSelection,
  path: readonly string[],
  parentType: string,
): readonly ExplainSelection[] {
  const { document, schema, keys } = context;
  const rows: ExplainSelection[] = [];
  for (const [key, field] of Object.entries(selection.fields ?? {})) {
    const childPath = field.modifiers.includes(']') ? [...path, `${key}[]`] : [...path, key];
    if (field.selection !== undefined) {
      keys.push(keyEntry(document, schema, childPath, field.type));
    }
    rows.push(fieldRow(context, field, key, childPath, parentType));
  }
  // A spread the compiler did not record as a reference was inlined into this
  // selection (`@mask_disable`, §7.12). The IR no longer names it, so the source
  // AST is what keeps the tree showing the spread the author wrote.
  for (const fragment of context.spreads.get(path.join('.')) ?? []) {
    if (selection.fragments?.[fragment] !== undefined) {
      continue;
    }
    rows.push({
      key: `...${fragment}`,
      kind: 'fragment',
      type: document.fragmentTypes.get(fragment) ?? '',
      modifiers: '',
      visible: true,
      nullable: false,
      fragment,
      arguments: {},
      inlined: true,
    });
  }
  for (const [name, spec] of Object.entries(selection.fragments ?? {}).toSorted((a, b) =>
    compareNames(a[0], b[0]),
  )) {
    rows.push({
      key: `...${name}`,
      kind: 'fragment',
      type: document.fragmentTypes.get(name) ?? '',
      modifiers: '',
      visible: !spreadIsMasked(document, selection, name),
      nullable: false,
      fragment: name,
      arguments: spec.arguments,
      ...(spec.loading === true ? { loading: { kind: 'value' as const } } : {}),
    });
  }
  for (const [condition, nested] of Object.entries(selection.abstractFields ?? {}).toSorted((a, b) =>
    compareNames(a[0], b[0]),
  )) {
    keys.push(keyEntry(document, schema, path, condition));
    rows.push({
      key: `on ${condition}`,
      kind: 'inline',
      type: condition,
      modifiers: '',
      visible: true,
      nullable: false,
      fields: selectionRows(context, nested, path, condition),
    });
  }
  return rows;
}

/**
 * Fragment spreads per selection path, read from the document's own source AST.
 * Only the document's own definition is walked: a spread inside a fragment the
 * document merely references belongs to that fragment's own explanation.
 */
function astSpreads(ast: DocumentNode): ReadonlyMap<string, readonly string[]> {
  const spreads = new Map<string, string[]>();
  const visit = (set: SelectionSetNode | undefined, path: readonly string[]): void => {
    if (set === undefined) {
      return;
    }
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        visit(selection.selectionSet, [...path, selection.alias?.value ?? selection.name.value]);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        visit(selection.selectionSet, path);
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const key = path.join('.');
        spreads.set(key, [...(spreads.get(key) ?? []), selection.name.value]);
      }
    }
  };
  for (const definition of ast.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION || definition.kind === Kind.FRAGMENT_DEFINITION) {
      visit(definition.selectionSet, []);
    }
  }
  return spreads;
}

/** One field row, carrying the metadata the emitter recorded on the field. */
function fieldRow(
  context: ExplainContext,
  field: FieldSpec,
  key: string,
  path: readonly string[],
  parentType: string,
): ExplainSelection {
  return {
    key,
    kind: 'field',
    type: field.type,
    modifiers: field.modifiers,
    visible: field.visible !== false,
    nullable: field.nullable === true,
    ...(context.schema.keyFieldsForType(parentType).includes(key) ? { isKey: true } : {}),
    ...(field.loading === undefined ? {} : { loading: field.loading }),
    ...(field.list === undefined ? {} : { list: field.list }),
    ...(field.pagination === undefined ? {} : { pagination: field.pagination }),
    ...(field.updates === undefined ? {} : { updates: field.updates }),
    ...(field.selection === undefined
      ? {}
      : { fields: selectionRows(context, field.selection, path, field.type) }),
  };
}

/** True when the spread's inlined fields are hidden from the parent's own result. */
function spreadIsMasked(
  document: IrDocument,
  selection: SubscriptionSelection,
  name: string,
): boolean {
  const inner = document.fragmentSelections.get(name);
  return Object.keys(inner?.fields ?? {}).some((key) => selection.fields?.[key]?.visible === false);
}

/** One key-field entry for a record at `path`, marking compiler injections. */
function keyEntry(
  document: IrDocument,
  schema: SchemaIndex,
  path: readonly string[],
  type: string,
): ExplainKey {
  const fields = schema.keyFieldsForType(type);
  return {
    path,
    type,
    fields,
    injected: fields.some(
      (field) => document.injectedKeys.get([...path, field].join('.')) === type,
    ),
  };
}

/** Explains one document of a project by name; read-only, never throws. */
export async function explainDocumentOf(
  config: ResolvedConfig,
  name: string,
  options: { readonly fragment?: boolean } = {},
): Promise<ExplainResult> {
  const compiled = await compileDocuments(config);
  const document = compiled.documents.find(
    (entry) =>
      entry.name === name && (options.fragment !== true || entry.kind === 'fragment'),
  );
  return {
    ...(document === undefined || compiled.schema === undefined
      ? {}
      : { explanation: explainDocument(document, compiled.schema) }),
    names: compiled.documents.map((entry) => entry.name).toSorted(compareNames),
    diagnostics: compiled.diagnostics,
  };
}

/** The reverse spread index of one fragment; read-only, never throws. */
export async function findReferences(
  config: ResolvedConfig,
  fragment: string,
): Promise<ReferencesResult> {
  const compiled = await compileDocuments(config);
  return {
    ...findFragmentReferences(fragment, compiled.documents),
    diagnostics: compiled.diagnostics,
  };
}

/**
 * Every document and position that spreads `fragment`, plus its definition site.
 * Positions are mapped from the parsed document's offsets back into the source
 * file, so a spread inside a `graphql()` tag reports the line
 * and column an editor would.
 */
export function findFragmentReferences(
  fragment: string,
  documents: readonly IrDocument[],
): FragmentReferences {
  const references: FragmentSpreadSite[] = [];
  let definition: FragmentDefinitionSite | undefined;
  for (const document of documents) {
    for (const node of walk(document.document.ast)) {
      if (node.kind === Kind.FRAGMENT_SPREAD && node.name.value === fragment) {
        const where = locationOf(document, node);
        references.push({
          document: document.name,
          kind: document.kind,
          file: where.file,
          line: where.line,
          column: where.column,
        });
      }
      if (
        node.kind === Kind.FRAGMENT_DEFINITION &&
        node.name.value === fragment &&
        definition === undefined
      ) {
        const where = locationOf(document, node);
        definition = {
          file: where.file,
          line: where.line,
          column: where.column,
          onType: node.typeCondition.name.value,
        };
      }
    }
  }
  references.sort(
    (a, b) =>
      compareNames(a.file, b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      compareNames(a.document, b.document),
  );
  return {
    fragment,
    ...(definition === undefined ? {} : { definition }),
    references,
  };
}

/**
 * The absolute file offset of an offset in a document's own raw text, through its
 * source map (`file_offset_of` in `crates/flamme-core/src/validate.rs`, which the
 * diagnostics use).
 */
function fileOffsetOf(document: RawDocument, index: number): number {
  const limit = Math.max(0, document.sourceOffsets.length - 1);
  const clamped = Math.max(0, Math.min(index, limit));
  return document.sourceOffsets[clamped] ?? document.offset;
}

/** The location of one AST node inside the file the document came from. */
function locationOf(document: IrDocument, node: ASTNode): SourceLocation {
  const raw = document.document;
  const offset = fileOffsetOf(raw, node.loc?.start ?? 0);
  return locationAt(raw.source, raw.relativePath, offset);
}

/** Every node of one document's AST, recursively (nested fragment definitions included). */
function* walk(node: ASTNode): Generator<ASTNode> {
  yield node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isNode(entry)) {
          yield* walk(entry);
        }
      }
    } else if (isNode(value)) {
      yield* walk(value);
    }
  }
}

/** A GraphQL AST node, structurally: every node has a `kind`. */
function isNode(value: unknown): value is ASTNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly kind?: unknown }).kind === 'string'
  );
}
