/**
 * The document read/write helpers the client shares between the lifecycle, the cache subscription
 * and the plugins.
 *
 * They exist so there is exactly one place that knows how an artifact maps onto the cache (a masked
 * read rooted at `_ROOT_`, a write of the artifact's selection) and so the client never re-implements
 * a cache decision: record ids, embedded-vs-link, masking and invalidation all stay inside `cache/**`.
 *
 * `writeDocument` adds one pass on top of `cache.write`: the writer inlines a composite whose type
 * has no configured key *and stops there*, so a keyed record nested inside an embedded payload (the
 * PoC's `toggleFavorite { species { favorite } }`, where `ToggleFavoriteOutput` has no key) would
 * never reach the cache. The pass below re-writes exactly those nested records through
 * `cache.write`, one level of record per call, and never touches a record the main write already
 * walked. Once the cache recurses into embedded composites itself this pass becomes a no-op.
 */
import type {
  Artifact,
  ArtifactKind,
  RecordId,
  SubscriptionSelection,
  Variables,
} from './artifact.js';
import type { Cache, CacheLayer } from './cache.js';
import { asRecord, recordIdFor } from './cache/keys.js';
import { isIncluded } from './directives.js';
import { markLoadingFrame, Pending } from './loading.js';

/** Root fields live under this fixed record id (§6.1). */
export const ROOT_RECORD: RecordId = '_ROOT_';

/** The masked read of one document (or fragment) rooted at a record. */
export interface DocumentRead<TData> {
  readonly data: TData | null;
  readonly partial: boolean;
  readonly stale: boolean;
  readonly hasData: boolean;
}

export interface ReadDocumentOptions {
  readonly parent?: RecordId;
  /** Produce a loading frame instead of stored values (§7.1). */
  readonly loading?: boolean;
  /** Previous snapshot for structural sharing (§6.5 rule 1). */
  readonly previous?: unknown;
  readonly layer?: CacheLayer;
}

export interface WriteDocumentOptions {
  readonly parent?: RecordId;
  readonly layer?: CacheLayer;
  readonly applyUpdates?: readonly ('append' | 'prepend')[];
}

/** The one masked read of a document's selection, with structural sharing when `previous` is given. */
export function readDocument<TData>(
  cache: Cache,
  artifact: Artifact<ArtifactKind, TData>,
  variables: Variables,
  options: ReadDocumentOptions = {},
): DocumentRead<TData> {
  const result = cache.read<TData>({
    selection: artifact.selection,
    parent: options.parent ?? ROOT_RECORD,
    variables,
    ...(options.loading === undefined ? {} : { loading: options.loading }),
    ...(options.previous === undefined ? {} : { previous: options.previous }),
    ...(options.layer === undefined ? {} : { layer: options.layer }),
  });
  const stored: DocumentRead<TData> = {
    data: result.data,
    partial: result.partial,
    stale: result.stale,
    hasData: result.hasData,
  };
  if (options.loading === true || artifact.enableLoadingState === undefined) {
    return stored;
  }
  // A `@loading` artifact reads the stored value graph plus the frame, then fills only the fields
  // the stored read could not answer (§7.1). This is the client's `loading: 'missing'` mode: a
  // composite that has resolved stays a plain object even while a nested field is a frame, which is
  // the `continue` consequence the frame-only read cannot express.
  const frame = cache.read<TData>({
    selection: artifact.selection,
    parent: options.parent ?? ROOT_RECORD,
    variables,
    loading: true,
    ...(options.layer === undefined ? {} : { layer: options.layer }),
  });
  return {
    ...stored,
    // the merge walks the same selection the two reads used, so the merged value is the artifact's
    // own `TData`; the walk itself is untyped because it descends plain JSON containers
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the merge preserves the read's shape
    data: mergeLoadingView(stored.data, frame.data) as TData | null,
  };
}

/**
 * Fills only the fields the stored read is missing with the frame's placeholders. Every key the
 * stored read produced keeps its identity (structural sharing survives), and the stored container
 * itself is returned when the frame adds nothing.
 *
 * A container that ends up holding a placeholder of its own **is** a frame; one whose pending-ness
 * lives only in a nested field is not. That is the `continue` consequence of §7.1: `isPending`
 * answers "is this level loading?" at the level being rendered.
 */
