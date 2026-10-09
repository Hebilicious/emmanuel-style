/**
 * Incremental delivery (`spec/spec.md` §7.13): the patch type, the merge into the normalized cache,
 * and the per-label delivery state a result carries.
 *
 * The wire format is the 20220824 `@defer`/`@stream` specification, which is what the request's
 * `accept: multipart/mixed; deferSpec=20220824, application/json` selects
 * (`network/incremental.ts` parses both that shape and the 2024 `pending`/`incremental`/`completed`
 * shape). A patch is normalized before it reaches this module, so the merge only ever sees
 * `{ path, data | items, label?, errors? }`.
 *
 * Two rules decide everything below:
 *
 * 1. **A patch merges, it never replaces.** `Cache.write` only writes the keys a payload actually
 *    carries, so a partial payload cannot delete a field the cache already holds, and a deferred
 *    fragment's ` $fragments` reference survives its fields arriving.
 * 2. **A patch that cannot be placed is dropped, not guessed.** If the path no longer resolves
 *    (the record was evicted, or the query was reset under the stream), the write is skipped and the
 *    caller hears about it: the label is still completed, and the result reports `partial: true`
 *    with the fields absent, which is the same state a cache miss produces.
 */
import type {
  Artifact,
  DeferredSpec,
  DeferredState,
  DeferredStatus,
  FieldSpec,
  RecordId,
  SubscriptionSelection,
  Variables,
} from './artifact.js';
import type { Cache } from './cache.js';
import type { GraphQLResponseError } from './client.js';
import { evaluateKey } from './cache/keys.js';
import { isPending } from './loading.js';
import { evaluateValue } from './directives.js';
import { ROOT_RECORD } from './reader.js';

/** The shared empty `deferred` state; identity matters because results are compared with `Object.is`. */
export const NO_DEFERRED: DeferredState = Object.freeze({});

/**
 * One normalized incremental payload. `path` is response keys with numeric array indices, exactly as
 * the server sent it; `data` is a deferred selection's fields merged at the object `path` names, and
 * `items` are list items appended at `path` (whose last element is the index of the first item when
 * the server sent one).
 */
export interface IncrementalPatch {
  readonly path: readonly (string | number)[];
  readonly data?: Readonly<Record<string, unknown>> | null;
  readonly items?: readonly unknown[] | null;
  readonly label?: string;
  readonly errors?: readonly GraphQLResponseError[];
  /** The payload's `hasNext`; `false` on the last patch of the response. */
  readonly hasNext: boolean;
}

/** What one patch did, so the caller can decide what to commit. */
export interface PatchOutcome {
  /** `true` when the patch's data reached the cache. */
  readonly applied: boolean;
  /** `true` when the patch's target path no longer resolves (the write was skipped). */
  readonly missingPath: boolean;
  /** The normalized patch. */
  readonly patch: IncrementalPatch;
}

/** `true` when `label` has been delivered for `result` (§7.13). */
export function isDeferred(
  result: { readonly deferred?: DeferredState | undefined },
  label: string,
): boolean {
  return result.deferred?.[label] === 'ready';
}

/** The labels a document declares, whether or not they are deferred under `variables`. */
export function deferredLabels(artifact: Artifact): readonly string[] {
  return (artifact.deferred ?? []).map((spec) => spec.label);
}

/**
 * The state to announce on the initial payload. When the server says `hasNext` every declared target
 * whose `if:` holds is `pending`; when it does not, the server answered the document in one part (a
 * server is allowed to ignore `@defer`), so every target is already `ready` and nothing is awaited.
 */
export function initialDeferredState(
  artifact: Artifact,
  variables: Variables,
  hasNext: boolean,
): DeferredState {
  const specs = artifact.deferred ?? [];
  if (specs.length === 0) {
    return NO_DEFERRED;
  }
  if (!hasNext) {
    return allReady(specs);
  }
  const state: Record<string, DeferredStatus> = {};
  for (const spec of specs) {
    if (spec.if !== undefined && evaluateValue(spec.if, variables) === false) {
      continue;
    }
    state[spec.label] = 'pending';
  }
  return Object.keys(state).length === 0 ? NO_DEFERRED : Object.freeze(state);
}

/**
 * The state a store starts from, before any response: a target is `ready` when the cache already
 * holds the keys its patch would deliver, and `pending` otherwise (§7.13).
 *
 * This is what makes hydration agree with the server's HTML. A server render that awaited the whole
 * stream wrote the deferred fields into the cache, so the hydrated client's first render reads them
 * as `ready` too; a server render that did not wait left them absent, and both sides render the
 * boundary's fallback.
 */
export function cacheDeferredState(
  cache: Cache,
  artifact: Artifact,
  variables: Variables,
): DeferredState {
  const specs = artifact.deferred ?? [];
  if (specs.length === 0) {
    return NO_DEFERRED;
  }
  const state: Record<string, DeferredStatus> = {};
  for (const spec of specs) {
    if (spec.if !== undefined && evaluateValue(spec.if, variables) === false) {
      continue;
    }
    state[spec.label] = deferredPresent(cache, artifact, variables, spec) ? 'ready' : 'pending';
  }
  return Object.keys(state).length === 0 ? NO_DEFERRED : Object.freeze(state);
}

