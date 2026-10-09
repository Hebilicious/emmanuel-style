/**
 * Configuration loading and resolution (`spec/spec.md` §4.1): the config file,
 * its defaults, validation, and the plugin `config` hook seam.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CachePolicy } from './contract.js';
import { ConfigError, errorMessage, formatDiagnostic, type Diagnostic } from './diagnostics.js';
import { orderByEnforce, pluginFailureDiagnostic, type CompilerPlugin } from './plugins/host.js';
import {
  DEFAULT_LAYOUT_DOCUMENT_FILE,
  DEFAULT_PAGE_DOCUMENT_FILE,
  LAYOUT_MODULE_FILE,
  PAGE_MODULE_FILE,
} from './page-module.js';

export { ConfigError };
/**
 * The plugin contract lives in the host (`./plugins/host.ts`); it is re-exported
 * here because `FlammeConfig.plugins` is where a config file meets it.
 */
export type { CompilerPlugin, DiagnosticSink, EmitContext } from './plugins/host.js';
import { matchesAny } from './glob.js';
import { toPosix } from './offsets.js';

/** Custom scalar mapping. `type` is the TS type; `module` emits an import. */
export interface ScalarConfig {
  /** TypeScript type of a parsed value. */
  readonly type: string;
  /** Module to import `type` from (e.g. `decimal.js`). */
  readonly module?: string;
  /** Import as a default export. */
  readonly default?: boolean;
}

/** Per-type cache-key configuration. */
export interface TypeConfig {
  /** Fields that make up the record id, in order. */
  readonly keys?: readonly string[];
}

/**
 * Filesystem routing conventions (`research/routing-report.md`, REQ-1).
 *
 * `src/pages/**` is the route table; this is the only knob the convention needs. It is declared
 * structurally here rather than imported from `@flamme/router`, because the compiler must not
 * depend on a runtime package: the router's `FlammeRoutingConfig` is assignable to this shape, so a
 * config file can be typed with either.
 *
 * **The convention also owns its page-query surfaces.** A page's `+page.gql` and `+page.ts` (and a
 * layout's `+layout.gql` and `+layout.ts`) are compiler inputs by convention, so `resolveConfig`
 * adds one recursive glob per surface file name under `pagesDir` to the resolved `include` (see
 * `withRoutingDocuments`).
 * A project whose own `include` globs are narrow (for example only `.vue` files) therefore still
 * compiles the document that its page’s loader comes from, without listing it by hand.
 * The retired named-document spelling is not among those surfaces; the route planner reports it as
 * `FLM3007` from its own walk of the pages directory.
 */
