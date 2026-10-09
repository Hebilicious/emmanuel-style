/**
 * Route composition: one composed operation per route record
 * (`research/route-composition-design.md`).
 *
 * The unit of composition is a **route record**, not a navigation: a record's composed document is
 * the merge of its own primary query document with every ancestor record's, in chain order. A
 * navigation matches a chain of records and the deepest matched record's composition is a superset
 * of every other matched record's, so the generated `createComposedPageLoader` lets the longest
 * chain win and the navigation issues one request (§3.2).
 *
 * The composer produces **GraphQL text**, one query operation, and hands it to the ordinary
 * compiler pipeline: extract, validate, IR, emit. It adds no second printer and no second IR, so
 * every rule the compiler already enforces applies to the union for free. The merge rules:
 *
 * | case | rule |
 * | --- | --- |
 * | same response key, same field, identical printed arguments and the same `@include`/`@skip` condition | merge recursively |
 * | same response key, same field and arguments, different `@include`/`@skip` conditions | both occurrences print: merging them would copy one side's condition onto the other's field (§2.6) |
 * | same response key, different field or arguments | `FLM3013`, fall back to per-document loaders |
 * | same variable, different printed type | `FLM3011`, fall back |
 * | same variable, conflicting defaults | `FLM3013`, keep the first default |
 * | same explicit `@defer`/`@stream` label | `FLM3012`, fall back |
 * | two `@paginate` fields | `FLM3015`, fall back |
 * | `@cache(policy:)` | the maximum of the participants' effective policies |
 * | `@cache(partial:)` | the OR of the participants' values |
 * | `@dedupe` | copied when the participants agree, dropped with `FLM3014` when they do not (the composition still runs) |
 * | a participant baked `NetworkOnly`/`CacheAndNetwork` | `FLM3014` warning, the composition runs |
 *
 * A composed document has no file on disk: it travels to the compiler as a synthetic input (the
 * `routeDocuments` request member) and is emitted as a real artifact module at
 * `<runtimeDir>/artifacts/<Name>.ts`, excluded from the `$flamme` barrel and `ambient.d.ts`.
 */

import { join, relative } from 'node:path';

import {
  base36,
  createDiagnostic,
  fnv1a32,
  toPosix,
  type Diagnostic,
  type RawDocument,
  type ResolvedConfig,
  type SourceLocation,
} from '@flamme/core';
import {
  Kind,
  OperationTypeNode,
  print,
  type DirectiveNode,
  type FieldNode,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  type ValueNode,
  type VariableDefinitionNode,
} from 'graphql';

import {
  resolveRoutingConfig,
  type PlannedLoader,
  type PlannedRoute,
  type RoutePlan,
} from './routes-plan.js';
import { paramSources, type RouteParamSource } from './variables.js';

/** The composed operation of one route record, as the compiler receives it. */
export interface ComposedDocumentSource {
  /** The composed document name (§1.4), also the operation name and the artifact name. */
  readonly name: string;
  /** The composed GraphQL text, printed once by the composer. */
  readonly raw: string;
  /** The synthetic path relative to `projectDir`, for messages only. */
  readonly relativePath: string;
  /** The same path, absolute. Nothing reads or writes it. */
  readonly absolute: string;
  /** The participant document names, chain order. */
  readonly participants: readonly string[];
  /** The route record this composition belongs to. */
  readonly record: string;
  /** The file the record's own loader came from, or the nearest participant's (`FLM3011`-style). */
  readonly file: string;
}

/** What the generated module needs to know about one composing record. */
export interface ComposedRecord {
  /** The route record name. */
  readonly record: string;
  /** The composed artifact's name (`Route<...>_<hash>`). */
  readonly name: string;
  /** The participant document names, chain order: the runtime's arbitration key (§3.2). */
  readonly chain: readonly string[];
  /** The deduped union of the participants' param sources, against this record's own params. */
  readonly params: readonly RouteParamSource[];
}

/** What {@link planComposition} produced. */
export interface RouteComposition {
  /** One synthetic document per composing record. */
  readonly documents: readonly ComposedDocumentSource[];
  /** Composing record name -> its composition. A fallen-back record is absent. */
  readonly records: ReadonlyMap<string, ComposedRecord>;
  /**
   * `FLM3011`-`FLM3015`: what composition did or could not do for a record. A warning here is not
   * always a fallback (`FLM3013` on two variable defaults and both `FLM3014` meanings keep the
   * composition); a record that fell back is absent from `records`.
   */
  readonly warnings: readonly Diagnostic[];
  /** `FLM1032`: a composed name collides with a document, which fails the build. */
  readonly errors: readonly Diagnostic[];
}

/** The input of {@link planComposition}. */
export interface PlanCompositionInput {
  /** The route table, planned without artifacts. */
  readonly plan: RoutePlan;
  /** Every extracted document, as `extractProject` reports it. */
  readonly documents: readonly RawDocument[];
  /** The resolved compiler config; its `routing` member carries the conventions. */
  readonly config: ResolvedConfig;
}

/** One record of a chain, with the document it contributes. */
interface Participant {
  readonly record: string;
  readonly loader: PlannedLoader;
  readonly document: RawDocument;
}

/** One copied selection, with the participant document it came from. */
interface Sourced {
  readonly node: SelectionNode;
  readonly from: string;
}

/** A response-key conflict, as `FLM3013` describes it. */
interface Conflict {
  readonly key: string;
  readonly left: { readonly node: FieldNode; readonly from: string };
  readonly right: { readonly node: FieldNode; readonly from: string };
}

