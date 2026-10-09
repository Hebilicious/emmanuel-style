/**
 * The page tree into a route plan (REQ-1, REQ-2, REQ-6).
 *
 * `planRoutes` is the pure half of filesystem routing: it takes the file tree, the documents the
 * compiler extracted and the artifacts it compiled, and returns the route table a generator emits.
 * Nothing here touches the filesystem or Vite, so the whole convention matrix is unit-testable, and
 * the Vite plugin only has to walk `src/pages`, call `extractProject` once and hand the result over.
 *
 * The plan is a flat list of records with a `parent` name, layouts included; `defineFlammeRoutes`
 * turns it into vue-router records at runtime (see `./define.js`). Layouts keep the pages of their
 * own directory and nest the next layout below them, so a page is wrapped by every layout between
 * the pages root and its own directory.
 *
 * ## Which document becomes the page's loader
 *
 * A page's **primary** query comes from one of the two surfaces the page owns (REQ-2):
 *
 * | surface | how the page declares it |
 * | --- | --- |
 * | colocated document | `+page.gql` beside the page (or in the directory named after it) |
 * | page module | the `Page` export of `+page.ts`, resolved to a document |
 *
 * Fragments and mutations are never loaders. A directory that declares both surfaces is an error
 * (`FLM1030`, reported by the compiler) and the document file is the loader. A page that somehow
 * yields two query documents on its primary surface gets a warning naming both (`FLM3004`), so the
 * choice is never silent.
 *
 * ## More than one document on a route
 *
 * A page directory may declare more than one document by nesting a **route group**: a directory
 * whose name is wrapped in parentheses (`(types)`) contributes no URL segment and declares a
 * nested, pathless record (`path: ''`) of the URL of the route it sits in. A group declares
 *
 * | file | role |
 * | --- | --- |
 * | `(name)/+page.gql` or `(name)/+page.ts` exporting `Page` | the group's own document, compiled like any page document |
 * | `(name)/+page.vue` | the component that renders the group's section, reading `usePageQuery()` |
 * | `(name)/+layout.vue` | optional; composed around the group's page component |
 *
 * The record's `parent` is the enclosing route's record, its `path` is `''` and its name is
 * `<enclosing record name>/(name)`, so the table stays deterministic. Groups nest, and a group at
 * the top level nests under the root `index` page, which is the record that renders `/` and hosts
 * the group's `<RouterView />`. The root layout is deliberately not a candidate there: a pathless
 * group child would be the last record vue-router matches for `/`, so it would take the URL from
 * the layout (and drop the layout's `/` redirect with it). A group whose enclosing directory has no
 * record to nest under - a top-level group with no root `index.vue`, or a group in a directory no
 * page, index page or layout declares - is `FLM3009`, not a silent re-rooting at `path: ''`. Data
 * flows downward only: the enclosing component renders `<RouterView />` where the section goes and
 * cannot read the group's document. A group that declares no component (`FLM3005`) or no document
 * (`FLM3006`) is reported and plans no record; a file in a group's directory that the convention
 * does not use is `FLM3008`; the retired `+page.<handle>.gql`/`+layout.<handle>.gql` spelling is
 * `FLM3007` and never becomes a loader.
 *
 * A file the convention names but a narrowed `routing.documentExtensions` does not accept
 * (`+page.graphql` in a project configured for `.gql`) is `FLM3016`: the name says it is a page's
 * document, the configuration says it is not, and nothing else in the build would mention it.
 *
 * Nothing is pruned: a declared document is always loaded, even when no component of the route
 * reads it, because the declaration is what a page's data needs are and a route that silently
 * dropped one would make the file's presence a lie.
 */

import {
  DEFAULT_DOCUMENT_EXTENSIONS,
  LAYOUT_MODULE_FILE,
  PAGE_MODULE_FILE,
  documentExtensionsOf,
  documentFileNames,
  hasDocumentExtension,
  resolvePageModule,
  toPosix,
  type RawDocument,
  type ResolvedConfig,
} from '@flamme/core';
import { Kind } from 'graphql';

import {
  CATCH_ALL_PARAM,
  DEFAULT_PAGES_DIR,
  GROUP_PAGE_FILE,
  LAYOUT_DOCUMENT_FILE,
  LAYOUT_FILE,
  PAGE_DOCUMENT_FILE,
  groupNameOf,
  isLayoutFile,
  isNotFoundFile,
  isPageFile,
  nameOfGroup,
  nameOfLayout,
  nameOfPage,
  parseSegment,
  pathOfPage,
  retiredDocumentHandle,
  segmentPattern,
  splitPath,
  type RouteSegment,
} from './conventions.js';
import {
  paramSources,
  variablesOfDocument,
  type RouteParamOverrides,
  type RouteParamSource,
  type RouteVariable,
} from './variables.js';

/** The routing conventions, resolved (`FlammeConfig.routing`). */
export interface ResolvedRoutingConfig {
  /** Directory that holds the pages, relative to the project root. Default `src/pages`. */
  readonly pagesDir: string;
  /**
   * The primary colocated document file name for a page (`+page.gql`).
   *
   * Messages name this one; {@link documentFiles} is what the planner matches, one name per
   * configured document extension.
   */
  readonly documentFile: string;
  /** The primary colocated document file name for a layout (`+layout.gql`). */
  readonly layoutDocumentFile: string;
  /** Every document file name a page may declare, one per configured extension. */
  readonly documentFiles: readonly string[];
  /** Every document file name a layout may declare, one per configured extension. */
  readonly layoutDocumentFiles: readonly string[];
  /** Every extension the compiler treats as a document (`routing.documentExtensions`). */
  readonly documentExtensions: readonly string[];
  /**
   * `route` composes each record's own query with its ancestors' into one request;
   * `document` keeps one loader per document. Default `route`
   * (`research/route-composition-design.md`).
   */
  readonly compose: 'route' | 'document';
  /**
   * `await` (the default) makes the navigation guard hold the navigation until each generated
   * loader's read has answered; `background` makes every generated loader **background**, so the
   * guard commits the navigation and the page renders its own pending state while the read is on
   * the wire (`QueryLoaderOptions.background`). Default `await`.
   *
   * The option is ignored on the server whatever it says: a server render cannot paint a pending
   * state, so vue-router's guard awaits a background loader there.
   */
  readonly loaders: 'await' | 'background';
  /** Per-route param renames, keyed by route path pattern. */
  readonly params: RouteParamOverrides;
}

/** One document a route's loader runs. */
export interface PlannedLoader {
  /** The document name, which is also the artifact's exported name. */
  readonly document: string;
  /** The document's variables, in declaration order. */
  readonly variables: readonly RouteVariable[];
  /** The route params assigned to those variables, in variable order. */
  readonly params: readonly RouteParamSource[];
  /**
   * The surface the route's loader came from: `file` for a colocated document,
   * `page-module` for the `Page` export of `+page.ts`.
   */
  readonly surface: string;
  /** The source file, relative to the project root. */
  readonly source: string;
}