export interface RoutingConfig {
  /** Directory that holds the pages, relative to `projectDir`. Default `src/pages`. */
  readonly pagesDir?: string;
  /** The colocated query document next to a page. Default `+page.gql`. */
  readonly documentFile?: string;
  /** The colocated query document next to a `+layout.vue`. Default `+layout.gql`. */
  readonly layoutDocumentFile?: string;
  /**
   * Every file extension the compiler treats as a GraphQL document: `.gql` and `.graphql` by
   * default. The extension decides four things that have to agree, and this is the one knob they
   * all read:
   *
   * - the **discovery globs** (`include` defaults to `src/**\/*.{vue,ts,tsx,gql,graphql}`, built
   *   from this list);
   * - **extraction**: a file with one of these extensions is a document, whole-file;
   * - the **route document names**: `documentFile`/`layoutDocumentFile` contribute their stem, and
   *   each configured extension makes a name (`+page.gql` → `+page.gql` and `+page.graphql`), so a
   *   page may write its query to whichever extension the project allows;
   * - the **ambient declarations** `ambient.d.ts` writes, one `declare module` per document per
   *   extension (the `<star>/<Name><ext>` spelling a default import resolves against);
   * - the **import rewrite**: an `import Doc from './Doc<ext>'` is an artifact import.
   *
   * An entry may be written with or without its leading dot (`'graphql'` and `'.graphql'` are the
   * same extension); the resolved config carries the dotted, lowercased form. Narrowing the list
   * (for example `['.gql']`) makes the other extensions ordinary source files again.
   */
  readonly documentExtensions?: readonly string[];
  /**
   * Which surface a page's query comes from when it declares more than one:
   * `auto` (the default) prefers the colocated document file, `colocated` and
   * `page-module` pick that surface explicitly.
   */
  readonly document?: 'auto' | 'colocated' | 'page-module';
  /**
   * Whether a navigation issues one composed request or one request per document
   * (`research/route-composition-design.md`).
   *
   * - `route` (the default) merges each route record's own primary query with every ancestor
   *   record's into one composed operation, so a layout, a page and a route group cost one request.
   * - `document` keeps one loader per document, byte for byte, which is the escape hatch for a
   *   project with a frozen server-side operation allowlist.
   *
   * A record whose participants cannot be merged (a response-key clash, a variable type clash, a
   * duplicate `@defer` label, a conflicting `@dedupe`) falls back to the per-document topology with
   * a warning whatever this option says.
   */
  readonly compose?: 'route' | 'document';
  /**
   * Whether a generated route's loaders hold the navigation (`await`, the default) or are
   * **background**: the guard commits the navigation and the page renders its own pending state
   * while the read is on the wire (`@flamme/router`'s `QueryLoaderOptions.background`).
   *
   * A server render cannot paint a pending state, so the option is ignored on the server: the guard
   * awaits a background loader there whatever this says.
   */
  readonly loaders?: 'await' | 'background';
  /**
   * Per-route param renames, keyed by the route's path pattern: `{ '/pokemon/:id': { pokemonId:
   * 'id' } }` reads `params.pokemonId` into `$id`. The convention (a param named like the variable)
   * covers everything else.
   */
  readonly params?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The user-facing config, exactly the shape `defineConfig` accepts (§4.1). */
export interface FlammeConfig {
  /** Path to an SDL file. Relative to `projectDir`. Takes precedence over `url`/`schema`. */
  readonly schemaPath?: string;
  /** Introspection JSON file path, an introspection object, or an in-memory SDL string. */
  readonly schema?: string | Readonly<Record<string, unknown>>;
  /** Endpoint to introspect when no schema file exists. `/graphql` for the PoC fixture. */
  readonly url?: string;
  /** Headers sent with an introspection request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Glob(s) to discover documents in. */
  readonly include?: readonly string[];
  /** Globs excluded from discovery. */
  readonly exclude?: readonly string[];
  /** App root. Defaults to the config file's directory. */
  readonly projectDir?: string;
  /** Generated directory. Defaults to `<projectDir>/.flamme`. */
  readonly runtimeDir?: string;
  /** Custom scalar mapping. */
  readonly scalars?: Readonly<Record<string, ScalarConfig>>;
  /** Per-type cache-key configuration. */
  readonly types?: Readonly<Record<string, TypeConfig>>;
  /** Fallback key fields for every type. Default `['id']`. */
  readonly defaultKeys?: readonly string[];
  /** Cache policy baked into every query artifact. */
  readonly defaultCachePolicy?: CachePolicy;
  /** `partial` baked into every query artifact. */
  readonly defaultPartial?: boolean;
  /** `mode` for a bare `@paginate`; `Infinite`, matching Houdini. */
  readonly defaultPaginateMode?: 'SinglePage' | 'Infinite';
  /** Position of a generated list insert without `@prepend`/`@append`. */
  readonly defaultListPosition?: 'first' | 'last';
  /** Target of a generated list operation without `@listTarget`. */
  readonly defaultListTarget?: 'all' | 'single';
  /** Project-wide fragment masking default. */
  readonly defaultFragmentMasking?: 'enable' | 'disable';
  /**
   * Filesystem routing conventions (`research/routing-report.md`): the pages directory, the
   * colocated document name and the per-route param renames. Read by the generator, validated here.
   */
  readonly routing?: RoutingConfig;
  /** Verbosity of the compiler's own reporting. */
  readonly logLevel?: 'error' | 'warn' | 'info' | 'debug';
  /** Compiler plugin hooks. Node-only; see `./plugins/host.ts` and §4.1.2. */
  readonly plugins?: readonly CompilerPlugin[];
}

/** What `loadConfig` returns: every option resolved, no `undefined` left. */
export interface ResolvedConfig extends FlammeConfig {
  readonly projectDir: string;
  readonly runtimeDir: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly types: Readonly<Record<string, TypeConfig>>;
  readonly defaultKeys: readonly string[];
  readonly defaultCachePolicy: CachePolicy;
  readonly defaultPartial: boolean;
  readonly defaultPaginateMode: 'SinglePage' | 'Infinite';
  readonly defaultListPosition: 'first' | 'last';
  readonly defaultListTarget: 'all' | 'single';
  readonly defaultFragmentMasking: 'enable' | 'disable';
  readonly scalars: Readonly<Record<string, ScalarConfig>>;
  readonly logLevel: 'error' | 'warn' | 'info' | 'debug';
  readonly plugins: readonly CompilerPlugin[];
}

/** Config file names searched in `projectDir`, in order. */
export const CONFIG_FILE_NAMES = ['flamme.config.ts', 'graphql.config.ts'] as const;

/** The document extensions a project gets without configuring any. */
export const DEFAULT_DOCUMENT_EXTENSIONS = ['.gql', '.graphql'] as const;

/**
 * Default discovery globs: named extensions so a stray `README.md` is never scanned.
 *
 * `resolveConfig` rebuilds the document half of the brace from `routing.documentExtensions`; this
 * constant is what a caller with no resolved config falls back to (the Vite plugin's HMR ownership
 * rule, a package that has not loaded a config file).
 */
export const DEFAULT_INCLUDE = ['src/**/*.{vue,ts,tsx,gql,graphql}'] as const;

/** Default excludes; `<runtimeDir>` is substituted with the resolved directory name. */
export const DEFAULT_EXCLUDE = ['**/*.d.ts', '**/node_modules/**', '<runtimeDir>/**'] as const;

/** Default generated directory name, relative to `projectDir`. */
export const DEFAULT_RUNTIME_DIR = '.flamme';

/** Built-in scalar mapping; `config.scalars` entries take precedence (§4.1). */
export const BUILT_IN_SCALARS: Readonly<Record<string, string>> = {
  String: 'string',
  ID: 'string',
  Int: 'number',
  Float: 'number',
  Boolean: 'boolean',
};

/** True for a plain object, which is all a config default export has to be. */
function isConfigObject(value: unknown): value is FlammeConfig {
  return typeof value === 'object' && value !== null;
}

/** True for a thenable (a Promise default export), which is rejected as a config (A22). */
function isPromiseLike(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('then' in value)) {
    return false;
  }
  return typeof value.then === 'function';
}