/**
 * `true` when every key the target delivers is already on the object at its path.
 *
 * A key the cache does not hold is **not** delivered, and under `@loading` that is exactly the case
 * an unmasked read hides: a read reports a missing field as `null`, which is indistinguishable from
 * a delivered `null` unless the read is asked for one field at a time (`hasData` is `false` when the
 * only field in the selection was absent). A loading frame is the other face of the same thing — a
 * `@loading(count: 3)` document answers the absent field with placeholders — so a value that is
 * pending is absent too.
 */
function deferredPresent(
  cache: Cache,
  artifact: Artifact,
  variables: Variables,
  spec: DeferredSpec,
): boolean {
  const target = deferKeys(artifact.selection, spec);
  if (target.keys.length === 0) {
    return false;
  }
  const node = resolvePath(cache, artifact.selection, ROOT_RECORD, target.objectPath, variables);
  if (node === null) {
    return false;
  }
  return target.keys.every((key) => fieldPresent(cache, node, variables, key));
}

/** `true` when one field of a resolved target object holds a delivered value. */
function fieldPresent(
  cache: Cache,
  node: ResolvedNode,
  variables: Variables,
  key: string,
): boolean {
  const field = node.selection.fields?.[key];
  if (field === undefined) {
    return false;
  }
  const read = cache.read<Record<string, unknown>>({
    selection: { fields: { [key]: field } },
    parent: node.recordId,
    variables,
    mask: false,
  });
  return read.hasData && !isPending(read.data?.[key]);
}

/** The object a target's fields live on and the response keys its patch delivers. */
export function deferKeys(
  selection: SubscriptionSelection,
  spec: DeferredSpec,
): { readonly objectPath: readonly string[]; readonly keys: readonly string[] } {
  if (spec.kind === 'list') {
    const field = spec.path.at(-1);
    return { objectPath: spec.path.slice(0, -1), keys: field === undefined ? [] : [field] };
  }
  let current: SubscriptionSelection | undefined = selection;
  for (const part of spec.path) {
    current = current?.fields?.[part]?.selection;
  }
  const keys: string[] = [];
  for (const [key, field] of Object.entries(current?.fields ?? {})) {
    if (field.defer?.label === spec.label) {
      keys.push(key);
    }
  }
  return { objectPath: spec.path, keys };
}

/** Every declared label, `ready`. */
function allReady(specs: readonly DeferredSpec[]): DeferredState {
  const state: Record<string, DeferredStatus> = {};
  for (const spec of specs) {
    state[spec.label] = 'ready';
  }
  return Object.freeze(state);
}

/**
 * The state after one patch. A `@defer` patch completes its target outright; a `@stream` patch does
 * not, because more items may follow — that target completes on the payload whose `hasNext` is
 * `false`, which is what "the list is complete" means on this wire.
 */
export function advanceDeferredState(
  current: DeferredState,
  artifact: Artifact,
  patch: IncrementalPatch,
): DeferredState {
  const specs = artifact.deferred ?? [];
  if (specs.length === 0) {
    return current;
  }
  const spec = matchDeferred(specs, patch);
  if (spec === undefined || current[spec.label] === 'ready') {
    return current;
  }
  if (spec.kind === 'list' && patch.hasNext) {
    return current;
  }
  return Object.freeze({ ...current, [spec.label]: 'ready' });
}

/**
 * The target a patch belongs to: the label the server echoed when there is one, else the target at
 * that path and kind. Matching on the path as well is what lets a server that omits `label:` still
 * complete the right target, and what disambiguates two unlabelled targets.
 */
export function matchDeferred(
  specs: readonly DeferredSpec[],
  patch: IncrementalPatch,
): DeferredSpec | undefined {
  if (patch.label !== undefined) {
    const byLabel = specs.find((spec) => spec.label === patch.label);
    if (byLabel !== undefined) {
      return byLabel;
    }
  }
  const kind = patch.items === undefined ? 'fragment' : 'list';
  const path = (patch.items === undefined ? patch.path : listFieldPath(patch.path)).map(String);
  return specs.find((spec) => spec.kind === kind && samePath(spec.path, path));
}