/** One record of the planned route table. */
export interface PlannedRoute {
  /** The route name: the file path with `.` separators (`[id]`, `teams.[teamId]`). */
  readonly name: string;
  /** The absolute route path (`/:id`, `/teams/:teamId`). */
  readonly path: string;
  /** The path relative to the parent record's path; `''` for a page on its layout's own path. */
  readonly segment: string;
  /** The name of the record this one nests under; `undefined` at the top level. */
  readonly parent: string | undefined;
  /** `page` or `layout`; the generated module tags each record's `meta` with it. */
  readonly kind: 'page' | 'layout';
  /** Absolute path of the `.vue` file. */
  readonly component: string;
  /** The route's params, catch-all and directory params included. */
  readonly params: readonly RouteSegment[];
  /** The loaders the record's `meta.loaders` carries, in declaration order. */
  readonly loaders: readonly PlannedLoader[];
  /** Child record names, sorted; layouts only. */
  readonly children: readonly string[];
  /**
   * The layout a page renders when its nearest ancestor layout has no record of its own (a pathless
   * layout that owns no page). Absolute path of the `.vue` file; `undefined` for every other page.
   */
  readonly layout?: string | undefined;
  /**
   * The directory's index page, which a pathless layout record redirects to.
   *
   * A layout at the pages root has no path segment of its own, so it cannot also be the record for
   * `/` when an `index.vue` exists: vue-router resolves `''` to the parent's location, and the
   * layout would be replaced by (not wrapped around) the page. The layout therefore redirects to its
   * index page's full path, which matches the child record inside it.
   */
  readonly indexRedirect: string | undefined;
  /**
   * The group name when this record is a route group (`(types)` is `types`), else `undefined`.
   *
   * A group record is a `page` for every consumer (its own document, its own `usePageQuery()`) and
   * a pathless nested record for vue-router; this field is what tells the two apart in the plan.
   */
  readonly group: string | undefined;
}

/** A generation-time finding about the route tree. */
export interface RouteWarning {
  /** A stable code, in the compiler's `FLM` namespace. */
  readonly code:
    | 'FLM3001'
    | 'FLM3002'
    | 'FLM3003'
    | 'FLM3004'
    | 'FLM3005'
    | 'FLM3006'
    | 'FLM3007'
    | 'FLM3008'
    | 'FLM3009'
    | 'FLM3010'
    | 'FLM3016';
  /** The project-relative file the warning is about. */
  readonly file: string;
  /** One actionable sentence. */
  readonly message: string;
}

/** What {@link planRoutes} produced. */
export interface RoutePlan {
  /** Every planned record, sorted by name. */
  readonly routes: readonly PlannedRoute[];
  /** The records with no parent, in the order the tree declares them. */
  readonly roots: readonly string[];
  /** The pages directory, relative to the project root. */
  readonly pagesDir: string;
  /** The project root, absolute; the module emitter resolves component specifiers from it. */
  readonly projectDir: string;
  /** The generated directory, absolute; the module emitter resolves specifiers against it. */
  readonly runtimeDir: string;
  /** The primary colocated document file name for a page (`+page.gql`). */
  readonly documentFile: string;
  /** The primary colocated document file name for a layout (`+layout.gql`). */
  readonly layoutDocumentFile: string;
  /** Every document file name a page may declare, one per configured extension. */
  readonly documentFiles: readonly string[];
  /** Every document file name a layout may declare, one per configured extension. */
  readonly layoutDocumentFiles: readonly string[];
  /**
   * Whether the generated loaders are awaited (`'await'`) or background (`'background'`), from
   * `routing.loaders`. The emitter writes the option into every generated loader call.
   */
  readonly loaders: 'await' | 'background';
  /** Warnings, sorted by file then code. */
  readonly warnings: readonly RouteWarning[];
}

/** The input of {@link planRoutes}: the resolved config, the tree and the compiled documents. */
export interface PlanRoutesInput {
  /** The resolved compiler config; `config.routing` supplies the conventions. */
  readonly config: ResolvedConfig;
  /** The project root, absolute. */
  readonly projectDir: string;
  /** The generated directory, absolute; component specifiers are relative to it. */
  readonly runtimeDir: string;
  /** Every file the walk discovered, as absolute path -> source text. */
  readonly files: Readonly<Record<string, string>>;
  /** Every extracted document, as `extractProject` reports it. */
  readonly documents: readonly RawDocument[];
  /** The compiled artifact names; omitted entries are reported, not dropped. */
  readonly artifacts?: readonly string[];
}

/** A planned record before its optional parent is decided. */
type ParentlessRoute = Omit<PlannedRoute, 'parent'>;

/**
 * Builds a full {@link PlannedRoute} from a parentless one. `parent` is a required property that may
 * hold `undefined`, which keeps `exactOptionalPropertyTypes` out of the way: the record always
 * carries the key, and a consumer compares it against `undefined` rather than probing for it.
 */
function withParent(route: ParentlessRoute, parent: string | undefined): PlannedRoute {
  return { ...route, parent };
}

/** One extracted document with the surface it came from. */
interface Candidate {
  readonly document: RawDocument;
  readonly surface: string;
  /** The page module that declares the loader, for the `page-module` surface only. */
  readonly module?: string;
}

/** The last segment of a pages-relative directory (`''` for the pages root). */
function lastSegmentOf(dir: string): string {
  return dir === '' ? '' : dir.slice(dir.lastIndexOf('/') + 1);
}

/** One pages-relative directory name in URL spelling (`[id]` and `:id` are both `:id`). */
function urlSegment(segment: string): string {
  const parsed = parseSegment(segment);
  return parsed === undefined ? segment : segmentPattern(parsed);
}

/** The parent of a pages-relative directory (`''` for a top-level directory). */
function parentDirectoryOf(dir: string): string {
  const at = dir.lastIndexOf('/');
  return at === -1 ? '' : dir.slice(0, at);
}

/**
 * The nearest ancestor of `dir`, `dir` itself included, that is a route-group directory.
 *
 * A group owns exactly its own directory: the files directly in `(name)` are the group's component,
 * document and layout, and a file below a group's directory is not part of the convention
 * (`FLM3008`). Recognising the *nearest* group is what lets a group nest inside a group
 * (`(a)/(b)/+page.vue` is `(b)`'s component, not a stray file of `(a)`).
 */
function groupDirectoryOf(dir: string): string | undefined {
  let current = dir;
  for (;;) {
    if (groupNameOf(lastSegmentOf(current)) !== undefined) {
      return current;
    }
    if (current === '') {
      return undefined;
    }
    current = parentDirectoryOf(current);
  }
}

/**
 * Every route-group directory on a pages-relative directory's path, outermost first.
 *
 * A file belongs to the **nearest** group (`groupDirectoryOf`), but every group on the path is a
 * group of its own: `x/(a)/(b)/+page.vue` declares `(b)` and also declares `(a)`, which holds only
 * `(b)` and therefore has no component and no document of its own. Registering the whole chain is
 * what makes `(a)`'s `FLM3005`/`FLM3006` fire instead of leaving a group the planner never saw.
 */
function groupDirectoriesAlong(dir: string): readonly string[] {
  const found: string[] = [];
  let current = '';
  for (const segment of segmentsOfDirectory(dir)) {
    current = current === '' ? segment : `${current}/${segment}`;
    if (groupNameOf(segment) !== undefined) {
      found.push(current);
    }
  }
  return found;
}

/** Joins path parts with single slashes, so a pages-root directory never yields `//`. */
function joinPath(...parts: readonly string[]): string {
  return parts
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment !== '')
    .join('/');
}

/** Reads `config.routing`, filling in every default (`FlammeConfig.routing`). */
export function resolveRoutingConfig(config: ResolvedConfig): ResolvedRoutingConfig {
  const routing: unknown = config.routing;
  const record = typeof routing === 'object' && routing !== null ? routing : {};
  const configuredPage = stringOption(record, 'documentFile', PAGE_DOCUMENT_FILE);
  const configuredLayout = stringOption(record, 'layoutDocumentFile', LAYOUT_DOCUMENT_FILE);
  const documentFiles = documentFileNames(record, 'page');
  const layoutDocumentFiles = documentFileNames(record, 'layout');
  return {
    pagesDir: stringOption(record, 'pagesDir', DEFAULT_PAGES_DIR),
    // The primary name is the configured one when the project accepts it (its extension is among
    // `documentExtensions`), and the first accepted name otherwise: a message that named a file no
    // project accepts would send the reader to a path the planner never reads.
    documentFile: documentFiles.includes(configuredPage)
      ? configuredPage
      : (documentFiles[0] ?? PAGE_DOCUMENT_FILE),
    layoutDocumentFile: layoutDocumentFiles.includes(configuredLayout)
      ? configuredLayout
      : (layoutDocumentFiles[0] ?? LAYOUT_DOCUMENT_FILE),
    documentFiles,
    layoutDocumentFiles,
    documentExtensions: documentExtensionsOf(record),
    compose: composeOption(record),
    loaders: loadersOption(record),
    params: paramsOption(record),
  };
}