/** Identity helper that gives the config file full type checking and completion. */
export function defineConfig(config: FlammeConfig): FlammeConfig {
  return config;
}

/**
 * Every document extension in effect, from a resolved or unresolved `routing` object.
 *
 * A routing object that names no extensions gets {@link DEFAULT_DOCUMENT_EXTENSIONS}; an empty list
 * is a config error (`resolveConfig` rejects it), so a caller that reads this directly never has to
 * decide what "no extensions" would mean.
 */
export function documentExtensionsOf(routing: unknown): readonly string[] {
  const record = typeof routing === 'object' && routing !== null ? routing : {};
  const value: unknown = Reflect.get(record, 'documentExtensions');
  if (!Array.isArray(value)) {
    return DEFAULT_DOCUMENT_EXTENSIONS;
  }
  const normalized = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizeDocumentExtension)
    .filter((entry): entry is string => entry !== undefined);
  return normalized.length === 0 ? DEFAULT_DOCUMENT_EXTENSIONS : [...new Set(normalized)];
}

/** One extension in its canonical spelling: lowercased and dotted (`gql` → `.gql`). */
function normalizeDocumentExtension(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  const dotted = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  return /^\.[a-z0-9]+$/u.test(dotted) ? dotted : undefined;
}

/**
 * The document file names one routing role accepts, in the order they are tried.
 *
 * `documentFile`/`layoutDocumentFile` name the file and its extension supplies the stem
 * (`+page.gql` → `+page`); every configured extension then spells one name (`+page.gql` and
 * `+page.graphql`). A project that sets a document file whose extension is not configured still
 * gets its stem, with the configured extensions.
 */