/** The cache policies, weakest first (`CacheOnly < CacheOrNetwork < CacheAndNetwork < NetworkOnly`). */
const CACHE_POLICIES = ['CacheOnly', 'CacheOrNetwork', 'CacheAndNetwork', 'NetworkOnly'] as const;

/** The synthetic documents directory under `runtimeDir`. */
export const COMPOSED_DIRECTORY = 'composed';

/**
 * The composed document name of a route record (§1.4):
 * `Route<Sanitized(recordName)>_<base36(fnv1a32(recordName), 6)>`.
 *
 * The hash covers the **record name alone**, so adding an unrelated route never renames an existing
 * composed artifact, and `Route` plus a sanitized name plus six alphanumerics is always a usable
 * TypeScript identifier and never a reserved word.
 */
export function composedDocumentName(record: string): string {
  const sanitized = record.replaceAll(/[^A-Za-z0-9_]/gu, '_');
  return `Route${sanitized}_${base36(fnv1a32(record), 6)}`;
}

/** Plans the composed document of every route record that has at least one participant. */
export function planComposition(input: PlanCompositionInput): RouteComposition {
  const routing = resolveRoutingConfig(input.config);
  if (routing.compose === 'document') {
    return { documents: [], records: new Map(), warnings: [], errors: [] };
  }
  const byName = new Map(input.plan.routes.map((route) => [route.name, route]));
  const documentsByName = new Map<string, RawDocument>();
  for (const document of input.documents) {
    // A composed document is never a participant and never a collision source: the composer runs
    // twice in one run (once to compile the documents, once to emit the route module), and the
    // second call sees what the first produced.
    if (document.surface === 'composed') {
      continue;
    }
    if (!documentsByName.has(document.name)) {
      documentsByName.set(document.name, document);
    }
  }

  const documents: ComposedDocumentSource[] = [];
  const records = new Map<string, ComposedRecord>();
  const warnings: Diagnostic[] = [];
  const errors: Diagnostic[] = [];
  const taken = new Set(documentsByName.keys());

  for (const route of input.plan.routes) {
    const participants = participantsOf(route, byName, documentsByName);
    if (participants.length === 0) {
      continue;
    }
    const name = composedDocumentName(route.name);
    if (taken.has(name)) {
      const collided = documentsByName.get(name);
      errors.push(
        createDiagnostic({
          code: 'FLM1032',
          severity: 'error',
          message:
            `The composed document name "${name}" collides with the document ` +
            `"${collided?.relativePath ?? name}"; rename that document (FLM1032).`,
          location: locationOf(participants[0]!.document, definitionOf(participants[0]!.document)),
        }),
      );
      continue;
    }
    const outcome = composeRecord({ route, participants, config: input.config });
    if (outcome.failure !== undefined) {
      warnings.push(outcome.failure);
      continue;
    }
    warnings.push(...outcome.warnings);
    taken.add(name);
    const absolute = join(input.plan.runtimeDir, COMPOSED_DIRECTORY, `${name}.composed.gql`);
    documents.push({
      name,
      raw: outcome.raw,
      relativePath: toPosix(relative(input.plan.projectDir, absolute)),
      absolute,
      participants: participants.map((participant) => participant.document.name),
      record: route.name,
      file: route.loaders[0]?.source ?? participants[0]!.document.relativePath,
    });
    records.set(route.name, {
      record: route.name,
      name,
      chain: participants.map((participant) => participant.document.name),
      params: unionParams(route, participants, routing, byName),
    });
  }

  return { documents, records, warnings, errors };
}

/** The records from the root down to `route`, inclusive. */
function chainOf(route: PlannedRoute, byName: ReadonlyMap<string, PlannedRoute>): PlannedRoute[] {
  const chain: PlannedRoute[] = [];
  const seen = new Set<string>();
  let current: PlannedRoute | undefined = route;
  while (current !== undefined && !seen.has(current.name)) {
    seen.add(current.name);
    chain.push(current);
    current = current.parent === undefined ? undefined : byName.get(current.parent);
  }
  return chain.toReversed();
}

/**
 * The participants of one record: its own primary query document merged with every ancestor
 * record's, in chain order, first occurrence per document name.
 *
 * A record with no document of its own still participates as a carrier: a page with no `+page.gql`
 * under a layout that has `+layout.gql` has the non-empty chain `[layoutDocument]` and gets a
 * composed loader for it. A record whose whole chain holds no query has an empty chain, gets no
 * composed loader and keeps `loaders: []`.
 */
function participantsOf(
  route: PlannedRoute,
  byName: ReadonlyMap<string, PlannedRoute>,
  documentsByName: ReadonlyMap<string, RawDocument>,
): readonly Participant[] {
  const seen = new Set<string>();
  const participants: Participant[] = [];
  for (const record of chainOf(route, byName)) {
    const loader = record.loaders[0];
    if (loader === undefined || seen.has(loader.document)) {
      continue;
    }
    const document = documentsByName.get(loader.document);
    if (document === undefined) {
      // The planner reported FLM3002 for it; a document the compiler never saw cannot be merged.
      continue;
    }
    seen.add(loader.document);
    participants.push({ record: record.name, loader, document });
  }
  return participants;
}

/** What one record's composition produced: the text, its warnings, or why it fell back. */
interface ComposeOutcome {
  readonly raw: string;
  readonly warnings: readonly Diagnostic[];
  /** The `FLM3011`/`FLM3012`/`FLM3013`/`FLM3015` warning that made the record fall back. */
  readonly failure: Diagnostic | undefined;
}