/**
 * The `routing.loaders` option, defaulting to `'await'`.
 *
 * The option is validated at config load (`assertRouting` accepts `'await'` and `'background'`), and
 * anything that is not exactly `'background'` keeps the awaited behavior: a hand-built config object
 * that reaches the planner without validation should get the product default, never a silently
 * background route.
 */
function loadersOption(record: object): 'await' | 'background' {
  return Reflect.get(record, 'loaders') === 'background' ? 'background' : 'await';
}

/**
 * The `routing.compose` option, defaulting to `'route'`.
 *
 * Anything that is not `'document'` composes: the compiler validates the option at config load
 * (`assertRouting`), and a hand-built config object that reaches the planner without validation
 * should get the product default rather than silently falling back to the per-document topology.
 */
function composeOption(record: object): 'route' | 'document' {
  return Reflect.get(record, 'compose') === 'document' ? 'document' : 'route';
}

/** One string option of `config.routing`, or its default. */
function stringOption(record: object, key: string, fallback: string): string {
  const value = Reflect.get(record, key);
  return typeof value === 'string' && value.length > 0 ? toPosix(value) : fallback;
}

/** The `params` option, with every non-string entry dropped. */
function paramsOption(record: object): RouteParamOverrides {
  const value = Reflect.get(record, 'params');
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const out: Record<string, Readonly<Record<string, string>>> = {};
  for (const [path, renames] of Object.entries(value)) {
    if (typeof renames !== 'object' || renames === null) {
      continue;
    }
    const entry: Record<string, string> = {};
    for (const [param, variable] of Object.entries(renames)) {
      if (typeof variable === 'string' && variable.length > 0) {
        entry[param] = variable;
      }
    }
    out[path] = entry;
  }
  return out;
}

/** The directory chain of a pages-relative directory as segments. */
function segmentsOfDirectory(dir: string): readonly string[] {
  return dir === '' ? [] : dir.split('/');
}

/** The project-relative posix path of an absolute path. */
function relativeTo(projectDir: string, absolute: string): string {
  const prefix = projectDir.endsWith('/') ? projectDir : `${projectDir}/`;
  return toPosix(absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute);
}

/** The variable names a connection document adds for its own paging, which no param drives. */
const PAGING_VARIABLES = new Set(['first', 'after', 'last', 'before']);

/** The operation name of a document when it is a query, `undefined` otherwise. */
function queryOperationName(document: RawDocument): string | undefined {
  for (const definition of document.ast.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) {
      continue;
    }
    // A page's own document is a query; `subscription` and `mutation` are not loadable by a route.
    // The operation kind is compared as a string because the AST's enum is not shared with the
    // graphql package's runtime values under `verbatimModuleSyntax`.
    const operation: string = definition.operation;
    return operation === 'query' ? definition.name?.value : undefined;
  }
  return undefined;
}

/** The depth of a pages-relative directory (`''` is 0). */
function depthOf(value: string): number {
  return value === '' ? 0 : value.split('/').length;
}