function mergeLoadingView(stored: unknown, frame: unknown): unknown {
  if (stored === undefined || stored === null) {
    return frame;
  }
  if (frame === undefined || frame === null) {
    return stored;
  }
  if (Array.isArray(stored) && Array.isArray(frame)) {
    // a stored list has resolved, so its entries win outright: the frame's `@loading(count:)`
    // placeholder list never extends a list the cache already answered (§7.2)
    let changed = false;
    const out: unknown[] = stored.slice();
    const shared = Math.min(stored.length, frame.length);
    for (let index = 0; index < shared; index += 1) {
      const merged = mergeLoadingView(out[index], frame[index]);
      if (merged !== out[index]) {
        out[index] = merged;
        changed = true;
      }
    }
    return changed ? out : stored;
  }
  if (isPlainRecord(stored) && isPlainRecord(frame)) {
    let changed = false;
    const out: Record<string, unknown> = { ...stored };
    for (const [key, value] of Object.entries(frame)) {
      if (!(key in out)) {
        out[key] = value;
        changed = true;
        continue;
      }
      const merged = mergeLoadingView(out[key], value);
      if (merged !== out[key]) {
        out[key] = merged;
        changed = true;
      }
    }
    if (!changed) {
      return stored;
    }
    return hasDirectPlaceholder(out) ? markLoadingFrame(out) : out;
  }
  return stored;
}

/** `true` when a container holds a `Pending` placeholder directly, which is what a frame means. */
function hasDirectPlaceholder(value: Record<string, unknown>): boolean {
  return Object.values(value).some((entry) => entry instanceof Pending);
}

/** `true` for an object created by an object literal (never an array, never a `Pending`). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Writes one payload through the artifact's selection, then the records the main write inlined. */
export function writeDocument(
  cache: Cache,
  artifact: Artifact,
  data: unknown,
  variables: Variables,
  options: WriteDocumentOptions = {},
): void {
  const selection = artifact.selection;
  const parent = options.parent ?? ROOT_RECORD;
  cache.write({
    selection,
    parent,
    data,
    variables,
    ...(options.layer === undefined ? {} : { layer: options.layer }),
    ...(options.applyUpdates === undefined ? {} : { applyUpdates: options.applyUpdates }),
  });

  if (parent === ROOT_RECORD) {
    writeNestedRecords(cache, selection, data, variables, options);
  }
}

/**
 * The cache-plugin rule this pass mirrors: a composite is a record exactly when `recordIdFor`
 * returns an id. `inlinedParent` is `true` only below a composite the main write inlined, which is
 * the only case where a keyed child was skipped.
 */
function writeNestedRecords(
  cache: Cache,
  selection: SubscriptionSelection,
  data: unknown,
  variables: Variables,
  options: WriteDocumentOptions,
  inlinedParent = false,
): void {
  const record = asRecord(data);
  if (record === null) {
    return;
  }
  for (const [name, spec] of Object.entries(selection.fields ?? {})) {
    if (spec.selection === undefined || !Object.hasOwn(record, name)) {
      continue;
    }
    // a field a `@when`/`@when_not` spread contributed was not written by the main pass, so it must
    // not be walked here either: its nested records would otherwise reappear through the back door
    if (!isIncluded(spec, variables)) {
      continue;
    }
    const value = record[name];
    const elements = Array.isArray(value) ? value : [value];
    for (const element of elements) {
      const single = asRecord(element);
      if (single === null) {
        continue;
      }
      const type = typeof single['__typename'] === 'string' ? single['__typename'] : spec.type;
      const id = recordIdFor(cache.config, type, single);
      if (id === null) {
        // the main write inlined this value and stopped: its keyed descendants need their own write
        writeNestedRecords(cache, spec.selection, single, variables, options, true);
        continue;
      }
      if (inlinedParent) {
        cache.write({
          selection: spec.selection,
          parent: id,
          data: single,
          variables,
          ...(options.layer === undefined ? {} : { layer: options.layer }),
        });
      }
      writeNestedRecords(cache, spec.selection, single, variables, options, false);
    }
  }
}

/** The `partial` flag a store reports: `@cache(partial: true)` declares missing fields acceptable. */
export function reportPartial(partial: boolean, partialAllowed: boolean): boolean {
  return partial && !partialAllowed;
}