/** Merges one record's participants into one printed query operation. */
function composeRecord(input: {
  readonly route: PlannedRoute;
  readonly participants: readonly Participant[];
  readonly config: ResolvedConfig;
}): ComposeOutcome {
  const { route, participants, config } = input;
  const warnings: Diagnostic[] = [];
  const name = composedDocumentName(route.name);

  const variables = mergeVariables(route, participants, warnings);
  if (variables.failure !== undefined) {
    return { raw: '', warnings, failure: variables.failure };
  }
  const labels = labelConflict(route, participants);
  if (labels !== undefined) {
    return { raw: '', warnings, failure: labels };
  }
  const paginate = paginateConflict(route, participants);
  if (paginate !== undefined) {
    return { raw: '', warnings, failure: paginate };
  }
  const selections = mergeSelections(participants, explicitLabelNames(participants));
  if (selections.conflict !== undefined) {
    return {
      raw: '',
      warnings,
      failure: conflictWarning(route, participants, selections.conflict),
    };
  }
  const directives = mergeOperationDirectives(participants, config);
  if (directives.dedupeConflict) {
    // §2.7: the composed operation carries no `@dedupe` and the runtime default applies. The
    // request is still one per navigation, which is the point of composition, so the warning does
    // not fall the record back.
    warnings.push(dedupeConflictWarning(route, participants));
  }

  const operation: OperationDefinitionNode = {
    kind: Kind.OPERATION_DEFINITION,
    operation: OperationTypeNode.QUERY,
    name: { kind: Kind.NAME, value: name },
    variableDefinitions: variables.definitions,
    directives: directives.directives,
    selectionSet: { kind: Kind.SELECTION_SET, selections: selections.selections },
  };
  warnings.push(...policyWarnings(route, participants, config));
  return { raw: `${print(operation)}\n`, warnings, failure: undefined };
}

/* ------------------------------------------------------------------ variables (§2.2) */

/** The merged variable list, or the `FLM3011` warning that forbids the merge. */
function mergeVariables(
  route: PlannedRoute,
  participants: readonly Participant[],
  warnings: Diagnostic[],
): { readonly definitions: readonly VariableDefinitionNode[]; readonly failure?: Diagnostic } {
  const order: string[] = [];
  const byVariable = new Map<string, VariableDefinitionNode>();
  const owner = new Map<string, RawDocument>();
  for (const participant of participants) {
    for (const variable of definitionOf(participant.document).variableDefinitions ?? []) {
      const variableName = variable.variable.name.value;
      const existing = byVariable.get(variableName);
      if (existing === undefined) {
        order.push(variableName);
        byVariable.set(variableName, variable);
        owner.set(variableName, participant.document);
        continue;
      }
      const first = owner.get(variableName) ?? participant.document;
      const existingType = print(existing.type);
      const incomingType = print(variable.type);
      if (existingType !== incomingType) {
        // No type satisfies both declarations, and coercing one side changes what the other side's
        // server-visible argument means.
        return {
          definitions: [],
          failure: diag(route, 'FLM3011', first, existing, {
            message:
              `The route "${route.name}" composes "${first.relativePath}" and ` +
              `"${participant.document.relativePath}", which declare $${variableName} as ` +
              `${existingType} and ${incomingType}; the route keeps one request per document ` +
              '(FLM3011). Rename one variable or give the two documents the same type.',
            related: relatedAt(participant.document, variable),
          }),
        };
      }
      if (existing.defaultValue === undefined && variable.defaultValue !== undefined) {
        // A default makes the variable omittable; dropping it would turn today's "falls back to the
        // default" into a missing required variable.
        byVariable.set(variableName, variable);
      } else if (
        existing.defaultValue !== undefined &&
        variable.defaultValue !== undefined &&
        print(existing.defaultValue) !== print(variable.defaultValue)
      ) {
        // Two defaults disagree; the request can only send one, and the first participant's is the
        // outermost layout's, which is the more stable choice.
        warnings.push(
          diag(route, 'FLM3013', participant.document, variable, {
            message:
              `The route "${route.name}" composes "${first.relativePath}" and ` +
              `"${participant.document.relativePath}", which give $${variableName} the different ` +
              `defaults ${print(existing.defaultValue)} and ${print(variable.defaultValue)}; the ` +
              'route keeps the first declaration (FLM3013). Give the two documents one default.',
            related: relatedAt(first, byVariable.get(variableName)),
          }),
        );
      }
    }
  }
  return {
    definitions: order
      .map((variableName) => byVariable.get(variableName))
      .filter((variable): variable is VariableDefinitionNode => variable !== undefined),
  };
}

/* ------------------------------------------------------------------ labels (§2.3) */

/** `FLM3012` when two participants declare the same explicit label. */
function labelConflict(
  route: PlannedRoute,
  participants: readonly Participant[],
): Diagnostic | undefined {
  const seen = new Map<
    string,
    { readonly document: RawDocument; readonly node: SelectionNode; readonly directive: string }
  >();
  for (const participant of participants) {
    for (const entry of explicitLabels(participant.document)) {
      const existing = seen.get(entry.label);
      if (existing === undefined) {
        seen.set(entry.label, {
          document: participant.document,
          node: entry.node,
          directive: entry.directive,
        });
        continue;
      }
      // An explicit label is the author's handle: the generated `has<Label>` predicate is keyed by
      // it, so it is reported rather than rewritten.
      return diag(route, 'FLM3012', existing.document, existing.node, {
        message:
          `The route "${route.name}" composes "${existing.document.relativePath}" and ` +
          `"${participant.document.relativePath}", which both use the @${entry.directive} label ` +
          `"${entry.label}"; the route keeps one request per document (FLM3012). Rename one label, ` +
          'or drop the explicit label so the compiler derives one.',
        related: relatedAt(participant.document, entry.node),
      });
    }
  }
  return undefined;
}