export function documentFileNames(routing: unknown, role: 'page' | 'layout'): readonly string[] {
  const record = typeof routing === 'object' && routing !== null ? routing : {};
  const configured: unknown = Reflect.get(
    record,
    role === 'page' ? 'documentFile' : 'layoutDocumentFile',
  );
  const fallback = role === 'page' ? DEFAULT_PAGE_DOCUMENT_FILE : DEFAULT_LAYOUT_DOCUMENT_FILE;
  const name =
    typeof configured === 'string' && configured.length > 0 && !configured.includes('/')
      ? configured
      : fallback;
  const at = name.lastIndexOf('.');
  const stem = at > 0 ? name.slice(0, at) : name;
  return documentExtensionsOf(record).map((extension) => `${stem}${extension}`);
}

/** `true` when `path`'s extension is one of the configured document extensions. */
export function hasDocumentExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

function assertStringArray(value: unknown, option: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError('FLM2001', `"${option}" must be an array of strings.`);
  }
}
function assertOneOf(value: unknown, option: string, allowed: readonly string[]): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ConfigError('FLM2001', `"${option}" must be one of ${allowed.join(', ')}.`);
  }
}

/**
 * Fills in every default and validates the result. Throws `ConfigError` with
 * `FLM2001` for an invalid option; the schema itself is not touched here.
 */
