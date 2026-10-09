/**
 * Pagination storage, page keys and the imperative page helpers (§6.8, §6.10).
 *
 * A page set is identified by a `PageKey` (`<artifact name>.<path>|<root key raw>`), and the page
 * *records* live in the ordinary cache: SinglePage keys each page by its own cursor arguments,
 * Infinite merges every page into one `::paginated` record. `cursorHandlers` owns the cursor
 * arithmetic and the cache-hit test; the network round trip is the client's, so the cache has no
 * transport dependency and stays framework-agnostic.
 */
import type {
  Artifact,
  FieldSpec,
  RecordId,
  SubscriptionSelection,
  Variables,
} from '../artifact.js';
import type { Client } from '../client.js';
import type { CacheConfig, ConnectionSnapshot, PageInfo } from '../cache.js';
import { UnknownPaginationError } from '../errors.js';
import type { PageKey, SerializedPage } from '../serialize.js';
import { asRecord, evaluateKey, isRecord, recordIdFor, responseKeyFor } from './keys.js';

/** The four cursor arguments, in the compiler's canonical order (§6.8). */
const CURSOR_ARGS = ['first', 'after', 'last', 'before'] as const;

type CursorArg = (typeof CURSOR_ARGS)[number];

/** The null page info a missing connection reads as (§6.8). */
export const NULL_PAGE_INFO: PageInfo = {
  startCursor: null,
  endCursor: null,
  hasNextPage: false,
  hasPreviousPage: false,
};

/** Where a paginated field lives: the record holding the connection link and the field itself. */
export interface LocatedConnection {
  readonly parentId: RecordId;
  readonly field: FieldSpec;
  readonly fieldKey: string;
}

/** `extractPageInfo(data, path)`: the page info of the connection at `path`, total (§6.8). */
export function extractPageInfo(data: unknown, path: readonly string[]): PageInfo {
  let current: unknown = data;
  for (const field of path) {
    const record = asRecord(current);
    if (record === null) {
      return NULL_PAGE_INFO;
    }
    current = record[field];
  }
  const connection = asRecord(current);
  if (connection === null) {
    return NULL_PAGE_INFO;
  }
  return pageInfoOfConnection(undefined, connection);
}

/**
 * `<artifact name>.<pagination path joined by '.'>|<evaluated root key raw>` (§6.10), or `null`
 * for an artifact with no `@paginate` field.
 */
export function pageKeyFor(artifact: Artifact, variables: Variables): PageKey | null {
  const refetch = artifact.refetch;
  const rootName = refetch?.path[0];
  if (refetch === undefined || rootName === undefined) {
    return null;
  }
  const rootField = artifact.selection.fields?.[rootName];
  if (rootField === undefined) {
    return null;
  }
  return `${artifact.name}.${refetch.path.join('.')}|${evaluateKey(rootField.keyRaw, variables)}`;
}

/** Finds the record and field spec a `refetch.path` addresses, following the parent's links. */
export function locateConnection(
  cache: { readonly storage: { getLink(recordId: RecordId, field: string): string | readonly string[] | null } },
  artifact: Artifact,
  variables: Variables,
): LocatedConnection | null {
  const path = artifact.refetch?.path;
  if (path === undefined || path.length === 0) {
    return null;
  }
  let selection: SubscriptionSelection = artifact.selection;
  let recordId: RecordId = '_ROOT_';
  for (const [index, name] of path.entries()) {
    const field = selection.fields?.[name];
    if (field === undefined) {
      return null;
    }
    const fieldKey = evaluateKey(field.keyRaw, variables);
    if (index === path.length - 1) {
      return { parentId: recordId, field, fieldKey };
    }
    const link = cache.storage.getLink(recordId, fieldKey);
    if (typeof link !== 'string') {
      return null;
    }
    recordId = link;
    selection = field.selection ?? {};
  }
  return null;
}

/** The cache surface the page helpers use; `Cache` satisfies it structurally. */
export interface PageCache {
  readonly config: CacheConfig;
  readonly storage: {
    resolve(
      recordId: RecordId,
      field: string,
    ): { readonly found: boolean; readonly link: boolean; readonly value: unknown };
    getLink(recordId: RecordId, field: string): string | readonly string[] | null;
  };
  read(options: {
    readonly selection: SubscriptionSelection;
    readonly parent: RecordId;
    readonly variables: Variables;
    readonly mask?: boolean;
  }): { readonly data: unknown; readonly partial: boolean };
}

/** Builds the current `ConnectionSnapshot` for an artifact's paginated field (§6.8). */
export function buildConnection(
  cache: PageCache,
  artifact: Artifact,
  variables: Variables,
): ConnectionSnapshot | null {
  const located = locateConnection(cache, artifact, variables);
  const path = artifact.refetch?.path;
  if (located === null || path === undefined || path.length === 0) {
    return null;
  }
  const name = path[path.length - 1] ?? '';
  const snapshot = readConnection(cache, located.parentId, name, located.field, located.fieldKey, variables);
  if (snapshot === null) {
    return null;
  }
  return { ...snapshot, path: [...path] };
}