/**
 * Every explicit `@defer`/`@stream` label a participant declares, in source order.
 *
 * The directive sits on a fragment spread (`...Parts @defer`), an inline fragment or a field
 * (`@stream`), so every selection that can carry directives is visited. Fragment **definitions**
 * are not: the composed document spreads a fragment once, so a label inside one cannot collide with
 * itself, and two fragments that declare the same label are the participant's own `FLM1026`.
 */
function explicitLabels(
  document: RawDocument,
): readonly { readonly label: string; readonly directive: string; readonly node: SelectionNode }[] {
  const found: { label: string; directive: string; node: SelectionNode }[] = [];
  visitSelections(definitionOf(document).selectionSet, (selection) => {
    for (const directive of selection.directives ?? []) {
      const directiveName = directive.name.value;
      if (directiveName !== 'defer' && directiveName !== 'stream') {
        continue;
      }
      const label = argumentOf(directive, 'label');
      if (label?.kind === Kind.STRING) {
        found.push({ label: label.value, directive: directiveName, node: selection });
      }
    }
  });
  return found;
}

/** Every explicit `@defer`/`@stream` label of every participant: labels a derived one must avoid. */
function explicitLabelNames(participants: readonly Participant[]): Set<string> {
  const taken = new Set<string>();
  for (const participant of participants) {
    for (const entry of explicitLabels(participant.document)) {
      taken.add(entry.label);
    }
  }
  return taken;
}

/**
 * Rewrites every unlabelled `@defer`/`@stream` of one participant to
 * `label: "<ParticipantDocumentName>_<n>"`, `n` counting the unlabelled targets of that participant
 * in source order and skipping every label already taken: explicit labels of **any** participant
 * first (they are the authors' handles), then the labels derived before it. Deterministic, stable
 * per participant and unique across the composed document.
 *
 * Attribution runs against the **request's** artifact, which is the composed one, and a
 * participant's own read derives its deferred state from the cache rather than from labels, so the
 * rewrite is invisible to the participant's own artifact.
 */
function rewriteLabels(document: RawDocument, taken: Set<string>): SelectionSetNode {
  return mapSelections(definitionOf(document).selectionSet, document.name, { value: 0 }, taken);
}

/* ------------------------------------------------------------------ @paginate (§2.4) */

/** `FLM3015` when two participants paginate a field: one paginated field per document. */
function paginateConflict(
  route: PlannedRoute,
  participants: readonly Participant[],
): Diagnostic | undefined {
  const paginated: { readonly document: RawDocument; readonly node: FieldNode }[] = [];
  for (const participant of participants) {
    visitFields(definitionOf(participant.document).selectionSet, (field) => {
      if ((field.directives ?? []).some((directive) => directive.name.value === 'paginate')) {
        paginated.push({ document: participant.document, node: field });
      }
    });
  }
  const first = paginated[0];
  const second = paginated[1];
  if (first === undefined || second === undefined) {
    return undefined;
  }
  return diag(route, 'FLM3015', second.document, second.node, {
    message:
      `The route "${route.name}" composes "${first.document.relativePath}" and ` +
      `"${second.document.relativePath}", which each paginate a field; a document paginates one ` +
      'field, so the route keeps one request per document (FLM3015). Keep one @paginate in the ' +
      'chain, or move the other document into a route group.',
    related: relatedAt(first.document, first.node),
  });
}

/* ------------------------------------------------------------------ selections (§2.1) */

/** The merged root selection set, or the response-key conflict that forbids the merge. */
function mergeSelections(
  participants: readonly Participant[],
  takenLabels: Set<string>,
): {
  readonly selections: readonly SelectionNode[];
  readonly conflict?: Conflict;
} {
  const state: { conflict: Conflict | undefined } = { conflict: undefined };
  const sets = participants.map((participant) =>
    rewriteLabels(participant.document, takenLabels).selections.map((node) => ({
      node,
      from: participant.document.name,
    })),
  );
  const selections = mergeSelectionSets(sets, [], state);
  return state.conflict === undefined ? { selections } : { selections, conflict: state.conflict };
}

/** One position of an accumulator: a field (mergeable) or anything else (copied verbatim). */
type Entry =
  | {
      readonly kind: 'field';
      readonly key: string;
      readonly node: FieldNode;
      readonly from: string;
    }
  | { readonly kind: 'other'; readonly node: SelectionNode };

/** One accumulated field occurrence. */
type FieldEntry = Extract<Entry, { kind: 'field' }>;

/**
 * Recursive union of selection sets in first-occurrence order.
 *
 * Fields with one response key merge when their printed arguments and directives agree **and** they
 * carry the same condition; a disagreement about the field or its arguments is a {@link Conflict}
 * and the record falls back. Two occurrences of one key with different `@include`/`@skip`
 * conditions are both legal and both selected (GraphQL `CollectFields` evaluates each occurrence on
 * its own), so they are printed verbatim rather than merged: merging them into one occurrence would
 * either copy one side's condition onto the other's field, or AND two conditions the server ORs.
 * Inline fragments and fragment spreads are copied verbatim, and a list-operation spread is dropped
 * when the same `(fragment, enclosing response-key path)` pair was already copied (§2.5).
 */