export function resolveConfig(config: FlammeConfig, projectDir: string): ResolvedConfig {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new ConfigError('FLM2001', 'A project directory is required to resolve the config.');
  }
  const root = resolve(projectDir);

  for (const option of ['schemaPath', 'url', 'projectDir', 'runtimeDir'] as const) {
    const value = config[option];
    if (value !== undefined && typeof value !== 'string') {
      throw new ConfigError('FLM2001', `"${option}" must be a string.`);
    }
  }
  if (
    config.schema !== undefined &&
    typeof config.schema !== 'string' &&
    (typeof config.schema !== 'object' || config.schema === null)
  ) {
    throw new ConfigError('FLM2001', '"schema" must be a string or an introspection object.');
  }
  if (config.include !== undefined) {
    assertStringArray(config.include, 'include');
  }
  if (config.exclude !== undefined) {
    assertStringArray(config.exclude, 'exclude');
  }
  if (config.defaultKeys !== undefined) {
    assertStringArray(config.defaultKeys, 'defaultKeys');
  }
  if (config.headers !== undefined && typeof config.headers !== 'object') {
    throw new ConfigError('FLM2001', '"headers" must be an object of strings.');
  }
  if (config.headers !== undefined) {
    for (const [name, value] of Object.entries(config.headers)) {
      if (typeof value !== 'string') {
        throw new ConfigError('FLM2001', `"headers.${name}" must be a string.`);
      }
    }
  }
  if (config.scalars !== undefined) {
    for (const [name, scalar] of Object.entries(config.scalars)) {
      if (typeof scalar !== 'object' || scalar === null || typeof scalar.type !== 'string') {
        throw new ConfigError(
          'FLM2001',
          `"scalars.${name}" must be an object with a "type" string.`,
        );
      }
      if (scalar.module !== undefined && typeof scalar.module !== 'string') {
        throw new ConfigError('FLM2001', `"scalars.${name}.module" must be a string.`);
      }
    }
  }
  if (config.types !== undefined) {
    for (const [name, type] of Object.entries(config.types)) {
      if (typeof type !== 'object' || type === null) {
        throw new ConfigError('FLM2001', `"types.${name}" must be an object.`);
      }
      if (type.keys !== undefined) {
        assertStringArray(type.keys, `types.${name}.keys`);
      }
    }
  }
  if (config.defaultCachePolicy !== undefined) {
    assertOneOf(config.defaultCachePolicy, 'defaultCachePolicy', [
      'CacheOrNetwork',
      'NetworkOnly',
      'CacheAndNetwork',
      'CacheOnly',
    ]);
  }
  if (config.defaultPaginateMode !== undefined) {
    assertOneOf(config.defaultPaginateMode, 'defaultPaginateMode', ['SinglePage', 'Infinite']);
  }
  if (config.defaultListPosition !== undefined) {
    assertOneOf(config.defaultListPosition, 'defaultListPosition', ['first', 'last']);
  }
  if (config.defaultListTarget !== undefined) {
    assertOneOf(config.defaultListTarget, 'defaultListTarget', ['all', 'single']);
  }
  if (config.defaultFragmentMasking !== undefined) {
    assertOneOf(config.defaultFragmentMasking, 'defaultFragmentMasking', ['enable', 'disable']);
  }
  if (config.logLevel !== undefined) {
    assertOneOf(config.logLevel, 'logLevel', ['error', 'warn', 'info', 'debug']);
  }
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) {
    throw new ConfigError('FLM2001', '"plugins" must be an array of plugin objects.');
  }
  if (config.routing !== undefined) {
    assertRouting(config.routing);
  }

  const runtimeDirOption = config.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const runtimeDir = isAbsolute(runtimeDirOption)
    ? runtimeDirOption
    : resolve(root, runtimeDirOption);
  const runtimeDirName = toPosix(relative(root, runtimeDir)) || DEFAULT_RUNTIME_DIR;

  const routing = resolveRouting(config.routing);
  const include = withRoutingDocuments(
    config.include ?? defaultInclude(documentExtensionsOf(routing)),
    routing,
  );
  // A `runtimeDir` inside `include` is self-defeating: `DEFAULT_EXCLUDE` hides it
  // from discovery, so every document under it is invisible, while the emitter
  // still writes the barrel over the user's own file (A21). Reject it loudly.
  if (
    !isAbsolute(runtimeDirOption) &&
    overlapsInclude(
      config.include ?? defaultInclude(documentExtensionsOf(routing)),
      runtimeDirName,
      documentExtensionsOf(routing),
    )
  ) {
    throw new ConfigError(
      'FLM2001',
      `"runtimeDir" (${runtimeDirName}) is inside "include"; move it outside the sources or fix the include globs.`,
    );
  }
  const exclude = (config.exclude ?? DEFAULT_EXCLUDE).map((pattern) =>
    pattern.replaceAll('<runtimeDir>', runtimeDirName),
  );

  let schemaPath = config.schemaPath;
  if (schemaPath === undefined && config.schema === undefined && config.url === undefined) {
    // Houdini's convention-based fallback: `./schema.graphql` when it exists.
    if (existsSync(join(root, 'schema.graphql'))) {
      schemaPath = './schema.graphql';
    } else {
      throw new ConfigError(
        'FLM2001',
        'No schema source: set one of "schemaPath", "schema" or "url" in flamme.config.ts.',
      );
    }
  }

  return {
    ...config,
    ...(schemaPath === undefined ? {} : { schemaPath }),
    projectDir: root,
    runtimeDir,
    routing,
    include,
    exclude,
    scalars: config.scalars ?? {},
    types: config.types ?? {},
    defaultKeys: config.defaultKeys ?? ['id'],
    defaultCachePolicy: config.defaultCachePolicy ?? 'CacheOrNetwork',
    defaultPartial: config.defaultPartial ?? false,
    defaultPaginateMode: config.defaultPaginateMode ?? 'Infinite',
    defaultListPosition: config.defaultListPosition ?? 'last',
    defaultListTarget: config.defaultListTarget ?? 'single',
    defaultFragmentMasking: config.defaultFragmentMasking ?? 'enable',
    logLevel: config.logLevel ?? 'info',
    plugins: config.plugins ?? [],
  };
}

