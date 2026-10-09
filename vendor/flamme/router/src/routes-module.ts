/**
 * The generated route module (REQ-1, REQ-3).
 *
 * `emitRoutesModule` renders a {@link RoutePlan} into the `$flamme/routes` module the app imports: a
 * flat list of vue-router records with their loaders, ready for `createFlammeRouter` and for
 * `usePageQuery`. The rendering is pure (plan in, source out), so the module's shape is asserted by
 * golden tests and the Vite plugin only has to write the string.
 *
 * ## The generated shape
 *
 * ```ts
 * import { createPageLoader, defineFlammeRoutes, type FlammeRoute } from '@flamme/router/auto'
 * import Info from '$flamme/artifacts/Info'
 *
 * export const records: readonly FlammeRoute[] = [
 *   {
 *     name: '[id]',
 *     path: '/:id',
 *     meta: { flamme: 'page' },
 *     component: () => import('../src/pages/[id].vue'),
 *     params: ['id'],
 *     loaders: [
 *       {
 *         load: (client) => createPageLoader(client, Info, [...]),
 *       },
 *     ],
 *   },
 *   {
 *     name: '[id]/404',
 *     path: '/:id',
 *     parent: '[id]',
 *     // the path relative to the parent: vue-router reads a child's `path` against its parent's,
 *     // and a catch-all is a child of the record that owns its directory
 *     segment: ':pathMatch(.*)*',
 *     meta: { flamme: 'page' },
 *     component: () => import('../src/pages/[id]/404.vue'),
 *     params: ['id', 'pathMatch'],
 *     loaders: [],
 *   },
 * ]
 *
 * export const pages = { '[id]': { file: 'src/pages/[id].vue', path: '/:id', params: ['id'], documents: ['Info'] } }
 * export default defineFlammeRoutes(records)
 * ```
 *
 * ## Lazy components
 *
 * Every page and layout record imports its component lazily — `component: () => import(...)` — so a
 * route's code is a chunk of its own and the entry bundle carries the shell, the router and the
 * artifacts but no page. Nothing else changes: the loader factories stay eager (they are data, not
 * components), so `meta.loaders` is complete before the first navigation and the request counts are
 * the same. `defineFlammeRoutes` resolves a lazy component when it has to compose a layout around a
 * page (`meta.layout`), which is the one place a raw loader is not yet a component.
 *
 * `defineFlammeRoutes` (in `@flamme/router/auto`) turns the flat list into nested vue-router records
 * at runtime, so the generated file never has to know how vue-router nests children.
 */

import { relative } from 'node:path';

import { toPosix } from '@flamme/core';

import type { ComposedRecord, RouteComposition } from './compose-documents.js';
import type { RoutePlan, PlannedLoader, PlannedRoute } from './routes-plan.js';
import type { RouteParamSource } from './variables.js';

/** One artifact import the generated module declares. */
export interface RouteImport {
  /** The module specifier, as written (`$flamme/artifacts/<Name>`). */
  readonly specifier: string;
  /** The local binding. */
  readonly local: string;
}

/** A generated module: its source and the maps the caller may want to assert on. */
export interface EmittedRoutes {
  /** The module source, LF-terminated. */
  readonly code: string;
  /** Artifact name -> the local binding it is imported under. */
  readonly artifacts: ReadonlyMap<string, string>;
  /**
   * Component absolute path -> the specifier its lazy import uses (`() => import('...')`). Every
   * component is a dynamic import, so there is no local binding to report; this is the specifier the
   * generated record hands the bundler.
   */
  readonly components: ReadonlyMap<string, string>;
  /**
   * Every generated file, relative to `runtimeDir`, besides {@link code} itself: one typed record
   * module per record that declares a loader, and the `records.ts` barrel that re-exports them.
   *
   * The record modules are what makes `usePageQuery()` need no type argument: the Vite plugin
   * rewrites a route component's import to the module of the record that renders it (see
   * {@link recordSpecifierOf}), so the call site is typed to its own document.
   */
  readonly files: ReadonlyMap<string, string>;
  /**
   * Component absolute path -> the record module that types its `usePageQuery()`. The plugin's
   * rewrite consults this map; a component that is not a route component is absent.
   */
  readonly records: ReadonlyMap<string, RecordModule>;
}