function mergeSelectionSets(
  sets: readonly (readonly Sourced[])[],
  path: readonly string[],
  state: { conflict: Conflict | undefined },
): readonly SelectionNode[] {
  const entries: Entry[] = [];
  /** Response key -> printed condition -> the occurrence copied for that condition. */
  const byKey = new Map<string, Map<string, FieldEntry>>();
  const spreads = new Set<string>();
  for (const set of sets) {
    for (const entry of set) {
      if (entry.node.kind !== Kind.FIELD) {
        if (
          entry.node.kind === Kind.FRAGMENT_SPREAD &&
          isListOperationSpread(entry.node.name.value)
        ) {
          const signature = `${path.join('.')}::${entry.node.name.value}`;
          if (spreads.has(signature)) {
            continue;
          }
          spreads.add(signature);
        }
        entries.push({ kind: 'other', node: entry.node });
        continue;
      }
      const field = entry.node;
      const key = field.alias?.value ?? field.name.value;
      const condition = conditionOf(field);
      const conditions = byKey.get(key);
      const existing = conditions?.get(condition);
      if (conditions !== undefined && existing !== undefined) {
        if (state.conflict !== undefined) {
          continue;
        }
        const conflict = fieldConflict(key, existing, entry);
        if (conflict !== undefined) {
          state.conflict = conflict;
          continue;
        }
        const index = entries.indexOf(existing);
        const merged: FieldEntry = {
          kind: 'field',
          key,
          node: mergeField(existing.node, existing.from, field, entry.from, key, path, state),
          from: existing.from,
        };
        conditions.set(condition, merged);
        entries[index] = merged;
        continue;
      }
      if (state.conflict !== undefined) {
        continue;
      }
      // A different condition on the same key: the occurrences print (they are legal GraphQL and
      // the server applies each condition). They still land in one response shape on the server, so
      // they may not conflict with each other either - at this level or in their sub-selections, or
      // `graphql.validate` rejects the composed document outright and the whole build fails where a
      // fallen-back record would have worked (§2.1).
      let conflict: Conflict | undefined;
      for (const candidate of conditions?.values() ?? []) {
        conflict = mergeConflict(candidate.node, candidate.from, field, entry.from, key, path);
        if (conflict !== undefined) {
          break;
        }
      }
      if (conflict !== undefined) {
        state.conflict = conflict;
        continue;
      }
      const created: FieldEntry = { kind: 'field', key, node: field, from: entry.from };
      const byCondition = conditions ?? new Map<string, FieldEntry>();
      byCondition.set(condition, created);
      byKey.set(key, byCondition);
      entries.push(created);
    }
  }
  return entries.map((entry) => entry.node);
}

/** `true` for the generated `<List>_insert`/`_remove`/`_toggle` operation spreads. */
function isListOperationSpread(name: string): boolean {
  return /_(?:insert|remove|toggle)$/u.test(name);
}

/** The conflict between two occurrences of one response key, or `undefined` when they merge. */
function fieldConflict(
  key: string,
  left: { readonly node: FieldNode; readonly from: string },
  right: Sourced,
): Conflict | undefined {
  if (right.node.kind !== Kind.FIELD) {
    return undefined;
  }
  const field = right.node;
  const sameField = left.node.name.value === field.name.value;
  const sameArguments = printArguments(left.node) === printArguments(field);
  if (sameField && sameArguments && directivesAgree(left.node, field)) {
    return undefined;
  }
  return {
    key,
    left: { node: left.node, from: left.from },
    right: { node: field, from: right.from },
  };
}

/**
 * The conflict two occurrences of one response key would raise if they were merged.
 *
 * The occurrences that print instead of merging because their conditions differ (see
 * {@link mergeSelectionSets}) still reach the server as one response shape, so their
 * sub-selections may not conflict either: a conflicting grandchild would be an
 * `OverlappingFieldsCanBeMerged` error (`FLM1007`, error severity) that fails the whole build,
 * where the composer's own `FLM3013` warning falls back to per-document loaders.
 */
function mergeConflict(
  left: FieldNode,
  leftFrom: string,
  right: FieldNode,
  rightFrom: string,
  key: string,
  path: readonly string[],
): Conflict | undefined {
  const direct = fieldConflict(
    key,
    { node: left, from: leftFrom },
    { node: right, from: rightFrom },
  );
  if (direct !== undefined) {
    return direct;
  }
  const state: { conflict: Conflict | undefined } = { conflict: undefined };
  mergeField(left, leftFrom, right, rightFrom, key, path, state);
  return state.conflict;
}

/** Merges two occurrences of one response key recursively. */
function mergeField(
  left: FieldNode,
  leftFrom: string,
  right: FieldNode,
  rightFrom: string,
  key: string,
  path: readonly string[],
  state: { conflict: Conflict | undefined },
): FieldNode {
  const leftSet = left.selectionSet;
  const rightSet = right.selectionSet;
  const selectionSet =
    leftSet === undefined || rightSet === undefined
      ? (leftSet ?? rightSet)
      : {
          kind: Kind.SELECTION_SET as const,
          selections: mergeSelectionSets(
            [
              leftSet.selections.map((node) => ({ node, from: leftFrom })),
              rightSet.selections.map((node) => ({ node, from: rightFrom })),
            ],
            [...path, key],
            state,
          ),
        };
  return {
    ...left,
    directives: unionDirectives(left.directives ?? [], right.directives ?? []),
    ...(selectionSet === undefined ? {} : { selectionSet }),
  };
}