/**
 * Validates `routing`: an object with a non-empty `pagesDir`, a non-empty `documentFile`, a known
 * `document` choice and string-to-string `params` entries. The plugin re-resolves the same shape
 * defensively (a config file may be loaded by an older compiler), but a typo fails here first.
 */
function assertRouting(value: unknown): void {
  if (typeof value !== 'object' || value === null) {
    throw new ConfigError('FLM2001', '"routing" must be an object.');
  }
  for (const option of ['pagesDir', 'documentFile', 'layoutDocumentFile'] as const) {
    const entry = Reflect.get(value, option);
    if (entry !== undefined && (typeof entry !== 'string' || entry.length === 0)) {
      throw new ConfigError('FLM2001', `"routing.${option}" must be a non-empty string.`);
    }
  }
  const document = Reflect.get(value, 'document');
  if (document !== undefined) {
    assertOneOf(document, 'routing.document', ['auto', 'colocated', 'page-module']);
  }
  const compose = Reflect.get(value, 'compose');
  if (compose !== undefined) {
    assertOneOf(compose, 'routing.compose', ['route', 'document']);
  }
  const loaders = Reflect.get(value, 'loaders');
  if (loaders !== undefined) {
    assertOneOf(loaders, 'routing.loaders', ['await', 'background']);
  }
  const extensions = Reflect.get(value, 'documentExtensions');
  if (extensions !== undefined) {
    if (!Array.isArray(extensions) || extensions.length === 0) {
      throw new ConfigError(
        'FLM2001',
        '"routing.documentExtensions" must be a non-empty array of extensions (for example [".gql", ".graphql"]).',
      );
    }
    for (const entry of extensions) {
      if (typeof entry !== 'string' || normalizeDocumentExtension(entry) === undefined) {
        throw new ConfigError(
          'FLM2001',
          `"routing.documentExtensions" entry ${JSON.stringify(entry)} is not a file extension (".gql", ".graphql", "gql").`,
        );
      }
    }
  }
  const params = Reflect.get(value, 'params');
  if (params === undefined) {
    return;
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new ConfigError('FLM2001', '"routing.params" must be an object of rename maps.');
  }
  for (const [path, renames] of Object.entries(params)) {
    if (typeof renames !== 'object' || renames === null || Array.isArray(renames)) {
      throw new ConfigError('FLM2001', `"routing.params.${path}" must be an object.`);
    }
    for (const [param, variable] of Object.entries(renames)) {
      if (typeof variable !== 'string' || variable.length === 0) {
        throw new ConfigError(
          'FLM2001',
          `"routing.params.${path}.${param}" must be the GraphQL variable name (a string).`,
        );
      }
    }
  }
}

/** The default pages directory; mirrors `@flamme/router/codegen`'s `DEFAULT_PAGES_DIR`. */
const DEFAULT_ROUTING_PAGES_DIR = 'src/pages';

/**
 * `config.routing` with every default filled.
 *
 * The resolved object is what the compiler, the route planner and the native backend all read, so a
 * default is applied once here rather than three times: `documentExtensions` in particular decides
 * discovery, extraction, the route document names, the ambient declarations and the import rewrite,
 * and every one of them has to see the same list.
 */
function resolveRouting(routing: RoutingConfig | undefined): RoutingConfig {
  const configured = typeof routing === 'object' && routing !== null ? routing : {};
  return {
    pagesDir: configured.pagesDir ?? DEFAULT_ROUTING_PAGES_DIR,
    documentFile: configured.documentFile ?? DEFAULT_PAGE_DOCUMENT_FILE,
    layoutDocumentFile: configured.layoutDocumentFile ?? DEFAULT_LAYOUT_DOCUMENT_FILE,
    documentExtensions: documentExtensionsOf(configured),
    document: configured.document ?? 'auto',
    compose: configured.compose ?? 'route',
    loaders: configured.loaders ?? 'await',
    params: configured.params ?? {},
  };
}