/** The response-key path of the list field an `items` patch belongs to. */
function listFieldPath(path: readonly (string | number)[]): readonly string[] {
  const parts = trimIndex(path);
  return parts.map((part) => String(part));
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

/** Drops a trailing numeric index (the first item a stream patch delivers). */
function trimIndex(path: readonly (string | number)[]): readonly (string | number)[] {
  const last = path.at(-1);
  return typeof last === 'number' ? path.slice(0, -1) : path;
}

/**
 * Merges one patch into the cache (§7.13). A deferred selection's fields are written against the
 * selection at `path`, which is the object the server merged them into; `$fragments` markers on that
 * object are written by the *read*, so a child fragment sees a real reference before its fields exist.
 */
export function applyIncrementalPatch(
  cache: Cache,
  artifact: Artifact,
  variables: Variables,
  patch: IncrementalPatch,
): PatchOutcome {
  if (patch.items !== undefined && patch.items !== null) {
    return applyItemsPatch(cache, artifact, variables, patch);
  }
  if (patch.data === undefined || patch.data === null) {
    // an errors-only patch (or a `completed` marker): nothing to write, the caller keeps the errors
    return { applied: false, missingPath: false, patch };
  }
  const node = resolvePath(cache, artifact.selection, ROOT_RECORD, patch.path, variables);
  if (node === null) {
    return { applied: false, missingPath: true, patch };
  }
  cache.write({
    selection: node.selection,
    parent: node.recordId,
    data: patch.data,
    variables,
  });
  return { applied: true, missingPath: false, patch };
}

/** Appends `items` to the list field the patch names, keeping what the cache already holds. */
function applyItemsPatch(
  cache: Cache,
  artifact: Artifact,
  variables: Variables,
  patch: IncrementalPatch,
): PatchOutcome {
  const items = patch.items ?? [];
  const path = trimIndex(patch.path);
  const fieldKey = path.at(-1);
  if (fieldKey === undefined) {
    return { applied: false, missingPath: true, patch };
  }
  const parent = resolvePath(cache, artifact.selection, ROOT_RECORD, path.slice(0, -1), variables);
  const spec = parent?.selection.fields?.[String(fieldKey)];
  if (parent === null || spec === undefined) {
    return { applied: false, missingPath: true, patch };
  }
  const current = readFieldValue(cache, parent.recordId, String(fieldKey), spec, variables);
  const startIndex = startIndexOf(patch.path);
  const next = insertItems(current, items, startIndex);
  cache.write({
    selection: { fields: { [String(fieldKey)]: spec } },
    parent: parent.recordId,
    data: { [String(fieldKey)]: next },
    variables,
  });
  return { applied: true, missingPath: false, patch };
}

/** The index a stream patch starts at, when the server sent one (20220824 does). */
function startIndexOf(path: readonly (string | number)[]): number | undefined {
  const last = path.at(-1);
  return typeof last === 'number' ? last : undefined;
}

/**
 * Splices `items` into `current` at `startIndex`, appending when the server sent no index or when
 * the index is past the end (an out-of-order patch, or a stream the cache has not caught up with).
 * The result is the list the cache should hold; an item already at that position is replaced only
 * when the patch covers it, which is what a re-sent patch does.
 */
export function insertItems(
  current: unknown,
  items: readonly unknown[],
  startIndex: number | undefined,
): readonly unknown[] {
  const list = Array.isArray(current) ? [...current] : [];
  if (startIndex === undefined || startIndex >= list.length) {
    return [...list, ...items];
  }
  list.splice(Math.max(0, startIndex), items.length, ...items);
  return list;
}

/** The current value of one field, through the cache's own read (masking off: this is a merge). */
function readFieldValue(
  cache: Cache,
  recordId: RecordId,
  fieldKey: string,
  spec: FieldSpec,
  variables: Variables,
): unknown {
  const read = cache.read<Record<string, unknown>>({
    selection: { fields: { [fieldKey]: spec } },
    parent: recordId,
    variables,
    mask: false,
  });
  return read.data?.[fieldKey];
}

/** A resolved position inside the artifact's selection tree. */
interface ResolvedNode {
  readonly recordId: RecordId;
  readonly selection: SubscriptionSelection;
}

/**
 * Walks `path` from `parent`, resolving each step through the storage's links. A numeric step is an
 * index into a link array (a deferred fragment under a list, `@defer` inside `evolution_chain`).
 * Returns `null` as soon as a step does not resolve, which is the "path the cache no longer holds"
 * case the caller reports.
 */
function resolvePath(
  cache: Cache,
  selection: SubscriptionSelection,
  parent: RecordId,
  path: readonly (string | number)[],
  variables: Variables,
): ResolvedNode | null {
  let current: ResolvedNode = { recordId: parent, selection };
  let index = 0;
  while (index < path.length) {
    const part: string | number | undefined = path[index];
    if (part === undefined || typeof part === 'number') {
      // a numeric step is only meaningful directly after the field that holds the array
      return null;
    }
    const spec: FieldSpec | undefined = current.selection.fields?.[part];
    if (spec === undefined || spec.selection === undefined) {
      return null;
    }
    const link = cache.storage.getLink(current.recordId, evaluateKey(spec.keyRaw, variables));
    const element = path[index + 1];
    if (typeof element === 'number') {
      const id = Array.isArray(link) ? link[element] : undefined;
      if (typeof id !== 'string') {
        return null;
      }
      current = { recordId: id, selection: spec.selection };
      index += 2;
      continue;
    }
    if (typeof link !== 'string') {
      return null;
    }
    current = { recordId: link, selection: spec.selection };
    index += 1;
  }
  return current;
}