/** The two directive lists merged, deduplicated by printed form. */
function unionDirectives(
  left: readonly DirectiveNode[],
  right: readonly DirectiveNode[],
): readonly DirectiveNode[] {
  const seen = new Set(left.map((directive) => print(directive)));
  const merged = [...left];
  for (const directive of right) {
    const text = print(directive);
    if (!seen.has(text)) {
      seen.add(text);
      merged.push(directive);
    }
  }
  return merged;
}

/** `true` for a directive whose condition decides whether one occurrence is collected. */
function isConditionDirective(directive: DirectiveNode): boolean {
  return directive.name.value === 'include' || directive.name.value === 'skip';
}

/**
 * The printed `@include`/`@skip` list of a field: the condition this occurrence is collected under.
 *
 * Two occurrences of one response key with the same condition merge; with different conditions they
 * both print (§2.6), which is why the condition is part of the accumulator's key.
 */
function conditionOf(field: FieldNode): string {
  return (field.directives ?? [])
    .filter(isConditionDirective)
    .map((directive) => print(directive))
    .join(' ');
}

/**
 * `true` when two fields carry compatible directives: every shared name prints the same.
 *
 * `@include`/`@skip` are excluded: they are the occurrence's own condition, compared by
 * {@link conditionOf}, and a difference there is a second occurrence to print rather than a
 * conflict.
 */
function directivesAgree(left: FieldNode, right: FieldNode): boolean {
  const leftByName = new Map(
    (left.directives ?? [])
      .filter((directive) => !isConditionDirective(directive))
      .map((directive) => [directive.name.value, print(directive)]),
  );
  for (const directive of right.directives ?? []) {
    if (isConditionDirective(directive)) {
      continue;
    }
    const existing = leftByName.get(directive.name.value);
    if (existing !== undefined && existing !== print(directive)) {
      return false;
    }
  }
  return true;
}

/** The printed argument list of a field, for the merge comparison. */
function printArguments(field: FieldNode): string {
  return (field.arguments ?? []).map((argument) => print(argument)).join(', ');
}

/* ------------------------------------------------------------------ operation directives (§2.7) */

/**
 * The merged operation directives, and whether the participants' `@dedupe` values conflict.
 *
 * A conflicting `@dedupe` is dropped, not fatal (§2.7): the composed operation carries none and the
 * runtime default applies, which is what the FLM3014 warning says.
 */
function mergeOperationDirectives(
  participants: readonly Participant[],
  config: ResolvedConfig,
): { readonly directives: readonly DirectiveNode[]; readonly dedupeConflict: boolean } {
  const definitions = participants.map((participant) => definitionOf(participant.document));
  const policies = participants.map((participant) => effectivePolicy(participant.document, config));
  const merged = policies.reduce((weakest, policy) =>
    CACHE_POLICIES.indexOf(policy) > CACHE_POLICIES.indexOf(weakest) ? policy : weakest,
  );
  const partial = participants.some((participant) =>
    effectivePartial(participant.document, config),
  );
  const cacheArguments: DirectiveNode['arguments'] = [
    ...(merged === config.defaultCachePolicy
      ? []
      : [
          {
            kind: Kind.ARGUMENT as const,
            name: { kind: Kind.NAME as const, value: 'policy' },
            value: { kind: Kind.ENUM as const, value: merged },
          },
        ]),
    ...(partial === config.defaultPartial
      ? []
      : [
          {
            kind: Kind.ARGUMENT as const,
            name: { kind: Kind.NAME as const, value: 'partial' },
            value: { kind: Kind.BOOLEAN as const, value: partial },
          },
        ]),
  ];
  const directives: DirectiveNode[] = [];
  if (cacheArguments.length > 0) {
    directives.push({
      kind: Kind.DIRECTIVE,
      name: { kind: Kind.NAME, value: 'cache' },
      arguments: cacheArguments,
    });
  }
  // `@loading` is definition-level: copied when any participant carries one.
  const loading = definitions
    .flatMap((definition) => definition.directives ?? [])
    .find((directive) => directive.name.value === 'loading');
  if (loading !== undefined) {
    directives.push(loading);
  }
  // `@dedupe` is a property of a request and there is now one request. A `cancelFirst: true`
  // copied from one participant would abort the whole composed request, which no author asked for,
  // so a conflict drops the directive (the runtime default applies) and warns FLM3014.
  const dedupes = definitions
    .flatMap((definition) => definition.directives ?? [])
    .filter((directive) => directive.name.value === 'dedupe');
  const distinct = [...new Set(dedupes.map((directive) => print(directive)))];
  const dedupeConflict = distinct.length > 1;
  if (!dedupeConflict && dedupes[0] !== undefined) {
    directives.push(dedupes[0]);
  }
  // Anything else on an operation (a directive the compiler does not model) is copied when the
  // participants agree, and left out rather than printed twice when they do not.
  const others = definitions
    .flatMap((definition) => definition.directives ?? [])
    .filter((directive) => !['cache', 'loading', 'dedupe'].includes(directive.name.value));
  for (const directiveName of new Set(others.map((directive) => directive.name.value))) {
    const matching = others.filter((directive) => directive.name.value === directiveName);
    const forms = [...new Set(matching.map((directive) => print(directive)))];
    if (forms.length === 1 && matching[0] !== undefined) {
      directives.push(matching[0]);
    }
  }
  return { directives, dedupeConflict };
}