/** The default discovery globs for a project that configured none, from its document extensions. */
function defaultInclude(extensions: readonly string[]): readonly string[] {
  // Sorted, so the glob a project gets is stable whatever order the extensions were written in.
  const documents = [...extensions]
    .map((extension) => extension.slice(1))
    .toSorted()
    .join(',');
  return [`src/**/*.{vue,ts,tsx,${documents}}`];
}

/**
 * Adds the routing convention's colocated documents to the project's `include` globs.
 *
 * A page's `+page.<ext>`/`+page.ts` and a layout's `+layout.<ext>`/`+layout.ts` are inputs because
 * of where they sit, not because a glob names them; a project that narrows `include` to `.vue`
 * files would otherwise get a page whose query silently never compiles (the generator would find no
 * artifact, and an import of the document would be `FLM1017`). One glob is added per configured
 * document extension, so `+page.gql` and `+page.graphql` are both claimed.
 *
 * The retired named-document spelling (`+page.<handle>.gql`) is deliberately **not** an input: this
 * version no longer supports it. The route planner reads the pages directory itself and reports
 * `FLM3007` for such a file, which does not need the compiler to have compiled it.
 *
 * A `pagesDir` that escapes the project, or a document name that is a path rather than a file name,
 * adds nothing: the convention only claims what it can name.
 */
function withRoutingDocuments(
  include: readonly string[],
  routing: RoutingConfig,
): readonly string[] {
  const pagesDir = relativeDirectory(routing.pagesDir ?? DEFAULT_ROUTING_PAGES_DIR);
  if (pagesDir === undefined) {
    return include;
  }
  const names = [
    ...documentFileNames(routing, 'page'),
    ...documentFileNames(routing, 'layout'),
    PAGE_MODULE_FILE,
    LAYOUT_MODULE_FILE,
  ].filter((name): name is string => typeof name === 'string');
  const documents = names
    .map((name) => fileName(name))
    .filter((name): name is string => name !== undefined);
  return [...new Set([...include, ...documents.map((name) => `${pagesDir}/**/${name}`)])];
}

/** A project-relative directory glob prefix, or `undefined` for an empty or escaping path. */
function relativeDirectory(value: string): string | undefined {
  const normalized = toPosix(value.trim()).replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.startsWith('..')) {
    return undefined;
  }
  return normalized;
}

/** A document file name, or `undefined` when the value names a path instead of a file. */
function fileName(value: string): string | undefined {
  const name = value.trim();
  return name.length === 0 || name.includes('/') ? undefined : name;
}

/** True when any include glob could match a source file inside `directory`. */
function overlapsInclude(
  include: readonly string[],
  directory: string,
  extensions: readonly string[] = DEFAULT_DOCUMENT_EXTENSIONS,
): boolean {
  if (directory === '.' || directory.length === 0) {
    return true;
  }
  const probes = [
    '',
    '/probe.ts',
    '/probe.vue',
    '/probe.js',
    ...extensions.map((extension) => `/probe${extension}`),
  ];
  return include.some((pattern) =>
    probes.some((probe) => matchesAny([pattern], `${directory}${probe}`)),
  );
}

/** The generated directory as a project-relative posix path (`.flamme`). */
export function runtimeDirRelative(config: ResolvedConfig): string {
  return toPosix(relative(config.projectDir, config.runtimeDir)) || DEFAULT_RUNTIME_DIR;
}