/** One record module: where it lives, what app code calls it and which document it loads. */
export interface RecordModule {
  /** The specifier app code uses (`$flamme/records/index`). */
  readonly specifier: string;
  /** The module's path relative to `runtimeDir` (`records/index.ts`). */
  readonly file: string;
  /** The document the record's loader runs. */
  readonly document: string;
}

/** One character a JS string literal has to escape, mapped to its escape. */
const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** A single-quoted JS string literal, safe for any path or document name. */
function quote(value: string): string {
  return `'${value.replaceAll(/[\\'\n\r\t\u2028\u2029]/gu, (character) => STRING_ESCAPES[character] ?? character)}'`;
}

/** `true` for a name that needs no quoting as an object key. */
function isIdentifierKey(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name);
}

/** An object key, quoted only when it has to be. */
function key(value: string): string {
  return isIdentifierKey(value) ? value : quote(value);
}

/** One `params` entry, as emitted. */
function paramLiteral(source: RouteParamSource): string {
  const parts = [`variable: ${quote(source.variable)}`, `param: ${quote(source.param)}`];
  if (source.coercion !== undefined) {
    parts.push(`coercion: ${quote(source.coercion)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

/** The `params` literal of one loader, empty when the document takes no route params. */
function paramsLiteral(loader: PlannedLoader): string {
  return `[${loader.params.map(paramLiteral).join(', ')}]`;
}

/** The local binding for one artifact, derived from the document name. */
function artifactBinding(name: string): string {
  return `Doc${name.replaceAll(/[^A-Za-z0-9_$]/gu, '_')}`;
}

/**
 * Renders the `$flamme/routes` module for one plan.
 *
 * `composition` is the route composition (`planComposition`), when the project composes
 * (`routing.compose: 'route'`). A composing record's module entry gains the composed loader in
 * `loaders`, moves its own document loaders into `unattachedLoaders` (`meta.pageLoaders`, which
 * `usePageQuery()` reads first) and carries its `composedChain`. A record the composition left
 * alone - and every record when `composition` is absent - is emitted exactly as before, so
 * `routing.compose: 'document'` reproduces the previous generated module byte for byte.
 */
export function emitRoutesModule(plan: RoutePlan, composition?: RouteComposition): EmittedRoutes {
  const components = new Map<string, string>();
  const artifacts = new Map<string, string>();
  const imports: RouteImport[] = [];
  const records = emitRecordModules(plan);

  /** The specifier of a page component: a relative import from the generated directory. */
  const specifierOf = (absolute: string): string => {
    const path = toPosix(relative(plan.runtimeDir, absolute));
    return path.startsWith('.') ? path : `./${path}`;
  };

  /** The lazy-import expression of one component, remembered so each specifier is written once. */
  const componentOf = (absolute: string): string => {
    const existing = components.get(absolute);
    if (existing !== undefined) {
      return existing;
    }
    const specifier = specifierOf(absolute);
    components.set(absolute, specifier);
    return specifier;
  };
  const artifactOf = (name: string): string => {
    const existing = artifacts.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const local = artifactBinding(name);
    artifacts.set(name, local);
    imports.push({ specifier: `$flamme/artifacts/${name}`, local });
    return local;
  };

  const routeLines: string[] = [];
  const background = plan.loaders === 'background';
  for (const route of plan.routes) {
    routeLines.push(
      recordSource(
        route,
        componentOf,
        artifactOf,
        composition?.records.get(route.name),
        background,
      ),
    );
  }
  const composes = plan.routes.some((route) => composition?.records.has(route.name) === true);
  const byName = new Map(plan.routes.map((route) => [route.name, route]));

  const header = [
    '// GENERATED by @flamme/vite — do not edit.',
    '//',
    '// The filesystem route table: one record per page (and per layout), with the loader each of',
    '// their documents needs. Edit the pages under ' + quote(plan.pagesDir) + ' instead.',
    '',
    'import {',
    ...(composes ? ['  createComposedPageLoader,'] : []),
    '  createPageLoader,',
    '  defineFlammeRoutes,',
    '  type FlammeRoute,',
    '  type PageData,',
    "} from '@flamme/router/auto'",
  ];
  // Components are dynamic imports written inline on their record, so the only static imports the
  // generated module declares are the artifacts.
  const artifactImports = imports
    .filter((entry) => entry.specifier.startsWith('$flamme/'))
    .toSorted((a, b) => (a.specifier < b.specifier ? -1 : a.specifier > b.specifier ? 1 : 0))
    .map((entry) => `import ${entry.local} from ${quote(entry.specifier)}`);

  // Every page with a loader, paired with the first loader's document. The registry below is typed
  // from the same imports the records use, so a page gets its own query's data type.
  const typed = plan.routes.flatMap((route) => {
    const loader = route.loaders[0];
    return loader === undefined ? [] : [{ route, loader }];
  });
  const body = [
    '',
    '/**',
    ' * The route records, flat: `defineFlammeRoutes` nests them from each record’s parent, and the',
    ' * nested `routes` below is for a caller that installs vue-router directly. This is the table',
    ' * `createFlammeRouter()` composes and installs (through the `$flamme/auto-routes` shim), and',
    ' * what a caller that needs to reshape a record (a test swapping one page component in, a tool',
    ' * listing the loaders) rebuilds from.',
    ' */',
    'export const records: readonly FlammeRoute[] = [',
    ...routeLines,
    ']',
    '',
    '/**',
    ' * What the generator knew about each page: its file, its path, its params and the documents',
    ' * its loader runs. Exported for typed links and for tests, never read by the router.',
    ' */',
    'export const pages = {',
    ...plan.routes.map((route) => pageEntry(route, byName, plan)),
    '} as const',
    '',
    '/**',
    ' * Every page’s own query handle, keyed by route name.',
    ' *',
    ' * `createFlammeRouter` builds these loaders; the module re-creates them here only to name their',
    ' * types. The casts are the one place the generator bridges "the record’s loader is what the page',
    ' * declares" (a runtime invariant it guarantees by construction) to TypeScript, which cannot see',
    ' * through vue-router’s merged `meta`. `usePageQuery()` reads the real one from the route.',
    ' */',
    'export const pageQueries = {',
    ...typed.map(
      ({ route, loader }) =>
        `  ${key(route.name)}: null as unknown as PageData<typeof ${artifactOf(loader.document)}>,`,
    ),
    '} as const',
    '',
    "declare module '@flamme/router/auto' {",
    '  /**',
    '   * The pages this app declares, as a type registry (REQ-1). `usePageQuery()` is typed against',
    '   * `FlammeGeneratedRoutes[keyof FlammeGeneratedRoutes]`, so a page gets its own query’s data,',
    '   * errors and pagination surface with no type argument at either end.',
    '   *',
    '   * This is a **module augmentation**, not a global one: the registry is declared (and',
    '   * documented) by `@flamme/router/auto`, and this module is what fills it for this app.',
    '   */',
    '  interface FlammeGeneratedRoutes {',
    ...typed.map(
      ({ route, loader }) =>
        `    readonly ${key(route.name)}: PageData<typeof ${artifactOf(loader.document)}>`,
    ),
    '  }',
    '}',
    '',
    '/**',
    ' * The generated route table, nested by `defineFlammeRoutes` and typed as vue-router records, for',
    ' * a caller that installs vue-router directly. `createFlammeRouter()` installs the flat `records`',
    ' * above instead (through the `$flamme/auto-routes` shim), because composition reads `parent`',
    ' * links off the flat table.',
    ' */',
    'export const routes = defineFlammeRoutes(records)',
    '',
    'export default routes',
    '',
  ];

  // The barrel re-exports every record module, so the generated tree carries the typed composables
  // under `$flamme/records` as well as under their own module path. It is added last, after the
  // route table, so a reader of `routes.ts` meets the table first.
  const files = new Map<string, string>(records.files);
  files.set(RECORDS_INDEX_FILE, records.barrel);

  return {
    code: [...header, ...artifactImports, ...body].join('\n'),
    artifacts,
    components,
    files,
    records: records.specifiers,
  };
}

/** The barrel module that re-exports every record module, relative to `runtimeDir`. */
export const RECORDS_INDEX_FILE = 'records.ts';

/** The directory the record modules live in, relative to `runtimeDir`. */
export const RECORDS_DIRECTORY = 'records';

/**
 * The record modules of one plan: the typed `usePageQuery()` of each record that declares a loader.
 *
 * ## Why the module exists
 *
 * Which record renders a component is a runtime fact, so TypeScript cannot narrow
 * `usePageQuery()`'s registry union to one record at a call site. The generator knows the record
 * each component belongs to, so it writes a module that fixes the type:
 *
 * ```ts
 * // .flamme/records/index.ts
 * import { usePageQuery as useRecordPageQuery, type PageData } from '@flamme/router/auto'
 * import type DocHome from '../artifacts/Home'
 *
 * export type PageQueryData = PageData<typeof DocHome>
 * export function usePageQuery(options?: UseRouteQueryOptions): RouteQueryHandle<PageQueryData> {
 *   return useRecordPageQuery<PageQueryData>(options)
 * }
 * ```
 *
 * and the plugin rewrites `import { usePageQuery } from '@flamme/router/auto'` in
 * `src/pages/index.vue` (and in a route group's `+page.vue`) to
 * `import { usePageQuery } from '$flamme/records/index'`. The page writes
 * `usePageQuery()` and gets its own document's data; the exported function takes **no type
 * parameter**, so a call site cannot claim a document its record does not load. Runtime is
 * unchanged: the wrapper forwards to the same composable, which reads the loader off the record
 * vue-router is rendering.
 *
 * The artifact is imported **relatively and type-only** (`import type … from '../artifacts/<Name>'`):
 * the module needs the artifact's type, never its value (the route table is what passes the value to
 * `createPageLoader`), and a relative specifier resolves from the generated directory alone without
 * the `$flamme` alias, so a plain Node or vitest import of the module works.
 */
function emitRecordModules(plan: RoutePlan): {
  readonly files: ReadonlyMap<string, string>;
  readonly barrel: string;
  readonly specifiers: ReadonlyMap<string, RecordModule>;
} {
  const files = new Map<string, string>();
  const specifiers = new Map<string, RecordModule>();
  const used = new Set<string>();
  const entries: {
    readonly route: PlannedRoute;
    readonly loader: PlannedLoader;
    readonly name: string;
  }[] = [];
  for (const route of [...plan.routes].toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    // **Page records only.** `usePageQuery()` resolves the loader of the record that is a *page*
    // (a layout record's own loader runs in the navigation guard, but the composable deliberately
    // skips layout records; `packages/router/src/auto.ts` and `apps/docs/content/concepts.md`). A
    // module typed to a layout's document would describe a value the composable never returns, so a
    // layout component keeps the untyped `@flamme/router/auto` import and reads the page's query,
    // exactly as before.
    if (route.kind !== 'page') {
      continue;
    }
    const loader = route.loaders[0];
    if (loader === undefined) {
      continue;
    }
    const name = uniqueRecordName(route.name, used);
    entries.push({ route, loader, name });
    files.set(`${RECORDS_DIRECTORY}/${name}.ts`, recordModuleSource(route, loader, name, plan));
    specifiers.set(route.component, {
      specifier: recordSpecifierOf(name),
      file: `${RECORDS_DIRECTORY}/${name}.ts`,
      document: loader.document,
    });
  }
  const barrel = [
    '// GENERATED by @flamme/vite — do not edit.',
    '//',
    '// One typed `usePageQuery()` per **page** record that declares a loader (a route group',
    '// counts: it is a page record). A page component imports its own through the plugin’s',
    '// rewrite; `$flamme/records/<name>` addresses one directly. A layout record has no module:',
    '// `usePageQuery()` skips layout records by contract.',
    '',
    // The barrel pulls in the route table too, so a consumer that only wants the composables still
    // sees the app's `FlammeGeneratedRoutes` augmentation.
    "export * from './routes'",
    '',
    ...entries.map(
      (entry) => `export * as ${entry.name} from './${RECORDS_DIRECTORY}/${entry.name}.js'`,
    ),
    '',
  ];
  return { files, barrel: barrel.join('\n'), specifiers };
}

/** The specifier app code uses for one record module (`$flamme/records/index`). */
export function recordSpecifierOf(name: string): string {
  return `$flamme/${RECORDS_DIRECTORY}/${name}`;
}

/**
 * A file-name-safe, identifier-safe, collision-free module name for one record.
 *
 * `[id]`, `(types)` and `teams.[teamId]` are route names, not identifiers; every character outside
 * `[A-Za-z0-9_]` becomes `_` (`[[id]]` -> `__id__`, `+layout` -> `_layout`, `not-found` ->
 * `not_found`), and a name that would start with a digit gets a leading `_` (`404` -> `_404`). The
 * module name is both the file name under `records/` and the namespace the barrel exports it as, so
 * one alphabet keeps the two from ever disagreeing.
 *
 * Two records can sanitize onto one name (`[id]` and `_id_`), so a name already taken gets a numeric
 * suffix, assigned in the plan's sorted order, which keeps the generated tree stable.
 */
export function uniqueRecordName(routeName: string, used: Set<string>): string {
  const sanitized = routeName.replaceAll(/[^A-Za-z0-9_]/gu, '_');
  const base = sanitized.length === 0 || /^[0-9]/u.test(sanitized) ? `_${sanitized}` : sanitized;
  let name = base;
  let index = 2;
  while (used.has(name)) {
    name = `${base}__${index}`;
    index += 1;
  }
  used.add(name);
  return name;
}

/** One record module, as source. */
function recordModuleSource(
  route: PlannedRoute,
  loader: PlannedLoader,
  name: string,
  plan: RoutePlan,
): string {
  const component = toPosix(relative(plan.projectDir, route.component));
  return [
    '// GENERATED by @flamme/vite — do not edit.',
    '//',
    `// The typed \`usePageQuery()\` of the route record ${quote(route.name)}`,
    `// (${component}, loading ${quote(loader.document)}).`,
    '//',
    `// import { usePageQuery } from ${quote(recordSpecifierOf(name))}`,
    '',
    'import {',
    '  usePageQuery as useRecordPageQuery,',
    '  type PageData,',
    '  type RouteQueryHandle,',
    '  type UseRouteQueryOptions,',
    "} from '@flamme/router/auto'",
    `import type ${artifactBinding(loader.document)} from '../artifacts/${loader.document}'`,
    '',
    `/** The data this record's loader produces (the ${quote(loader.document)} document). */`,
    `export type PageQueryData = PageData<typeof ${artifactBinding(loader.document)}>`,
    '',
    '/**',
    ` * This record's own page query: \`usePageQuery()\` from \`@flamme/router/auto\`, typed to`,
    " * the document this record's loader runs. The runtime is the same call, so the loader still",
    ' * comes from the record that renders the calling component; the type parameter is fixed here',
    ' * and is deliberately not part of this function’s signature.',
    ' */',
    `export function usePageQuery(options?: UseRouteQueryOptions): RouteQueryHandle<PageQueryData> {`,
    '  return useRecordPageQuery<PageQueryData>(options)',
    '}',
    '',
    'export default usePageQuery',
    '',
  ].join('\n');
}

/** One page's metadata entry in the generated `pages` map. */
function pageEntry(
  route: PlannedRoute,
  byName: ReadonlyMap<string, PlannedRoute>,
  plan: RoutePlan,
): string {
  const documents = route.loaders.map((loader) => loader.document);
  const file = toPosix(relative(plan.projectDir, route.component));
  const info = [
    `file: ${quote(file)}`,
    `path: ${quote(urlPathOf(route, byName))}`,
    `params: [${route.params.map((param) => quote(param.name)).join(', ')}]`,
    `documents: [${documents.map((document) => quote(document)).join(', ')}]`,
  ];
  return `  ${key(route.name)}: { ${info.join(', ')} },`;
}

/**
 * The URL a `pages` entry advertises.
 *
 * A route group's own `path` is `''`, because vue-router matches the record together with its
 * parent; the entry would hand a typed-link consumer an empty path where the URL its record renders
 * at is the enclosing route's, so the nearest ancestor's absolute path is written instead.
 */
function urlPathOf(route: PlannedRoute, byName: ReadonlyMap<string, PlannedRoute>): string {
  let current = route;
  const seen = new Set<string>([current.name]);
  while (current.path === '' && current.parent !== undefined && !seen.has(current.parent)) {
    const parent = byName.get(current.parent);
    if (parent === undefined) {
      break;
    }
    seen.add(parent.name);
    current = parent;
  }
  return current.path === '' ? route.path : current.path;
}

/** One route record, as source. */
function recordSource(
  route: PlannedRoute,
  componentOf: (specifier: string) => string,
  artifactOf: (name: string) => string,
  composed?: ComposedRecord,
  background = false,
): string {
  const lines: string[] = ['  {'];
  lines.push(`    name: ${quote(route.name)},`);
  lines.push(`    path: ${quote(route.path)},`);
  if (route.parent !== undefined) {
    lines.push(`    parent: ${quote(route.parent)},`);
    // A nested record also carries the path **relative to its parent**, which is the field
    // `defineFlammeRoutes` nests by: vue-router reads a child's path against its parent's, so the
    // absolute `path` above would double the parent's segments (`admin/admin/settings`).
    lines.push(`    segment: ${quote(route.segment)},`);
  }
  lines.push(`    meta: { flamme: ${quote(route.kind)} },`);
  lines.push(`    component: () => import(${quote(componentOf(route.component))}),`);
  if (route.layout !== undefined) {
    lines.push(`    layout: () => import(${quote(componentOf(route.layout))}),`);
  }
  const params = [...new Set(route.params.map((param) => param.name))];
  lines.push(`    params: [${params.map((param) => quote(param)).join(', ')}],`);
  if (route.indexRedirect !== undefined) {
    lines.push(`    redirect: ${quote(route.indexRedirect)},`);
  }
  if (composed === undefined) {
    if (route.loaders.length === 0) {
      lines.push('    loaders: [],');
    } else {
      lines.push('    loaders: [');
      for (const loader of route.loaders) {
        lines.push(...loaderSource(loader, artifactOf, background));
      }
      lines.push('    ],');
    }
    lines.push('  },');
    return lines.join('\n');
  }
  // A composing record: the composed loader is what the navigation guard runs, and the record's own
  // document loaders become `unattachedLoaders` - `meta.pageLoaders`, which `usePageQuery()` reads
  // first, so a component still reads (and masks) its own document and refetch/paginate still send
  // the participant artifact.
  lines.push('    loaders: [');
  lines.push(...composedLoaderSource(composed, artifactOf, background));
  lines.push('    ],');
  if (route.loaders.length > 0) {
    lines.push('    unattachedLoaders: [');
    for (const loader of route.loaders) {
      lines.push(...loaderSource(loader, artifactOf, background));
    }
    lines.push('    ],');
  }
  lines.push(`    composedChain: [${composed.chain.map((name) => quote(name)).join(', ')}],`);
  lines.push('  },');
  return lines.join('\n');
}

/** The composed loader entry of one record, as source. */
function composedLoaderSource(
  composed: ComposedRecord,
  artifactOf: (name: string) => string,
  background = false,
): readonly string[] {
  const params = `[${composed.params.map(paramLiteral).join(', ')}]`;
  const chain = `[${composed.chain.map((name) => quote(name)).join(', ')}]`;
  // `routing.loaders: 'background'` writes the fifth argument on every generated loader, so the
  // route's own documents (the composed operation and each participant) agree on how the
  // navigation treats them.
  const backgroundArg = background ? ', true' : '';
  const call =
    `(client) => createComposedPageLoader(client, ${artifactOf(composed.name)}, ` +
    `${params}, ${chain}${backgroundArg})`;
  const single = `        load: ${call},`;
  const lines = ['      {'];
  if (single.length <= MAX_SINGLE_LINE) {
    lines.push(single);
    lines.push('      },');
    return lines;
  }
  lines.push('        load: (client) =>');
  lines.push('          createComposedPageLoader(');
  lines.push('            client,');
  lines.push(`            ${artifactOf(composed.name)},`);
  lines.push(`            ${params},`);
  lines.push(`            ${chain},`);
  if (background) {
    lines.push('            true,');
  }
  lines.push('          ),');
  lines.push('      },');
  return lines;
}

/**
 * The longest `load:` line the emitter keeps on one line, so a generated file stays readable
 * without depending on a formatter. A loader with one coerced param (the common case) fits.
 */
const MAX_SINGLE_LINE = 140;

/** One loader entry, as source. */
function loaderSource(
  loader: PlannedLoader,
  artifactOf: (name: string) => string,
  background = false,
): readonly string[] {
  // The policy parameter is `undefined` when the document declares none, which is the only way to
  // reach the background argument positionally.
  const call =
    `(client) => createPageLoader(client, ${artifactOf(loader.document)}, ` +
    `${paramsLiteral(loader)}${background ? ', undefined, true' : ''})`;
  const single = `        load: ${call},`;
  const lines = ['      {'];
  if (single.length <= MAX_SINGLE_LINE) {
    lines.push(single);
  } else {
    // A wrapped call keeps the generated file readable without depending on a formatter.
    lines.push('        load: (client) =>');
    lines.push('          createPageLoader(');
    lines.push('            client,');
    lines.push(`            ${artifactOf(loader.document)},`);
    lines.push(`            ${paramsLiteral(loader)},`);
    if (background) {
      lines.push('            undefined,');
      lines.push('            true,');
    }
    lines.push('          ),');
  }
  lines.push('      },');
  return lines;
}