/** A participant's effective cache policy: its `@cache(policy:)` or the config default. */
function effectivePolicy(
  document: RawDocument,
  config: ResolvedConfig,
): (typeof CACHE_POLICIES)[number] {
  const text = enumArgumentOf(definitionOf(document), 'cache', 'policy');
  return text === 'CacheOnly' ||
    text === 'CacheOrNetwork' ||
    text === 'CacheAndNetwork' ||
    text === 'NetworkOnly'
    ? text
    : config.defaultCachePolicy;
}

/** A participant's effective `partial`: its `@cache(partial:)` or the config default. */
function effectivePartial(document: RawDocument, config: ResolvedConfig): boolean {
  const value = definitionArgumentOf(definitionOf(document), 'cache', 'partial');
  return value?.kind === Kind.BOOLEAN ? value.value : config.defaultPartial;
}

/* ------------------------------------------------------------------ helpers */

/** The single operation definition of a participant document. */
function definitionOf(document: RawDocument): OperationDefinitionNode {
  const definition = document.ast.definitions.find(
    (entry): entry is OperationDefinitionNode => entry.kind === Kind.OPERATION_DEFINITION,
  );
  if (definition === undefined) {
    throw new Error(
      `compose-documents: "${document.relativePath}" is a participant but declares no operation.`,
    );
  }
  return definition;
}

/** One directive argument of a definition-level directive, by name. */
function definitionArgumentOf(
  definition: OperationDefinitionNode,
  directiveName: string,
  argumentName: string,
): ValueNode | undefined {
  const directive = (definition.directives ?? []).find(
    (entry) => entry.name.value === directiveName,
  );
  return directive?.arguments?.find((entry) => entry.name.value === argumentName)?.value;
}

/** One enum argument of a definition-level directive, as text. */
function enumArgumentOf(
  definition: OperationDefinitionNode,
  directiveName: string,
  argumentName: string,
): string | undefined {
  const value = definitionArgumentOf(definition, directiveName, argumentName);
  return value?.kind === Kind.ENUM ? value.value : undefined;
}

/** One directive argument, by name. */
function argumentOf(directive: DirectiveNode, name: string): ValueNode | undefined {
  return directive.arguments?.find((entry) => entry.name.value === name)?.value;
}

/** Visits every field of a selection set, depth first, source order. */
function visitFields(set: SelectionSetNode, visit: (field: FieldNode) => void): void {
  visitSelections(set, (selection) => {
    if (selection.kind === Kind.FIELD) {
      visit(selection);
    }
  });
}

/**
 * Visits every selection that can carry directives, depth first, source order: fields, fragment
 * spreads and inline fragments (a `@defer`/`@stream` label lives on the target, which may be any of
 * the three).
 */
function visitSelections(set: SelectionSetNode, visit: (selection: SelectionNode) => void): void {
  for (const selection of set.selections) {
    if (selection.kind === Kind.FIELD) {
      visit(selection);
      if (selection.selectionSet !== undefined) {
        visitSelections(selection.selectionSet, visit);
      }
      continue;
    }
    visit(selection);
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      visitSelections(selection.selectionSet, visit);
    }
  }
}

/**
 * Maps every selection of a selection set through the label rewrite: each unlabelled
 * `@defer`/`@stream` target (a fragment spread, an inline fragment or a field) gets
 * `label: "<document>_<n>"`, `n` the next free index in source order, and the label is recorded in
 * `taken` so no later target and no other participant derives it again.
 */
function mapSelections(
  set: SelectionSetNode,
  documentName: string,
  counter: { value: number },
  taken: Set<string>,
): SelectionSetNode {
  const rewrite = (directives: readonly DirectiveNode[]): readonly DirectiveNode[] =>
    directives.map((directive): DirectiveNode => {
      const directiveName = directive.name.value;
      if (directiveName !== 'defer' && directiveName !== 'stream') {
        return directive;
      }
      if (argumentOf(directive, 'label') !== undefined) {
        return directive;
      }
      let label: string;
      do {
        counter.value += 1;
        label = `${documentName}_${String(counter.value)}`;
      } while (taken.has(label));
      taken.add(label);
      return {
        ...directive,
        arguments: [
          ...(directive.arguments ?? []),
          {
            kind: Kind.ARGUMENT,
            name: { kind: Kind.NAME, value: 'label' },
            value: { kind: Kind.STRING, value: label },
          },
        ],
      };
    });
  return {
    kind: Kind.SELECTION_SET,
    selections: set.selections.map((selection): SelectionNode => {
      const directives = rewrite(selection.directives ?? []);
      if (selection.kind === Kind.FIELD) {
        return {
          ...selection,
          directives,
          ...(selection.selectionSet === undefined
            ? {}
            : {
                selectionSet: mapSelections(selection.selectionSet, documentName, counter, taken),
              }),
        };
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        return {
          ...selection,
          directives,
          selectionSet: mapSelections(selection.selectionSet, documentName, counter, taken),
        };
      }
      return { ...selection, directives };
    }),
  };
}

/** The record's own path pattern, for the param overrides: a route group uses its enclosing one. */
function pathPatternOf(route: PlannedRoute, byName: ReadonlyMap<string, PlannedRoute>): string {
  let current: PlannedRoute | undefined = route;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current.name)) {
    if (current.path !== '') {
      return current.path;
    }
    seen.add(current.name);
    current = current.parent === undefined ? undefined : byName.get(current.parent);
  }
  return route.path;
}