/**
 * Reads the connection object at one parent/field pair and turns it into a `ConnectionSnapshot`
 * (`path` is filled in by the caller; `edges[].id` falls back to the connection record for an
 * embedded node type, §6.10).
 */
export function readConnection(
  cache: PageCache,
  parentId: RecordId,
  name: string,
  field: FieldSpec,
  fieldKey: string,
  variables: Variables,
): ConnectionSnapshot | null {
  const read = cache.read({
    selection: { fields: { [name]: field } },
    parent: parentId,
    variables,
    mask: false,
  });
  const data: Record<string, unknown> = isRecord(read.data) ? { ...read.data } : {};
  const connection = asRecord(data[name]);
  if (connection === null) {
    return null;
  }

  const resolved = cache.storage.resolve(parentId, fieldKey);
  const ids: RecordId[] = [];
  if (resolved.found && resolved.link) {
    if (typeof resolved.value === 'string') {
      ids.push(resolved.value);
    } else if (Array.isArray(resolved.value)) {
      ids.push(...resolved.value);
    }
  }
  const connectionId = ids[0] ?? parentId;

  return {
    path: [],
    ids,
    edges: buildEdges(cache.config, field, connection, connectionId),
    pageInfo: pageInfoOfConnection(field, connection),
    complete: !read.partial,
  };
}

/**
 * The connection's `pageInfo`: the standard entry when the selection says where it is, else the one
 * page-info-shaped value of the object (an aliased response key, `extractPageInfo`'s path-only call).
 */
function pageInfoOfConnection(
  field: FieldSpec | undefined,
  connection: Readonly<Record<string, unknown>>,
): PageInfo {
  const name = responseKeyFor(field?.selection, 'pageInfo');
  const direct = name === undefined ? connection['pageInfo'] : connection[name];
  if (asRecord(direct) !== null) {
    return pageInfoOf(direct);
  }
  if (name === undefined) {
    for (const value of Object.values(connection)) {
      const entry = asRecord(value);
      if (entry !== null && typeof entry['hasNextPage'] === 'boolean') {
        return pageInfoOf(entry);
      }
    }
  }
  return { ...NULL_PAGE_INFO };
}

/** The wire form of an in-memory connection snapshot, carrying the pagination mode (§6.10). */
export function toSerializedPage(page: ConnectionSnapshot, mode: 'SinglePage' | 'Infinite'): SerializedPage {
  return {
    path: [...page.path],
    ids: [...page.ids],
    edges: page.edges.map((edge) => ({ cursor: edge.cursor, id: edge.id })),
    pageInfo: { ...page.pageInfo },
    complete: page.complete,
    mode,
  };
}

/** The in-memory form of a hydrated page; `ids` falls back to the edge ids (§6.10). */
export function fromSerializedPage(page: SerializedPage): ConnectionSnapshot {
  return {
    path: [...page.path],
    ids: page.ids.length > 0 ? [...page.ids] : page.edges.map((edge) => edge.id),
    edges: page.edges.map((edge) => ({ cursor: edge.cursor, id: edge.id })),
    pageInfo: { ...page.pageInfo },
    complete: page.complete,
  };
}

/** Rewrites a connection field key's cursor arguments to the page's values (§6.8 SinglePage keys). */
export function rewriteCursorArgs(fieldKey: string, page: Variables): string {
  const open = fieldKey.indexOf('(');
  const close = fieldKey.lastIndexOf(')');
  const name = open < 0 ? fieldKey : fieldKey.slice(0, open);
  const inner = open < 0 || close < open ? '' : fieldKey.slice(open + 1, close);

  const args: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const entry of splitArgs(inner)) {
    if (isCursorArg(entry.name)) {
      seen.add(entry.name);
      args.push({ name: entry.name, value: literalOf(page[entry.name]) });
    } else {
      args.push(entry);
    }
  }
  // SinglePage keys carry all four cursor arguments, missing ones as null (§6.8)
  for (const arg of CURSOR_ARGS) {
    if (!seen.has(arg)) {
      args.push({ name: arg, value: literalOf(page[arg]) });
    }
  }
  return `${name}(${args.map((entry) => `${entry.name}: ${entry.value}`).join(', ')})`;
}

/** The variables a forward/backward page request is sent with. */
export function pageRequestVariables(
  variables: Variables,
  cursors: { first: number | null; after: string | null; last: number | null; before: string | null },
): Variables {
  return { ...variables, ...cursors };
}

/**
 * The imperative page helpers the Vue layer builds its handle on. Deliberately **not reactive**:
 * `runtime` has no Vue dependency (§2.2 rule 3).
 */
