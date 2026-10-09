/**
 * Filesystem routing conventions (`research/routing-report.md`, REQ-1).
 *
 * A directory of Vue files is the route table. This module owns the two halves of that contract that
 * are pure string work: which files are pages/layouts/documents, and what route path and params one
 * page file produces.
 *
 * ## File patterns
 *
 * | file                              | route path        | params        |
 * | --------------------------------- | ----------------- | ------------- |
 * | `index.vue`                       | the directory     | none          |
 * | `[id].vue` / `:id.vue`            | `/<dir>/:id`      | required `id` |
 * | `[[id]].vue` / `:id?.vue`         | `/<dir>/:id?`     | optional `id` |
 * | `404.vue` / `[...notFound].vue`   | `/:pathMatch(.*)*`| `pathMatch`   |
 * | `about.vue`                       | `/<dir>/about`    | none          |
 * | `+layout.vue`                     | wraps the directory's pages through a nested `router-view` |
 * | `+page.gql`                       | the colocated query document of the page beside it |
 * | `+layout.gql`                     | the colocated query document of the layout beside it |
 * | `(name)/+page.vue`                | a **route group**: a pathless nested record of the enclosing route |
 * | `(name)/+page.gql` / `(name)/+page.ts` | the group's own document, compiled like any page document |
 * | `(name)/+layout.vue`              | composed around the group's page component |
 *
 * `[param]` is the canonical spelling (the Remix/SvelteKit one); `:param` is accepted as an alias
 * because it is the vue-router spelling. A directory whose name is dynamic nests like any other:
 * `pokemon/[id].vue` is `/pokemon/:id`.
 *
 * A directory whose name is wrapped in parentheses is a **route group**: it contributes no URL
 * segment and declares a nested, pathless record of the URL of the route it sits in. It needs that
 * route's record to nest under, so a top-level group nests under the root `index.vue` and a group
 * whose enclosing directory has no record is `FLM3009` rather than a root record at `''`. See
 * {@link groupNameOf} and {@link nameOfGroup}.
 */

/** One dynamic path segment parsed from a file or directory name. */
export interface RouteSegment {
  /** The parameter name, without brackets or colons. */
  readonly name: string;
  /** `true` for `[[id]]` / `:id?`: the segment may be absent from the URL. */
  readonly optional: boolean;
  /** `true` for the `[...rest]` catch-all spelling. */
  readonly catchAll: boolean;
}

/** Every file extension a page or a layout may carry. */
export const PAGE_EXTENSIONS = ['.vue'] as const;

/** The layout file name; it wraps its directory's pages. */
export const LAYOUT_FILE = '+layout.vue';

/** The catch-all file names, in the order they are tried. */
export const NOT_FOUND_FILES = ['404.vue', '[...notFound].vue'] as const;

/** The default colocated document file name for a page. */
export const PAGE_DOCUMENT_FILE = '+page.gql';

/** The default colocated document file name for a layout. */
export const LAYOUT_DOCUMENT_FILE = '+layout.gql';

/** The component file a route group declares; it is required. */
export const GROUP_PAGE_FILE = '+page.vue';

/** A route-group directory: `(name)`, with the name captured. */
const GROUP_DIRECTORY = /^\(([^()/]+)\)$/u;

/**
 * The name of a route-group directory (`(types)` is `types`), or `undefined` for any other name.
 *
 * A route group contributes **no URL segment**: it declares a nested, pathless route record for the
 * URL of the route it sits in. Its `+page.gql`/`+page.ts` is compiled exactly like any other page
 * document (same variables, same route-param coercion by name) and its `+page.vue` renders the
 * section, reading its own loader with `usePageQuery()` and no argument.
 */
export function groupNameOf(directory: string): string | undefined {
  return GROUP_DIRECTORY.exec(directory)?.[1];
}

/** `true` for a `(name)` route-group directory. */
export function isGroupDirectory(directory: string): boolean {
  return groupNameOf(directory) !== undefined;
}

/**
 * The route name of one group record: the enclosing record's name and the group's own directory.
 *
 * Deterministic and derived from the file tree, like every other name in the table
 * (`[[id]]/(types)`, `index/(auth)`, `x/(a)/(b)`), so the generated module is stable. A group with
 * no enclosing record is `FLM3009` and plans nothing, so the bare `(name)` spelling is a fallback
 * the planner never emits.
 */
export function nameOfGroup(parent: string | undefined, group: string): string {
  return parent === undefined ? `(${group})` : `${parent}/(${group})`;
}

/**
 * The handle of a **retired** named-document file (`+page.<handle>.gql`), or `undefined`.
 *
 * `+page.<handle>.gql` and `+layout.<handle>.gql` were removed in favour of route groups. The
 * pattern is still recognised so the planner can report `FLM3007` naming the group the document
 * belongs in; it never produces a loader.
 */
export function retiredDocumentHandle(file: string, documentFile: string): string | undefined {
  if (file === documentFile) {
    return undefined;
  }
  const at = documentFile.lastIndexOf('.');
  const stem = at <= 0 ? documentFile : documentFile.slice(0, at);
  const extension = at <= 0 ? '' : documentFile.slice(at);
  const prefix = `${stem}.`;
  if (!file.startsWith(prefix) || !file.endsWith(extension)) {
    return undefined;
  }
  const end = extension.length === 0 ? file.length : file.length - extension.length;
  const handle = file.slice(prefix.length, end);
  return /^[A-Za-z0-9_]+$/u.test(handle) ? handle : undefined;
}

/** The default pages directory, relative to the project root. */
export const DEFAULT_PAGES_DIR = 'src/pages';