/** The deduped union of the participants' param sources, against this record's own params. */
function unionParams(
  route: PlannedRoute,
  participants: readonly Participant[],
  routing: ReturnType<typeof resolveRoutingConfig>,
  byName: ReadonlyMap<string, PlannedRoute>,
): readonly RouteParamSource[] {
  const pattern = pathPatternOf(route, byName);
  const params = route.params.map((param) => param.name);
  const seen = new Set<string>();
  const sources: RouteParamSource[] = [];
  for (const participant of participants) {
    for (const source of paramSources(
      pattern,
      participant.loader.variables,
      params,
      routing.params,
    )) {
      if (seen.has(source.variable)) {
        continue;
      }
      seen.add(source.variable);
      sources.push(source);
    }
  }
  return sources;
}

/** The `FLM3013` warning for a response-key conflict. */
function conflictWarning(
  route: PlannedRoute,
  participants: readonly Participant[],
  conflict: Conflict,
): Diagnostic {
  const left = participants.find((participant) => participant.document.name === conflict.left.from);
  const right = participants.find(
    (participant) => participant.document.name === conflict.right.from,
  );
  const leftDocument = left?.document ?? participants[0]!.document;
  const rightDocument = right?.document ?? participants[0]!.document;
  return diag(route, 'FLM3013', leftDocument, conflict.left.node, {
    message:
      `The route "${route.name}" composes "${leftDocument.relativePath}" and ` +
      `"${rightDocument.relativePath}", which both select the response key "${conflict.key}" for ` +
      `different fields or arguments ("${describeField(conflict.left.node)}" and ` +
      `"${describeField(conflict.right.node)}"); the route keeps one request per document ` +
      '(FLM3013). Alias one of the two selections.',
    related: relatedAt(rightDocument, conflict.right.node),
  });
}

/** The `FLM3014` warning for two participants declaring different `@dedupe` values. */
function dedupeConflictWarning(
  route: PlannedRoute,
  participants: readonly Participant[],
): Diagnostic {
  const declaring = participants.filter((participant) =>
    (definitionOf(participant.document).directives ?? []).some(
      (directive) => directive.name.value === 'dedupe',
    ),
  );
  const left = declaring[0]?.document ?? participants[0]!.document;
  const right = declaring[1]?.document ?? participants[0]!.document;
  return diag(route, 'FLM3014', left, definitionOf(left), {
    message:
      `The route "${route.name}" composes "${left.relativePath}" and "${right.relativePath}", which ` +
      'declare different @dedupe values; the composed request carries none and uses the runtime ' +
      'default (FLM3014). Match the two directives, or drop one.',
    related: relatedAt(right, definitionOf(right)),
  });
}

/** `FLM3014` for every participant whose policy always fetches (§3.3). */
function policyWarnings(
  route: PlannedRoute,
  participants: readonly Participant[],
  config: ResolvedConfig,
): readonly Diagnostic[] {
  const warnings: Diagnostic[] = [];
  for (const participant of participants) {
    const policy = effectivePolicy(participant.document, config);
    if (policy !== 'NetworkOnly' && policy !== 'CacheAndNetwork') {
      continue;
    }
    warnings.push(
      diag(route, 'FLM3014', participant.document, definitionOf(participant.document), {
        message:
          `The route "${route.name}" composes "${participant.document.relativePath}", whose @cache ` +
          `policy is ${policy}; a component-level read of it after the navigation issues its own ` +
          'request (FLM3014). Change the document to CacheOrNetwork, or read it through the route ' +
          'loader.',
      }),
    );
  }
  return warnings;
}

/** A field as a conflict message describes it (`alias: name(args)`). */
function describeField(field: FieldNode): string {
  const name =
    field.alias === undefined ? field.name.value : `${field.alias.value}: ${field.name.value}`;
  const args = printArguments(field);
  return args === '' ? name : `${name}(${args})`;
}

/** The `file:line:column` of one declaration, mapped back into the participant's own file. */
function locationOf(document: RawDocument, node: unknown): SourceLocation {
  const candidate: unknown =
    typeof node === 'object' && node !== null ? Reflect.get(node, 'loc') : undefined;
  const start: unknown =
    typeof candidate === 'object' && candidate !== null
      ? Reflect.get(candidate, 'start')
      : undefined;
  const loc = typeof start === 'number' ? { start } : undefined;
  if (loc === undefined || document.source === '') {
    return { file: document.relativePath, line: 1, column: 1, length: 1 };
  }
  const absolute = document.sourceOffsets[loc.start] ?? document.offset + loc.start;
  const before = document.source.slice(0, absolute);
  const line = before.split('\n').length;
  const column = absolute - (before.lastIndexOf('\n') + 1) + 1;
  return { file: document.relativePath, line, column, length: 1 };
}

/** The related location of a declaration in another participant. */
function relatedAt(document: RawDocument, node: unknown): SourceLocation {
  return locationOf(document, node);
}

/**
 * One composition warning, located at the offending declaration in a participant's own file.
 *
 * The codes are the router family's (`FLM3011`-`FLM3015`), the severity is always `warning`: each
 * participant is valid on its own and the fallback is correct, so failing the build would make a
 * previously working project uncompilable. `flamme check` reports it, so CI can promote it.
 */
function diag(
  route: PlannedRoute,
  code: `FLM${number}`,
  document: RawDocument,
  node: unknown,
  input: { readonly message: string; readonly related?: SourceLocation | undefined },
): Diagnostic {
  void route;
  return createDiagnostic({
    code,
    severity: 'warning',
    message: input.message,
    location: locationOf(document, node),
    ...(input.related === undefined
      ? {}
      : { related: [{ message: 'the other declaration', location: input.related }] }),
  });
}