export function cursorHandlers(
  artifact: Artifact,
  client: Client,
): {
  loadNextPage(variables: Variables): Promise<void>;
  loadPreviousPage(variables: Variables): Promise<void>;
  nextCursor(variables: Variables): string | null;
  previousCursor(variables: Variables): string | null;
} {
  const cache = client.cache;
  const refetch = artifact.refetch;
  const pageSize = refetch?.pageSize ?? 0;

  const requireRefetch = (): void => {
    if (refetch === undefined) {
      throw new UnknownPaginationError(
        `Artifact "${artifact.name}" has no @paginate field, so it has no pages to load.`,
        artifact.name,
        { hint: 'add @paginate(mode: SinglePage) to the connection field the document reads' },
      );
    }
  };

  const current = (variables: Variables): ConnectionSnapshot | null => {
    requireRefetch();
    return buildConnection(cache, artifact, variables);
  };

  const loadPage = async (direction: 'forward' | 'backward', variables: Variables): Promise<void> => {
    requireRefetch();
    const connection = buildConnection(cache, artifact, variables);
    if (connection === null) {
      // nothing has been loaded yet: the document's own first page owns the connection
      return;
    }
    const forward = direction === 'forward';
    const available = forward ? connection.pageInfo.hasNextPage : connection.pageInfo.hasPreviousPage;
    // A `null` cursor with `hasNextPage: true` still fetches: the runtime keeps asking, and the
    // *Vue* handle is what reports the arrows as unusable (a stuck arrow must not look live,
    // `review-slice34-adversarial.md` M7, and the C5 behaviour below stays pinned).
    const cursor = forward ? connection.pageInfo.endCursor : connection.pageInfo.startCursor;
    if (!available) {
      return;
    }

    const pageVariables = pageRequestVariables(variables, {
      first: forward ? pageSize : null,
      after: forward ? cursor : null,
      last: forward ? null : pageSize,
      before: forward ? null : cursor,
    });

    // SinglePage keys every page by its cursor arguments, so an already-seen page is a cache hit:
    // adopting it performs no request at all (§6.8; back/forward navigation is free). Infinite
    // mode always fetches: its pages merge into one record, and `adoptPage` cannot answer "is this
    // page already here?" for a connection that is rebuilt in place, so asking it would let a
    // `true` (the snapshot simply moved) suppress the request the next page still needs.
    if ((refetch?.mode ?? 'SinglePage') === 'SinglePage') {
      if (cache.adoptPage(artifact, variables, { direction, pageVariables })) {
        return;
      }
    }

    if (forward) {
      await client.fetchNextPage(artifact, pageVariables);
    } else {
      await client.fetchPreviousPage(artifact, pageVariables);
    }
    cache.adoptPage(artifact, variables, { direction, pageVariables });
  };

  return {
    nextCursor: (variables) => {
      const info = current(variables)?.pageInfo;
      return info !== undefined && info.hasNextPage ? info.endCursor : null;
    },
    previousCursor: (variables) => {
      const info = current(variables)?.pageInfo;
      return info !== undefined && info.hasPreviousPage ? info.startCursor : null;
    },
    loadNextPage: async (variables) => {
      await loadPage('forward', variables);
    },
    loadPreviousPage: async (variables) => {
      await loadPage('backward', variables);
    },
  };
}

/** The `pageInfo` of a connection object, with the injected cursors defaulted to `null`. */
function pageInfoOf(value: unknown): PageInfo {
  const info = asRecord(value);
  if (info === null) {
    return { ...NULL_PAGE_INFO };
  }
  return {
    startCursor: typeof info['startCursor'] === 'string' ? info['startCursor'] : null,
    endCursor: typeof info['endCursor'] === 'string' ? info['endCursor'] : null,
    hasNextPage: info['hasNextPage'] === true,
    hasPreviousPage: info['hasPreviousPage'] === true,
  };
}