/** The route name the catch-all record gets. */
export const NOT_FOUND_ROUTE_NAME = 'not-found';

/** The parameter a catch-all record declares. */
export const CATCH_ALL_PARAM = 'pathMatch';

/** Splits a posix path into its directory and file name. */
function splitPath(path: string): { readonly dir: string; readonly file: string } {
  const at = path.lastIndexOf('/');
  return at === -1 ? { dir: '', file: path } : { dir: path.slice(0, at), file: path.slice(at + 1) };
}

/** `true` for the catch-all file names (`404.vue`, `[...notFound].vue`). */
export function isNotFoundFile(file: string): boolean {
  return (NOT_FOUND_FILES as readonly string[]).includes(file);
}

/** `true` for a `+layout.vue` at any depth. */
export function isLayoutFile(file: string): boolean {
  return file === LAYOUT_FILE;
}

/**
 * Parses one file or directory name into its route segment, or returns `undefined` for a static
 * name. Both spellings are recognised: `[id]`/`[[id]]`/`[...rest]` and `:id`/`:id?`/`:rest(.*)`.
 */
export function parseSegment(name: string): RouteSegment | undefined {
  const bracket = /^\[(\[)?(\.\.\.)?([^\][]+?)\]\]?$/.exec(name);
  if (bracket !== null) {
    const optional = bracket[1] === '[' && name.endsWith(']]');
    const catchAll = bracket[2] === '...';
    const param = bracket[3];
    if (param === undefined || param.length === 0) {
      return undefined;
    }
    return { name: param, optional: optional && !catchAll, catchAll };
  }
  const colon = /^:(.+?)(\(\*\)|\*)?(\?)?$/.exec(name);
  if (colon !== null) {
    const param = colon[1];
    if (param === undefined || param.length === 0) {
      return undefined;
    }
    return { name: param, optional: colon[3] === '?', catchAll: colon[2] !== undefined };
  }
  return undefined;
}

/** The `:name`, `:name?` or `:name(.*)*` spelling of one segment. */
export function segmentPattern(segment: RouteSegment): string {
  if (segment.catchAll) {
    return `:${segment.name}(.*)*`;
  }
  return segment.optional ? `:${segment.name}?` : `:${segment.name}`;
}

/** The route path one directory's segments produce, with a leading slash and no trailing one. */
export function pathOfSegments(segments: readonly string[]): string {
  if (segments.length === 0) {
    return '/';
  }
  return `/${segments.join('/')}`;
}

/**
 * The route path and params of one page file, given its directory segments inside the pages tree.
 * `index` and the catch-all names have no segment of their own.
 */
export function pathOfPage(
  segments: readonly string[],
  file: string,
): { readonly path: string; readonly params: readonly RouteSegment[] } {
  if (isNotFoundFile(file)) {
    return {
      path: pathOfSegments(segments),
      params: [...dynamicSegments(segments), { name: CATCH_ALL_PARAM, optional: false, catchAll: true }],
    };
  }
  const base = file.replace(/\.vue$/, '');
  const parts = pathSegments(segments);
  if (base === 'index') {
    return { path: pathOfSegments(parts), params: dynamicSegments(segments) };
  }
  const self = parseSegment(base);
  const all = self === undefined ? [...parts, base] : [...parts, segmentPattern(self)];
  const params = [...dynamicSegments(segments), ...(self === undefined ? [] : [self])];
  return { path: pathOfSegments(all), params };
}

/** The directory chain with its dynamic segments in the `:name` spelling. */
function pathSegments(segments: readonly string[]): readonly string[] {
  return segments.map((segment) => {
    const parsed = parseSegment(segment);
    return parsed === undefined ? segment : segmentPattern(parsed);
  });
}

/** The dynamic segments of a directory chain, in order. */
function dynamicSegments(segments: readonly string[]): readonly RouteSegment[] {
  const found: RouteSegment[] = [];
  for (const segment of segments) {
    const parsed = parseSegment(segment);
    if (parsed !== undefined) {
      found.push(parsed);
    }
  }
  return found;
}

/**
 * The route name of one page: its path segments joined with `.`, with `index` for the pages root's
 * own `index.vue`, the directory for a nested `index.vue`, and the canonical bracketed spelling for
 * a dynamic segment. Names are the primary key of the generated route table, so they are derived
 * from the file path and never from the route path.
 */
export function nameOfPage(segments: readonly string[], file: string): string {
  const base = file.replace(/\.vue$/, '');
  if (isNotFoundFile(file)) {
    return [...segments, NOT_FOUND_ROUTE_NAME].join('.');
  }
  if (base === 'index') {
    return segments.length === 0 ? 'index' : segments.join('.');
  }
  return [...segments, canonicalName(base)].join('.');
}

/** The canonical (bracketed) spelling of one file or directory name. */
export function canonicalName(name: string): string {
  const parsed = parseSegment(name);
  if (parsed === undefined) {
    return name;
  }
  if (parsed.catchAll) {
    return `[...${parsed.name}]`;
  }
  return parsed.optional ? `[[${parsed.name}]]` : `[${parsed.name}]`;
}

/** The route name of the layout that wraps one directory chain (`''` for the pages root). */
export function nameOfLayout(segments: readonly string[]): string {
  return [...segments, '+layout'].join('.');
}

/** `true` when the file is a page (a `.vue` file that is neither a layout nor a document). */
export function isPageFile(file: string): boolean {
  if (file.startsWith('+')) {
    return false;
  }
  return PAGE_EXTENSIONS.some((extension) => file.endsWith(extension));
}

/** Splits a pages-relative posix path; exported for the planner and the tests. */
export { splitPath };