/** Returns the absolute path of the first config file that exists, if any. */
export function findConfigFile(projectDir: string, configFile?: string): string | undefined {
  const root = resolve(projectDir);
  if (configFile !== undefined) {
    const absolute = isAbsolute(configFile) ? configFile : resolve(root, configFile);
    return existsSync(absolute) ? absolute : undefined;
  }
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = join(root, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Options for `loadConfig`; `configFile` overrides the search. */
export interface LoadConfigOptions {
  /** Explicit config file path (absolute or relative to `projectDir`). */
  readonly configFile?: string;
  /** Overrides merged over the file's config, as in `FlammePluginOptions.config`. */
  readonly overrides?: FlammeConfig;
  /** Directory used when there is no config file at all. Defaults to `projectDir`. */
  readonly fallback?: FlammeConfig;
  /**
   * Plugins appended to the config file's own `plugins` before the `config`
   * hooks run. This is the seam a host that owns a plugin list uses: the Vite
   * plugin passes the compiler plugins its `plugins` option contributed.
   */
  readonly extraPlugins?: readonly CompilerPlugin[];
  /**
   * The array a `config` hook failure is reported into. With a sink, a throwing
   * or rejecting hook becomes an `FLM2005` diagnostic there, the remaining hooks
   * still run, and the caller fails the run the way it fails for any other error
   * diagnostic. Without one the same failure is thrown as a `ConfigError` after
   * every hook has had its turn.
   */
  readonly diagnostics?: Diagnostic[];
}

/**
 * Loads `flamme.config.ts` (or `graphql.config.ts`) from `projectDir`,
 * runs every plugin `config` hook in order and resolves the result. The `.ts`
 * file is imported directly: Node 22.18+ strips the types.
 */
export async function loadConfig(
  projectDir: string,
  options: LoadConfigOptions = {},
): Promise<ResolvedConfig> {
  const root = resolve(projectDir);
  const file = findConfigFile(root, options.configFile);
  let config: FlammeConfig = options.fallback ?? {};
  if (file !== undefined) {
    try {
      const loaded: unknown = await import(pathToFileURL(file).href);
      const exported: unknown = Reflect.get(Object(loaded), 'default');
      if (isPromiseLike(exported)) {
        throw new ConfigError(
          'FLM2004',
          `"${toPosix(file)}" exports a Promise; export the config object itself (an async config is not awaited, so every option would silently fall back to its default).`,
        );
      }
      if (!isConfigObject(exported)) {
        throw new ConfigError('FLM2004', `"${toPosix(file)}" has no default export.`);
      }
      config = exported;
    } catch (error) {
      if (error instanceof ConfigError) {
        throw error;
      }
      throw new ConfigError('FLM2004', `Cannot load "${toPosix(file)}": ${errorMessage(error)}`);
    }
  } else if (options.fallback === undefined) {
    throw new ConfigError(
      'FLM2004',
      `No ${CONFIG_FILE_NAMES.join(' or ')} found in "${toPosix(root)}".`,
    );
  }
  if (options.overrides !== undefined) {
    config = { ...config, ...options.overrides };
  }
  if (options.extraPlugins !== undefined && options.extraPlugins.length > 0) {
    config = { ...config, plugins: [...(config.plugins ?? []), ...options.extraPlugins] };
  }
  // The `config` hooks run through the same contract as every other plugin hook: awaited, ordered
  // by `enforce`, and a throw (or a rejected promise) becomes one `FLM2005` diagnostic that names
  // the plugin and the hook. A failed hook leaves the config as it found it and the rest still run.
  const failures: Diagnostic[] = [];
  for (const plugin of orderByEnforce(config.plugins ?? [])) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- plugin hooks are ordered by contract
      const next = await plugin.config?.(config);
      if (next !== undefined) {
        config = next;
      }
    } catch (error) {
      failures.push(pluginFailureDiagnostic(plugin, 'config', error));
    }
  }
  if (failures.length > 0) {
    if (options.diagnostics === undefined) {
      throw new ConfigError('FLM2005', failures.map(formatDiagnostic).join('\n'));
    }
    options.diagnostics.push(...failures);
  }
  const directory = isAbsolute(projectDir) ? resolve(projectDir) : resolve(dirname(file ?? root));
  return resolveConfig(config, directory);
}