/** The `{ cursor, id }` list of a connection: `id` is the node's record, or the connection's. */
function buildEdges(
  config: CacheConfig,
  field: FieldSpec,
  connection: Readonly<Record<string, unknown>>,
  connectionId: RecordId,
): { cursor: string | null; id: RecordId }[] {
  // the payload is keyed by response key while the selection keeps the field name, so an aliased
  // `myEdges: edges` has to be located by name and indexed by its response key (C3)
  const edgesName = responseKeyFor(field.selection, 'edges');
  if (edgesName === undefined) {
    return [];
  }
  const raw = connection[edgesName];
  if (!Array.isArray(raw)) {
    return [];
  }
  const edgesField = field.selection?.fields?.[edgesName];
  const nodeName = responseKeyFor(edgesField?.selection, 'node');
  const cursorName = responseKeyFor(edgesField?.selection, 'cursor');
  const nodeSpec = nodeName === undefined ? undefined : edgesField?.selection?.fields?.[nodeName];
  const edges: { cursor: string | null; id: RecordId }[] = [];
  for (const entry of raw) {
    const edge = asRecord(entry);
    if (edge === null) {
      continue;
    }
    const cursorValue = cursorName === undefined ? undefined : edge[cursorName];
    const cursor = typeof cursorValue === 'string' ? cursorValue : null;
    const node = nodeName === undefined ? null : asRecord(edge[nodeName]);
    let id = connectionId;
    if (node !== null && nodeSpec !== undefined) {
      const type =
        nodeSpec.abstractFields !== undefined && typeof node['__typename'] === 'string'
          ? node['__typename']
          : nodeSpec.type;
      id = recordIdFor(config, type, node) ?? connectionId;
    }
    edges.push({ cursor, id });
  }
  return edges;
}

function isCursorArg(name: string): name is CursorArg {
  return (CURSOR_ARGS as readonly string[]).includes(name);
}

/** Splits `a: 1, b: "x, y"` into ordered `name: value` pairs, respecting strings and nesting. */
function splitArgs(inner: string): { name: string; value: string }[] {
  const args: { name: string; value: string }[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  const push = (end: number): void => {
    const chunk = inner.slice(start, end).trim();
    start = end + 1;
    if (chunk === '') {
      return;
    }
    const colon = chunk.indexOf(':');
    if (colon < 0) {
      return;
    }
    args.push({ name: chunk.slice(0, colon).trim(), value: chunk.slice(colon + 1).trim() });
  };
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (inString && char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      push(index);
    }
  }
  push(inner.length);
  return args;
}

/** The GraphQL literal spelling of a page-request variable value. */
function literalOf(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * `countPage`: how many entries the artifact's paginated field holds right now (§6.8).
 *
 * Houdini counts the connection's `edges`; Flamme's offset field *is* the array (the compiler puts
 * `updates: ['append']` on the field itself), so its length is the number of entries loaded.
 */
export function countPage(cache: PageCache, artifact: Artifact, variables: Variables): number {
  const located = locateConnection(cache, artifact, variables);
  if (located === null) {
    return 0;
  }
  const resolved = cache.storage.resolve(located.parentId, located.fieldKey);
  return resolved.found && Array.isArray(resolved.value) ? resolved.value.length : 0;
}

/** The offset page surface: `loadNextPage` only, with `limit`/`offset` request variables (§6.8). */
export interface OffsetHandlers {
  /** The offset the next page starts at. */
  offset(variables: Variables): number;
  /** Fetches and appends the next window. */
  loadNextPage(variables: Variables): Promise<void>;
}

/**
 * The imperative offset page helper the Vue layer builds its handle on.
 *
 * Houdini's `offsetHandlers` (`runtime/pagination.ts:416-545`) has no `loadPreviousPage` and no
 * `pageInfo`: an offset list has no cursors, so there is nothing to page backwards to. `getOffset`
 * is the current window length (all pages merged in Infinite mode, the current page in
 * `SinglePage`), falling back to the artifact's `pageSize`.
 */
export function offsetHandlers(artifact: Artifact, client: Client): OffsetHandlers {
  const cache = client.cache;
  const refetch = artifact.refetch;
  const pageSize = refetch?.pageSize ?? 0;
  /** The offset the last page load advanced to, so two clicks in a row advance twice. */
  let currentOffset: number | null = null;

  const requireRefetch = (): void => {
    if (refetch === undefined) {
      throw new UnknownPaginationError(
        `Artifact "${artifact.name}" has no @paginate field, so it has no pages to load.`,
        artifact.name,
        { hint: 'add @paginate to the list field the document reads' },
      );
    }
  };

  const offsetOf = (variables: Variables): number => {
    const loaded = countPage(cache, artifact, variables);
    // SinglePage keeps one page at a time, so the window start is the page's own offset plus the
    // document's current `offset`; Infinite merges every page, so the array length is the start.
    const start = loaded > 0 ? loaded : pageSize;
    if (refetch?.mode !== 'SinglePage') {
      return start;
    }
    const current = variables['offset'];
    return start + (typeof current === 'number' ? current : 0);
  };

  return {
    offset: (variables) => {
      requireRefetch();
      return currentOffset ?? offsetOf(variables);
    },
    loadNextPage: async (variables) => {
      requireRefetch();
      const offset = currentOffset ?? offsetOf(variables);
      const pageVariables: Variables =
        pageSize > 0
          ? // the page size comes from `limit` (the compiler records it as `refetch.pageSize`)
            { ...variables, offset, limit: pageSize }
          : { ...variables, offset };
      await client.fetchNextPage(artifact, pageVariables);
      currentOffset = offset + pageSize;
    },
  };
}