/** Sorts directories shallow-first, then by name, so a parent is always planned before its child. */
function byDepthThenName(a: string, b: string): number {
  if (depthOf(a) !== depthOf(b)) {
    return depthOf(a) - depthOf(b);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `true` for a file inside a route group that the convention does not use (reported `FLM3008`). */
function isStrayGroupFile(file: string, routing: ResolvedRoutingConfig): boolean {
  return (
    isPageFile(file) ||
    routing.layoutDocumentFiles.includes(file) ||
    file === LAYOUT_MODULE_FILE ||
    hasDocumentExtension(file, routing.documentExtensions)
  );
}

/** The extensions the compiler accepts as documents when a project names none. */
const DEFAULT_EXTENSIONS: readonly string[] = DEFAULT_DOCUMENT_EXTENSIONS;

/** A convention document file that the configured `documentExtensions` refuses. */
interface IgnoredDocument {
  /** The extension the file carries (`.graphql`). */
  readonly extension: string;
  /** The role whose stem the file is named after. */
  readonly role: 'page' | 'layout';
  /** The document file name the project does accept for that role. */
  readonly accepted: string;
}

/**
 * The file the routing convention owns and the project no longer reads.
 *
 * `+page.graphql` is a page document for a project whose `documentExtensions` lists
 * `.graphql`, and neither a document nor an error for one that narrowed the list to
 * `.gql`: the name is the convention's, so it is silently ignored and the page it was
 * meant to declare reads nothing. Only the compiler's own default extensions are
 * considered, so a file that merely shares the stem (`+page.test.ts`, `+page.vue`) is
 * not reported.
 */
function ignoredDocument(
  file: string,
  routing: ResolvedRoutingConfig,
): IgnoredDocument | undefined {
  const roles: readonly (readonly ['page' | 'layout', string, string])[] = [
    ['page', routing.documentFile, routing.documentFiles[0] ?? routing.documentFile],
    [
      'layout',
      routing.layoutDocumentFile,
      routing.layoutDocumentFiles[0] ?? routing.layoutDocumentFile,
    ],
  ];
  for (const [role, name, accepted] of roles) {
    const at = name.lastIndexOf('.');
    const stem = at <= 0 ? name : name.slice(0, at);
    if (!file.startsWith(`${stem}.`)) {
      continue;
    }
    const extension = file.slice(stem.length);
    if (!DEFAULT_EXTENSIONS.includes(extension) || routing.documentExtensions.includes(extension)) {
      continue;
    }
    return { extension, role, accepted };
  }
  return undefined;
}

/**
 * Plans the route table. Pure: the same input always produces the same plan, which is what makes the
 * generated module stable and the golden tests meaningful.
 */
export function planRoutes(input: PlanRoutesInput): RoutePlan {
  const routing = resolveRoutingConfig(input.config);
  const artifacts = new Set(input.artifacts ?? []);
  const warnings: RouteWarning[] = [];

  const pagesPrefix = routing.pagesDir === '' ? '' : `${routing.pagesDir}/`;
  const isInsidePages = (relative: string): boolean =>
    pagesPrefix === '' || relative.startsWith(pagesPrefix);

  /** Every file under the pages directory, keyed by its pages-relative path. */
  const pageFiles = new Map<string, string>();
  const layoutFiles = new Map<string, string>();
  const documentFiles = new Map<string, string>();
  const layoutDocuments = new Map<string, string>();
  const pageModules = new Map<string, string>();
  const layoutModules = new Map<string, string>();
  /** The `index.vue` files the tree declares, by pages-relative directory. */
  const indexPageFiles = new Set<string>();
  /** Route-group directories, and the four files each of them may declare. */
  const groupDirectories = new Set<string>();
  const groupComponents = new Map<string, string>();
  const groupDocuments = new Map<string, string>();
  const groupModules = new Map<string, string>();
  const groupLayouts = new Map<string, string>();
  for (const absolute of Object.keys(input.files).toSorted()) {
    const relative = relativeTo(input.projectDir, absolute);
    if (!isInsidePages(relative)) {
      continue;
    }
    const inside = pagesPrefix === '' ? relative : relative.slice(pagesPrefix.length);
    const { dir, file } = splitPath(inside);
    // The retired named-document spelling is reported wherever it sits (a page directory or a
    // group's), and never becomes a loader. A page and a layout document have different homes now,
    // so each gets its own message: a group's `+page.gql` is read by the group's component, and a
    // group declares no second layout document (`FLM3008`).
    const pageHandle = routing.documentFiles
      .map((name) => retiredDocumentHandle(file, name))
      .find((handle) => handle !== undefined);
    const layoutHandle = routing.layoutDocumentFiles
      .map((name) => retiredDocumentHandle(file, name))
      .find((handle) => handle !== undefined);
    const retired = pageHandle ?? layoutHandle;
    if (retired !== undefined) {
      const groupPath = joinPath(pagesPrefix, dir, `(${retired})`);
      warnings.push({
        code: 'FLM3007',
        file: relative,
        message:
          pageHandle === undefined
            ? `"${relative}" is a named layout document, which this version no longer supports; ` +
              'a layout declares one document. Move the query into ' +
              `"${joinPath(pagesPrefix, dir, routing.layoutDocumentFile)}" if the layout needs it, ` +
              `or into a route group's "${routing.documentFile}" if it belongs to a page's section; ` +
              'a group declares a page document, not a second layout one.'
            : `"${relative}" is a named document, which this version no longer supports; a page ` +
              'declares one document, and a second is a route group. Move it to ' +
              `"${joinPath(groupPath, routing.documentFile)}", read it with \`usePageQuery()\` from ` +
              `"${joinPath(groupPath, GROUP_PAGE_FILE)}", and render \`<RouterView />\` where its ` +
              'section goes.',
      });
      continue;
    }
    // A file the convention names but the project does not accept as a document is
    // reported rather than ignored: `+page.graphql` beside `+page.gql` in a project
    // whose `documentExtensions` is `.gql` reads nothing, and nothing else says so.
    const ignored = ignoredDocument(file, routing);
    if (ignored !== undefined) {
      const configured =
        routing.documentExtensions.map((extension) => `"${extension}"`).join(', ') || 'empty';
      warnings.push({
        code: 'FLM3016',
        file: relative,
        message:
          `"${relative}" is a ${ignored.role} document by convention, but the project's ` +
          `"routing.documentExtensions" is ${configured}, so "${ignored.extension}" is not ` +
          `accepted and the file is ignored. Add "${ignored.extension}" to the list, or rename ` +
          `the file to "${joinPath(pagesPrefix, dir, ignored.accepted)}".`,
      });
      continue;
    }
    // Every group on the path is a group of its own, so a group that holds only nested groups is
    // diagnosed (`FLM3005`/`FLM3006`) rather than never discovered.
    for (const ancestor of groupDirectoriesAlong(dir)) {
      groupDirectories.add(ancestor);
    }
    const group = groupDirectoryOf(dir);
    if (group !== undefined) {
      if (group !== dir) {
        // A group owns its own directory only: anything below it is not a route of this convention.
        if (isStrayGroupFile(file, routing)) {
          warnings.push({
            code: 'FLM3008',
            file: relative,
            message:
              `"${relative}" is inside the route group "${pagesPrefix}${group}", which declares ` +
              `only "${GROUP_PAGE_FILE}", "${routing.documentFile}" (or "${PAGE_MODULE_FILE}" ` +
              `exporting "Page") and an optional "${LAYOUT_FILE}"; move the file out of the group.`,
          });
        }
        continue;
      }
      if (file === GROUP_PAGE_FILE) {
        groupComponents.set(dir, absolute);
      } else if (routing.documentFiles.includes(file)) {
        groupDocuments.set(dir, absolute);
      } else if (file === PAGE_MODULE_FILE) {
        groupModules.set(dir, absolute);
      } else if (isLayoutFile(file)) {
        groupLayouts.set(dir, absolute);
      } else if (isStrayGroupFile(file, routing)) {
        warnings.push({
          code: 'FLM3008',
          file: relative,
          message:
            `"${relative}" is inside the route group "${pagesPrefix}${group}", which declares ` +
            `only "${GROUP_PAGE_FILE}", "${routing.documentFile}" (or "${PAGE_MODULE_FILE}" ` +
            `exporting "Page") and an optional "${LAYOUT_FILE}"; move the file out of the group.`,
        });
      }
      continue;
    }
    if (isLayoutFile(file)) {
      layoutFiles.set(dir, absolute);
    } else if (routing.documentFiles.includes(file)) {
      documentFiles.set(dir, absolute);
    } else if (routing.layoutDocumentFiles.includes(file)) {
      layoutDocuments.set(dir, absolute);
    } else if (file === PAGE_MODULE_FILE) {
      pageModules.set(dir, absolute);
    } else if (file === LAYOUT_MODULE_FILE) {
      layoutModules.set(dir, absolute);
    } else if (isPageFile(file)) {
      pageFiles.set(inside, absolute);
      if (splitPath(inside).file === 'index.vue') {
        indexPageFiles.add(inside);
      }
    }
  }

  // A group that declares no component or no document is a diagnostic, not a silent record: the
  // two files are what the convention is, and a record without either has nothing to render or
  // nothing to read.
  for (const dir of [...groupDirectories].toSorted(byDepthThenName)) {
    const relativeDir = `${pagesPrefix}${dir}`;
    if (!groupComponents.has(dir)) {
      warnings.push({
        code: 'FLM3005',
        file: relativeDir,
        message:
          `"${relativeDir}" is a route group with no component; add ` +
          `"${relativeDir}/${GROUP_PAGE_FILE}" to render its section, or delete the group.`,
      });
    }
    if (!groupDocuments.has(dir) && !groupModules.has(dir)) {
      warnings.push({
        code: 'FLM3006',
        file: relativeDir,
        message:
          `"${relativeDir}" is a route group with no document; add ` +
          `"${relativeDir}/${routing.documentFile}" (or a "${PAGE_MODULE_FILE}" exporting "Page"), ` +
          'or delete the group.',
      });
    }
  }

  /** The documents of one source file, with the colocated one appended for its directory. */
  const documentsBySource = new Map<string, Candidate[]>();
  for (const document of input.documents) {
    const relative = toPosix(document.relativePath);
    if (!isInsidePages(relative)) {
      continue;
    }
    const list = documentsBySource.get(relative) ?? [];
    list.push({ document, surface: document.surface });
    documentsBySource.set(relative, list);
  }

  const dirs = new Set<string>(['']);
  for (const inside of pageFiles.keys()) {
    dirs.add(splitPath(inside).dir);
  }
  for (const dir of layoutFiles.keys()) {
    dirs.add(dir);
  }

  const routes: PlannedRoute[] = [];
  const byName = new Map<string, PlannedRoute>();
  const push = (route: PlannedRoute): void => {
    routes.push(route);
    byName.set(route.name, route);
  };

  const segmentsOf = segmentsOfDirectory;

  /**
   * `true` when a file exists in the same directory as the layout being built. A pathless layout
   * renders `/` itself, so a sibling page (its index, its `[id]`) is never reachable: the layout is
   * nested under its own parent and its children are dropped. Such a file is reported instead.
   */
  const siblingExists = (layoutAbsolute: string): boolean => {
    const directory = layoutAbsolute.slice(0, layoutAbsolute.lastIndexOf('/'));
    return Object.keys(input.files).some(
      (path) =>
        path !== layoutAbsolute &&
        path.startsWith(`${directory}/`) &&
        !path.slice(directory.length + 1).includes('/') &&
        isPageFile(path.slice(path.lastIndexOf('/') + 1)),
    );
  };

  /** The loader one query candidate produces, with its variable warnings; `undefined` for a non-query. */
  const loaderOf = (
    candidate: Candidate,
    relativePath: string,
    pathPattern: string,
    params: readonly string[],
    report: boolean,
  ): PlannedLoader | undefined => {
    if (
      candidate.document.kind !== 'query' ||
      queryOperationName(candidate.document) === undefined
    ) {
      return undefined;
    }
    const document = candidate.document;
    const variables = variablesOfDocument(document.raw, input.config);
    const sources = paramSources(pathPattern, variables, params, routing.params);
    for (const variable of variables) {
      if (
        PAGING_VARIABLES.has(variable.name) ||
        variable.defaultValue !== undefined ||
        sources.some((source) => source.variable === variable.name)
      ) {
        continue;
      }
      if (report) {
        warnings.push({
          code: 'FLM3003',
          file: relativePath,
          message:
            `"${relativePath}" reads $${variable.name} (${variable.type}) but the route ` +
            `"${pathPattern}" declares no "${variable.name}" param and the document has no default; ` +
            'add a param, give the variable a default, or map it in `routing.params`.',
        });
      }
    }
    return {
      document: document.name,
      variables,
      params: sources,
      surface: candidate.surface,
      // The file the loader is declared in: the page's own file, or the page module that
      // exports the document.
      source: candidate.module ?? relativePath,
    };
  };

  /**
   * The loaders one file's **primary** query documents produce, with the surface choice applied.
   *
   * The first query wins, and more than one query on the surface is FLM3004. A second document is
   * declared by nesting a route group, so it is a loader of *its own record* and never competes for
   * this one.
   */
  const loadersOf = (
    relativePath: string,
    candidates: readonly Candidate[],
    pathPattern: string,
    params: readonly string[],
    report = true,
  ): readonly PlannedLoader[] => {
    const queries = candidates.filter(
      (candidate) =>
        candidate.document.kind === 'query' && queryOperationName(candidate.document) !== undefined,
    );
    if (queries.length === 0) {
      return [];
    }
    const chosen = queries[0];
    if (queries.length > 1 && report) {
      warnings.push({
        code: 'FLM3004',
        file: relativePath,
        message:
          `"${relativePath}" declares ${String(queries.length)} query documents ` +
          `(${queries.map((candidate) => candidate.document.name).join(', ')}); using ` +
          `"${chosen?.document.name ?? '?'}" from the ${chosen?.surface ?? '?'} surface.`,
      });
    }
    if (chosen === undefined) {
      return [];
    }
    const loader = loaderOf(chosen, relativePath, pathPattern, params, report);
    return loader === undefined ? [] : [loader];
  };

  /**
   * The candidate documents of one absolute `.vue` file, from the two surfaces the page owns.
   *
   * A colocated `+page.gql` belongs to the **page** of its directory, and a `+layout.gql` to the
   * layout: a layout document sits beside the pages it wraps and outlives them, which is what a
   * layout query is for. A `+page.ts`/`+layout.ts` contributes the document its `Page` export
   * resolves to, read with the same resolver the compiler validates with, so two pages that import
   * one document get two loaders over one artifact.
   *
   * A directory that declares both surfaces is FLM1030 in the compiler, and the document file is the
   * loader here, so the plan stays deterministic while the build fails loudly.
   */
  const candidatesOf = (absolute: string, scope: 'layout' | 'page'): readonly Candidate[] => {
    const relative = relativeTo(input.projectDir, absolute);
    const inline = documentsBySource.get(relative) ?? [];
    const { dir, file } = splitPath(relative);
    const insideDir = pagesPrefix === '' ? dir : dir.slice(pagesPrefix.length);
    // A layout's document is `+layout.gql` in its own directory. A page's is `+page.gql` in its own
    // directory, or - for the plain `x.vue` spelling, which has a URL segment of its own - in the
    // directory named after the page, so `search/[term].vue` reads `search/[term]/+page.gql` and a
    // root-level `[[id]].vue` reads `[[id]]/+page.gql`.
    const base = file.replace(/\.vue$/, '');
    const named = insideDir === '' ? base : `${insideDir}/${base}`;
    const colocated =
      scope === 'layout'
        ? layoutDocuments.get(insideDir)
        : (documentFiles.get(named) ?? documentFiles.get(insideDir));
    if (colocated !== undefined) {
      const colocatedRelative = relativeTo(input.projectDir, colocated);
      return [...inline, ...(documentsBySource.get(colocatedRelative) ?? [])];
    }
    const module =
      scope === 'layout'
        ? layoutModules.get(insideDir)
        : (pageModules.get(named) ?? pageModules.get(insideDir));
    if (module === undefined) {
      return inline;
    }
    const document = moduleDocument(module);
    return document === undefined
      ? inline
      : [
          ...inline,
          { document, surface: 'page-module', module: relativeTo(input.projectDir, module) },
        ];
  };

  /** The document a page module's `Page` export resolves to, or `undefined` (the compiler reports why). */
  const moduleDocument = (module: string): RawDocument | undefined => {
    const relative = relativeTo(input.projectDir, module);
    const source = input.files[module];
    if (source === undefined) {
      return undefined;
    }
    const resolution = resolvePageModule({
      file: toPosix(module),
      relativePath: relative,
      source,
      documents: input.documents,
    });
    return resolution.document;
  };

  /**
   * The nearest ancestor of `dir` that has a layout, `dir` itself excluded. A `+layout.vue` wraps
   * the pages *below* its directory, so the page that shares the layout's directory (`teams/index.vue`
   * beside `teams/+layout.vue`) is that layout's child, not a sibling of it.
   */
  const nearestLayout = (dir: string): string | undefined => {
    let current = dir;
    for (;;) {
      if (layoutFiles.has(current)) {
        return nameOfLayout(segmentsOf(current));
      }
      if (current === '') {
        return undefined;
      }
      current = splitPath(current).dir;
    }
  };

  /** The layout of a page in `dir`: the nearest ancestor, or `dir`'s own layout for its index. */
  const layoutForPage = (dir: string, file: string): string | undefined => {
    const isIndex = file === 'index.vue';
    return isIndex ? nearestLayout(splitPath(dir).dir) : nearestLayout(dir);
  };

  /**
   * Group directory -> the route name its files plan. Filled by the group pass (shallowest first),
   * so a nested group can nest under the record of the group that encloses it.
   */
  const groupNames = new Map<string, string>();

  /**
   * The name of the record that renders the URL of one pages-relative directory, or `undefined`
   * when no record is anchored there.
   *
   * A route group contributes no URL segment, so it nests under the route it sits *in*: the record
   * of its own directory (a group inside a group), the page whose document directory this is
   * (`[[id]].vue` owns `[[id]]/`), the directory's `index` page, or the directory's layout, in that
   * order. The index page comes before the layout because vue-router matches the first same-path
   * sibling and an `index.vue` is inserted before the `+layout.vue` beside it, so the index is the
   * record its URL actually resolves to.
   *
   * A directory no record is anchored at (a directory that only groups files) leaves the group with
   * no parent, which the group pass reports (`FLM3009`). The pages root is decided there too: a
   * top-level group nests under the root `index` record or not at all.
   */
  const recordOfDirectory = (dir: string): string | undefined => recordAt(dir)?.record;

  /**
   * The same lookup with the directory the record's URL is anchored at: `dir` itself for a page, an
   * index page or a group, and the **parent** of `dir` for a layout, whose own `/admin` URL belongs
   * to its parent record's path.
   *
   * The catch-all walk needs it: a catch-all's child path starts where its host record's URL ends,
   * so `admin/+layout.vue` (anchored at `''`) still holds `:pathMatch(.*)*` under `/admin`.
   */
  const recordAt = (
    dir: string,
  ): { readonly record: string; readonly directory: string } | undefined => {
    if (groupNameOf(lastSegmentOf(dir)) !== undefined) {
      const name = groupNames.get(dir);
      return name !== undefined && byName.has(name) ? { record: name, directory: dir } : undefined;
    }
    const segments = segmentsOf(dir);
    // `admin/index.vue` and `admin.vue` plan the same route name, so the files are what tell the two
    // records apart: the page named after the directory owns the directory's URL, the index page is
    // a pathless child of the record that owns it, and a layout owns its own URL at its parent.
    const page = nameOfPage(segmentsOf(parentDirectoryOf(dir)), `${lastSegmentOf(dir)}.vue`);
    if (
      pageFiles.has(joinPath(dir, `${lastSegmentOf(dir)}.vue`)) ||
      // a directory whose page declares no file of that name but plans the record anyway: its
      // document lives in the directory (`[id]/+page.gql` is `[id]` beside `[id].vue`)
      (!page.includes('.') && byName.has(page))
    ) {
      return { record: page, directory: dir };
    }
    if (indexPageFiles.has(joinPath(dir, 'index.vue'))) {
      return { record: nameOfPage(segments, 'index.vue'), directory: dir };
    }
    const layout = nameOfLayout(segments);
    return byName.has(layout) ? { record: layout, directory: parentDirectoryOf(dir) } : undefined;
  };

  /** The root `index.vue` record, or `undefined` when the pages root has no index page. */
  const rootIndexRecord = (): string | undefined => {
    const index = nameOfPage([], 'index.vue');
    return byName.has(index) ? index : undefined;
  };

  /**
   * The `FLM3009` message for a group whose enclosing directory has no record to nest under.
   *
   * A group contributes no URL segment, so without an enclosing record it has no URL at all. The
   * message names the directory and the page or layout that would anchor it, because re-parenting
   * the group to the URL root would silently drop the path (`foo/(x)` at `/`) or take `/` from the
   * record that owns it.
   */
  const orphanGroupMessage = (dir: string, enclosing: string): string => {
    const groupPath = joinPath(pagesPrefix, dir);
    if (enclosing === '') {
      return (
        `"${groupPath}" is a route group at the pages root, but no "index.vue" page renders there; ` +
        `add "${joinPath(pagesPrefix, 'index.vue')}" and put "<RouterView />" where the group's ` +
        'section goes, or move the group into the directory of the route it belongs to. The group ' +
        'plans no record.'
      );
    }
    const enclosingPath = joinPath(pagesPrefix, enclosing);
    if (groupNameOf(lastSegmentOf(enclosing)) !== undefined) {
      return (
        `"${groupPath}" is a route group inside "${enclosingPath}", which plans no record of its ` +
        `own; give that group its own "${GROUP_PAGE_FILE}" and document, or move this group into ` +
        'the directory of the route it belongs to. The group plans no record.'
      );
    }
    return (
      `"${groupPath}" is a route group in "${enclosingPath}", which declares no page, index page ` +
      `or layout record; add "${joinPath(enclosingPath, 'index.vue')}" or ` +
      `"${joinPath(enclosingPath, LAYOUT_FILE)}", or move the group into the directory of the route ` +
      'it belongs to. The group plans no record.'
    );
  };

  /**
   * The record a catch-all in `dir` nests under, the path it keeps and the segment that places it.
   *
   * A catch-all matches every path below its directory, so it hangs off the deepest record whose URL
   * is a prefix of the directory's: the record that renders the directory's own URL
   * (`admin/+layout.vue` at `/admin`), and the record above it otherwise (`admin/nested/404.vue`
   * with no record for `admin/nested` spells the directory out under the record that owns `/admin`).
   * The child path is never empty - a pathless catch-all matches only its parent's own URL, which is
   * the one URL a not-found page must not answer - and it never repeats the host's segments.
   *
   * `undefined` means no record covers the directory's URL at all: nothing there declares a page, an
   * index page or a layout. The catch-all then has nowhere to live, because the only alternatives are
   * a record at the directory's absolute path (which matches every path in the app) or a silent drop,
   * so the caller reports `FLM3010` instead of planning one.
   */
  const catchAllAnchor = (
    dir: string,
  ):
    | { readonly parent: string | undefined; readonly path: string; readonly segment: string }
    | undefined => {
    // The directory chain in URL spelling (`[id]` -> `:id`), which is the absolute path a record
    // anchored at the directory renders, and what its own catch-all has to cover.
    const url = pathOfPage(segmentsOf(dir).map(urlSegment), 'index.vue').path;
    // Every record whose URL could host this catch-all, deepest first: the directory's layout, its
    // `index.vue` (a pathless child of the record above it, so it renders the URL without owning a
    // path of its own), the page whose file or document owns the directory (`[id].vue` and
    // `[id]/+page.gql` both plan `[id]`), then the same three for each directory above. A record
    // whose path *is* the URL hosts the plain `:pathMatch(.*)*`; one that renders a prefix of it
    // hosts the directories in between in front of the same tail.
    const hosts: { readonly record: string; readonly path: string }[] = [];
    let current = dir;
    for (;;) {
      const candidates = [
        ...(layoutFiles.has(current) ? [nameOfLayout(segmentsOf(current))] : []),
        ...(pageFiles.has(joinPath(current, 'index.vue'))
          ? [nameOfPage(segmentsOf(current), 'index.vue')]
          : []),
        // The page that owns the directory: `[id].vue` beside it, or the document directory that
        // plans the same record (`[id]/+page.gql` is `[id]` with no file of that name). The
        // spelling is the same either way, and a candidate no record declares is dropped below.
        // `recordOfDirectory` also answers with it, which is why the catch-all walk asks here.
        nameOfPage(segmentsOf(dir).slice(0, depthOf(current)), `index.vue`),
        nameOfPage(segmentsOf(parentDirectoryOf(current)), `${lastSegmentOf(current)}.vue`),
      ];
      for (const candidate of candidates) {
        const path = byName.get(candidate)?.path;
        if (path !== undefined && path !== '') {
          hosts.push({ record: candidate, path });
        }
      }
      if (current === '') {
        break;
      }
      current = parentDirectoryOf(current);
    }
    const isPrefixOf = (host: { readonly path: string }): boolean =>
      host.path !== '/' && url.startsWith(`${host.path}/`);
    // A proper prefix keeps the catch-all inside its own subtree; a host that renders the URL itself
    // is the next best thing (its own path is the host of the child). A record at `/` hosts nothing
    // below the pages root: it is a different URL, and nesting there would catch the whole app.
    const owner = hosts.find(isPrefixOf) ?? hosts.find((host) => host.path === url);
    if (owner === undefined) {
      return undefined;
    }
    // `between` is what the host does not already cover: nothing when the host renders the URL
    // itself, and the directories below it otherwise.
    const between =
      owner.path === url
        ? ''
        : owner.path === '/'
          ? url.slice(1)
          : url.slice(owner.path.length + 1);
    return {
      parent: owner.record,
      // the URL of the directory the catch-all catches, in param spelling (`[id]/404.vue` is
      // `/:id`, the URL its directory renders, not the literal `/[id]` the file name would give)
      path: url,
      segment: [
        ...(between === '' ? [] : between.split('/')).map(urlSegment),
        `:${CATCH_ALL_PARAM}(.*)*`,
      ].join('/'),
    };
  };

  /**
   * The `FLM3010` message for a catch-all whose directory no record covers.
   *
   * The file is not planned at all: a catch-all has to nest under the record that renders its
   * subtree, and without one the only alternatives are a record at the directory's absolute path
   * (which matches every path in the app) or a silent drop. The message names both files that would
   * give the directory a record, so the fix is one file away.
   */
  const catchAllOrphanMessage = (dir: string): string => {
    const dirPath = joinPath(pagesPrefix, dir);
    return (
      `"${joinPath(dirPath, '404.vue')}" (or "${joinPath(dirPath, '[...notFound].vue')}") sits in a ` +
      `directory no route record covers; add "${joinPath(dirPath, 'index.vue')}" or ` +
      `"${joinPath(dirPath, LAYOUT_FILE)}" so the catch-all has a record to nest under, or move it ` +
      'into the directory of the route it belongs to. The catch-all plans no record, because a ' +
      'top-level one would match the whole app rather than this subtree.'
    );
  };

  /** The document candidates one route group declares: its document file, else its page module. */
  const groupCandidatesOf = (dir: string): readonly Candidate[] => {
    const document = groupDocuments.get(dir);
    if (document !== undefined) {
      return documentsBySource.get(relativeTo(input.projectDir, document)) ?? [];
    }
    const module = groupModules.get(dir);
    if (module === undefined) {
      return [];
    }
    const resolved = moduleDocument(module);
    return resolved === undefined
      ? []
      : [
          {
            document: resolved,
            surface: 'page-module',
            module: relativeTo(input.projectDir, module),
          },
        ];
  };

  /** The path of one record relative to its parent's path. */
  const segmentOf = (path: string, parentName: string | undefined): string => {
    if (parentName === undefined) {
      return path;
    }
    const parent = byName.get(parentName);
    if (parent === undefined || parent.path === '/') {
      return path.replace(/^\//, '');
    }
    return path.slice(parent.path.length).replace(/^\//, '');
  };

  /**
   * The path a pathless layout redirects `/` to, or `undefined` when no root page can be rendered
   * there.
   *
   * Its own `index.vue` needs no redirect (the `''` child matches `/` with the parent). Otherwise a
   * sibling is the target: a static page (`/about`), a sibling layout (`/teams`, which owns
   * `teams/index.vue`), or a **dynamic** page whose variable has a default, which is reachable at
   * that default (`[[id]].vue` with `$id: Int! = 1` is `/1`). A dynamic page with no default cannot
   * be a target: `/` would resolve back to the layout itself.
   */
  const staticAnchor = (): string | undefined => {
    if (pageFiles.has('index.vue')) {
      return undefined;
    }
    const roots = [...pageFiles.entries()]
      .filter(([inside]) => !inside.includes('/') && !isNotFoundFile(splitPath(inside).file))
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // a static page is the best target; a dynamic page only qualifies at its own default
    for (const [inside, absolute] of roots) {
      const { path, params } = pathOfPage([], splitPath(inside).file);
      if (params.length === 0 && path !== '/') {
        return path;
      }
      void absolute;
    }
    for (const [inside, absolute] of roots) {
      const { params } = pathOfPage([], splitPath(inside).file);
      if (params.length === 0) {
        continue;
      }
      const defaults = defaultPath(absolute, inside, params);
      if (defaults !== undefined) {
        return defaults;
      }
    }
    for (const dir of [...layoutFiles.keys()].toSorted(byDepthThenName)) {
      if (dir === '' || splitPath(dir).dir !== '') {
        continue;
      }
      return pathOfPage(dir.split('/'), 'index.vue').path;
    }
    return undefined;
  };

  /**
   * The path of a dynamic root page at its own defaults (`/:id?` with `$id = 1` is `/1`), or
   * `undefined` when its query declares no default for a param (the page has no static spelling).
   */
  const defaultPath = (
    absolute: string,
    inside: string,
    params: readonly RouteSegment[],
  ): string | undefined => {
    const loaders = loadersOf(
      relativeTo(input.projectDir, absolute),
      candidatesOf(absolute, 'page'),
      pathOfPage([], splitPath(inside).file).path,
      params.map((param) => param.name),
      false,
    );
    const values: string[] = [];
    for (const param of params) {
      const variable = loaders[0]?.variables.find((entry) => entry.name === param.name);
      const fallback = variable?.defaultValue;
      if (fallback === undefined || fallback === null || typeof fallback === 'boolean') {
        return undefined;
      }
      values.push(String(fallback));
    }
    return `/${values.join('/')}`;
  };

  // A root layout that owns no page renders nothing: every root page keeps its own record and
  // renders the layout itself (`meta.layout`), so `+layout.vue` beside `[id].vue` still wraps the
  // page. It is a warning, not a silent drop, because the layout's own query would then never run.
  for (const dir of [...layoutFiles.keys()].toSorted(byDepthThenName)) {
    const absolute = layoutFiles.get(dir);
    if (absolute === undefined || pathOfPage(segmentsOf(dir), 'index.vue').path !== '/') {
      continue;
    }
    if (pageFiles.has('index.vue') || !siblingExists(absolute)) {
      continue;
    }
    warnings.push({
      code: 'FLM3001',
      file: relativeTo(input.projectDir, absolute),
      message:
        `"${relativeTo(input.projectDir, absolute)}" has no index page, so it is not a route ` +
        'record of its own; every root-level page renders it through `meta.layout`. Add an ' +
        '`index.vue` to make it the record for `/`, or move the layout to the directory it wraps.',
    });
  }

  // Pass 1: a record per layout, shallowest first.
  for (const dir of [...dirs].toSorted(byDepthThenName)) {
    const absolute = layoutFiles.get(dir);
    if (absolute === undefined) {
      continue;
    }
    const segments = segmentsOf(dir);
    const parent = dir === '' ? undefined : nearestLayout(splitPath(dir).dir);
    const { path, params } = pathOfPage(segments, 'index.vue');
    const indexInside = dir === '' ? 'index.vue' : `${dir}/index.vue`;
    const indexPage = pageFiles.get(indexInside);
    // A pathless layout is the record for `/` when it owns that page itself: its `index.vue` child
    // takes the empty segment, which vue-router matches together with the parent. Without an index
    // page it renders `/` through a redirect to the root page that owns a static spelling (a static
    // sibling, or a dynamic page at its variable's default), and when no root page has one the
    // layout has no record at all: its pages render it themselves (`meta.layout`).
    const indexPath = path !== '/' ? undefined : staticAnchor();
    if (path === '/' && indexPage === undefined && indexPath === undefined) {
      continue;
    }
    push(
      withParent(
        {
          name: nameOfLayout(segments),
          path,
          segment: segmentOf(path, parent),
          kind: 'layout',
          component: absolute,
          params,
          loaders: loadersOf(
            relativeTo(input.projectDir, absolute),
            candidatesOf(absolute, 'layout'),
            path,
            params.map((param) => param.name),
          ),
          children: [],
          indexRedirect: indexPath,
          group: undefined,
        },
        parent,
      ),
    );
  }

  // Pass 2: a record per page. The catch-all files are planned last, after every page and index page
  // has a record: a catch-all nests under the record that renders its directory's URL, and that
  // record is what the rest of this pass adds.
  const pageEntries = [...pageFiles.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const catchAllPass of [false, true]) {
    for (const [inside, absolute] of pageEntries) {
      const { dir, file } = splitPath(inside);
      if (isNotFoundFile(file) !== catchAllPass) {
        continue;
      }
      const segments = segmentsOf(dir);
      const { path, params } = pathOfPage(segments, file);
      const name = nameOfPage(segments, file);
      if (byName.has(name)) {
        warnings.push({
          code: 'FLM3001',
          file: relativeTo(input.projectDir, absolute),
          message: `"${relativeTo(input.projectDir, absolute)}" plans the same route name "${name}" as another file; the first one wins.`,
        });
        continue;
      }
      const catchAll = isNotFoundFile(file);
      // A catch-all is the 404 of its own subtree: vue-router matches a `:pathMatch(.*)*` child, so
      // the record nests under the record that renders its directory's URL, or under the nearest
      // record above it with the directories in between spelled out. Nothing is flattened to the top
      // level, which would make every `404.vue` in the tree match the whole app. The pages root is
      // the one directory with no record above it, so the root catch-all stays top-level when no
      // root layout hosts it.
      const anchored = catchAll ? catchAllAnchor(dir) : undefined;
      if (catchAll && anchored === undefined && dir !== '') {
        warnings.push({
          code: 'FLM3010',
          file: relativeTo(input.projectDir, absolute),
          message: catchAllOrphanMessage(dir),
        });
        continue;
      }
      // The pages root has no record above it, so a root catch-all that no layout hosts is the
      // top-level record it always was: `/:pathMatch(.*)*`, whose absolute path is the route itself.
      const anchoredSegment = catchAll
        ? (anchored?.segment ?? `:${CATCH_ALL_PARAM}(.*)*`)
        : undefined;
      const parent = catchAll ? anchored?.parent : layoutForPage(dir, file);

      const directoryParams = segments.flatMap((segment) => {
        const parsed = parseSegment(segment);
        return parsed === undefined ? [] : [parsed.name];
      });
      // A page whose nearest layout has no record of its own (a pathless layout that owns no page)
      // renders that layout itself: `meta.layout` is what `defineFlammeRoutes` reads for it, so the
      // page keeps its single source of truth (its own loader) and the shell still wraps it.
      const ownLayout =
        parent === undefined || byName.has(parent) ? undefined : layoutFiles.get(dir);
      // A page that renders its own layout is a top-level record: its would-be parent has no record.
      const attached = ownLayout === undefined ? parent : undefined;
      push(
        withParent(
          {
            name,
            // a catch-all's URL is its directory's, which the anchor spelled in param form
            path: catchAll ? (anchored?.path ?? path) : path,
            segment:
              ownLayout !== undefined
                ? path
                : catchAll
                  ? (anchoredSegment ?? path)
                  : segmentOf(path, parent),
            kind: 'page',
            component: absolute,
            params,
            loaders: loadersOf(
              relativeTo(input.projectDir, absolute),
              candidatesOf(absolute, 'page'),
              path,
              // The catch-all param is added even though no variable is named after it: it is what
              // the record's `params` list reports, and a directory param stays available on the
              // catch-all record so `[id]/404.vue` can read `$id` from the URL it caught.
              [...new Set([...directoryParams, ...params.map((param) => param.name)])],
            ),
            children: [],
            indexRedirect: undefined,
            group: undefined,
            ...(ownLayout === undefined ? {} : { layout: ownLayout }),
          },
          attached,
        ),
      );
    }
  }

  // Pass 3: a record per route group, shallowest first, so a nested group can nest under the group
  // record that encloses it. The record is a pathless `page`: it carries the group's own document
  // as its loader and the group's `+page.vue` as its component, and `defineFlammeRoutes` composes
  // the group's `+layout.vue` around that component exactly as it does for a page with a layout.
  for (const dir of [...groupDirectories].toSorted(byDepthThenName)) {
    const group = groupNameOf(lastSegmentOf(dir));
    const component = groupComponents.get(dir);
    if (group === undefined || component === undefined) {
      // FLM3005 (and FLM3006, when the document is missing too) already named the file to add.
      continue;
    }
    const candidates = groupCandidatesOf(dir);
    const queries = candidates.filter(
      (candidate) =>
        candidate.document.kind === 'query' && queryOperationName(candidate.document) !== undefined,
    );
    if (queries.length === 0) {
      // The document is there but carries no query, so the group would silently have no loader.
      const declared = groupDocuments.get(dir) ?? groupModules.get(dir);
      if (declared !== undefined) {
        warnings.push({
          code: 'FLM3006',
          file: relativeTo(input.projectDir, declared),
          message:
            `"${relativeTo(input.projectDir, declared)}" declares no query, so the route group ` +
            `"${pagesPrefix}${dir}" has no loader; a group's document is a query (or a ` +
            '"Page" export that resolves to one).',
        });
      }
      continue;
    }
    // A group contributes no URL segment, so it needs the record that renders the URL it sits in.
    // A top-level group nests under the root `index` page and nowhere else: the root layout's own
    // `path: '/'` would be taken by the pathless group (vue-router reads a redirect from the last
    // matched record, so the layout's `/` redirect would die with it) and a root `index.vue` beside
    // it would be left in no match at any URL.
    const enclosing = parentDirectoryOf(dir);
    const parentName = enclosing === '' ? rootIndexRecord() : recordOfDirectory(enclosing);
    const parent = parentName === undefined ? undefined : byName.get(parentName);
    if (parentName === undefined || parent === undefined) {
      warnings.push({
        code: 'FLM3009',
        file: joinPath(pagesPrefix, dir),
        message: orphanGroupMessage(dir, enclosing),
      });
      continue;
    }
    const name = nameOfGroup(parentName, group);
    if (byName.has(name)) {
      warnings.push({
        code: 'FLM3001',
        file: relativeTo(input.projectDir, component),
        message:
          `"${relativeTo(input.projectDir, component)}" plans the same route name "${name}" as ` +
          'another file; the first one wins.',
      });
      continue;
    }
    const params = parent?.params ?? [];
    const layout = groupLayouts.get(dir);
    const documentFile = groupDocuments.get(dir);
    groupNames.set(dir, name);
    push(
      withParent(
        {
          name,
          // A group contributes no URL segment: vue-router matches the record together with its
          // parent, which is the URL the group's section renders at.
          path: '',
          segment: '',
          kind: 'page',
          component,
          params,
          loaders: loadersOf(
            // The file the loader's document lives in: the group's own document, or the page module
            // that exports it. A diagnostic about the document names that file, not the component.
            documentFile === undefined
              ? relativeTo(input.projectDir, component)
              : relativeTo(input.projectDir, documentFile),
            candidates,
            parent?.path ?? '',
            params.map((param) => param.name),
          ),
          children: [],
          indexRedirect: undefined,
          group,
          ...(layout === undefined ? {} : { layout }),
        },
        parentName,
      ),
    );
  }

  // Pass 3: wire the children, pages first and the nested layout last.
  for (const route of routes) {
    if (route.kind !== 'layout') {
      continue;
    }
    const dir = route.name === '+layout' ? '' : route.name.slice(0, -'.+layout'.length);
    const childNames: string[] = [];
    for (const inside of pageFiles.keys()) {
      if (splitPath(inside).dir !== dir) {
        continue;
      }
      const child = nameOfPage(dir === '' ? [] : dir.split('/'), splitPath(inside).file);
      if (byName.has(child)) {
        childNames.push(child);
      }
    }
    for (const childDir of layoutFiles.keys()) {
      if (childDir === dir || (dir !== '' && splitPath(childDir).dir !== dir)) {
        continue;
      }
      if (dir === '' && childDir === '') {
        continue;
      }
      const child = nameOfLayout(childDir === '' ? [] : childDir.split('/'));
      if (byName.has(child)) {
        childNames.push(child);
      }
    }
    (route as { children: readonly string[] }).children = [...new Set(childNames)].toSorted();
  }

  // A nested record is a child of the record it nests under: that is the record whose component
  // renders `<RouterView />` where the section goes, and the plan says so. Two kinds of record nest
  // this way: a route group, under the route it sits in, and a catch-all, under the record that owns
  // its directory's URL (`admin`) or the nearest record above it (`admin.nested`).
  for (const route of routes) {
    if (route.parent === undefined) {
      continue;
    }
    const host = byName.get(route.parent);
    if (host === undefined) {
      continue;
    }
    (host as { children: readonly string[] }).children = [...host.children, route.name];
  }
  for (const route of routes) {
    (route as { children: readonly string[] }).children = [...new Set(route.children)].toSorted();
  }

  for (const route of routes) {
    for (const loader of route.loaders) {
      if (artifacts.size > 0 && !artifacts.has(loader.document)) {
        warnings.push({
          code: 'FLM3002',
          file: loader.source,
          message:
            `"${loader.source}" declares "${loader.document}" but the compiler emitted no such ` +
            'artifact; the route will have no loader for it.',
        });
      }
    }
  }

  const sorted = routes.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    routes: sorted,
    roots: sorted.filter((route) => route.parent === undefined).map((route) => route.name),
    pagesDir: routing.pagesDir,
    projectDir: input.projectDir,
    runtimeDir: input.runtimeDir,
    documentFile: routing.documentFile,
    layoutDocumentFile: routing.layoutDocumentFile,
    documentFiles: routing.documentFiles,
    layoutDocumentFiles: routing.layoutDocumentFiles,
    loaders: routing.loaders,
    warnings: warnings.toSorted((a, b) => {
      if (a.file !== b.file) {
        return a.file < b.file ? -1 : 1;
      }
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    }),
  };
}
