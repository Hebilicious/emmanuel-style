/**
 * `+page.ts` / `+layout.ts`: the programmatic page-query surface (`spec/spec.md` §4.3).
 *
 * Fragments are the primary way a component declares its data needs; a page's
 * *query* is declared by the page. Two surfaces do that, and both are resolved
 * here for the router:
 *
 * | surface | how the query is declared |
 * | --- | --- |
 * | `+page.gql` | the whole file is one document |
 * | `+page.ts` | `export const Page = …`, a `graphql()` tag or an identifier imported from a shared module |
 *
 * The second surface is what lets several pages share one document: each page
 * module imports the same export, so two routes get two loaders over one
 * artifact.
 *
 * ## Resolution rules
 *
 * 1. The module must export a binding named `Page` (`export const Page = …`,
 *    `export { Page }` or `export { X as Page }`). No `Page` export is FLM1028.
 * 2. `Page` resolves through local aliases (`const Doc = graphql`…`` then
 *    `export const Page = Doc`) to either a `graphql()` tag declared in the
 *    module or an import. Anything else is FLM1029.
 * 3. An import is followed to the document it names. A `.gql`/`.graphql` target
 *    is the document of that file; a code module is matched by the imported name
 *    (the generated `XDocument` spelling included) or, when it declares exactly
 *    one document, by that document. An unresolved or ambiguous import is
 *    FLM1029.
 * 4. A directory that declares both `+page.gql` and `+page.ts` (or
 *    `+layout.gql` and `+layout.ts`) is FLM1030: the document file wins.
 */

import { dirname, extname, isAbsolute, resolve } from 'node:path';

import { Kind, parse as parseGraphQL } from 'graphql';

import type { ResolvedConfig } from './config.js';
import { createDiagnostic, type Diagnostic } from './diagnostics.js';
import { scanCode, type RawDocument, type ScanBinding, type ScanResult } from './extract.js';
import { locationAt, toPosix } from './offsets.js';

/** The page-query module file name. */
export const PAGE_MODULE_FILE = '+page.ts';

/** The layout-query module file name. */
export const LAYOUT_MODULE_FILE = '+layout.ts';

/** The default colocated page document file name. */
export const DEFAULT_PAGE_DOCUMENT_FILE = '+page.gql';

/** The default colocated layout document file name. */
export const DEFAULT_LAYOUT_DOCUMENT_FILE = '+layout.gql';

/** The export a page module declares its query with. */
export const PAGE_EXPORT_NAME = 'Page';

/** Extensions an import specifier may resolve to, in the order they are tried. */
const MODULE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.gql',
  '.graphql',
] as const;

/** Which routing role a file name has, or `undefined` when it is not a page module. */
export function pageModuleRole(relativePath: string): 'page' | 'layout' | undefined {
  const file = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  if (file === PAGE_MODULE_FILE) {
    return 'page';
  }
  return file === LAYOUT_MODULE_FILE ? 'layout' : undefined;
}

/** The diagnostic code a page module can report. */
export type PageModuleCode = 'FLM1028' | 'FLM1029';

/** What resolving one page module produced: the document, or the diagnostic that explains its absence. */
export interface PageModuleResolution {
  /** The document `Page` resolves to, or `undefined` when it does not resolve. */
  readonly document: RawDocument | undefined;
  /** The error to report when no document resolved. */
  readonly diagnostic: Diagnostic | undefined;
}

/** The input of {@link resolvePageModule}. */
export interface ResolvePageModuleInput {
  /** Absolute path of the `+page.ts`/`+layout.ts` file. */
  readonly file: string;
  /** Project-relative posix path of that file, for diagnostics. */
  readonly relativePath: string;
  /** The module's text. */
  readonly source: string;
  /** Every document the compiler extracted, whichever surface declared it. */
  readonly documents: readonly RawDocument[];
}

/** A resolution attempt over one binding, with the reason it failed. */
interface Attempt {
  readonly document: RawDocument | undefined;
  readonly detail: string;
  readonly offset: number;
}

/** Resolution depth limit for alias chains and re-exports. */
const MAX_DEPTH = 8;

/**
 * Resolves the `Page` export of one page module to a document. Pure: the
 * documents it matches against are the extraction result, so the compiler and
 * the route generator can never disagree about which document a page runs.
 */
export function resolvePageModule(input: ResolvePageModuleInput): PageModuleResolution {
  const scanned = scanCode(input.source, input.file, input.relativePath, 0, input.source, 'ts');
  // A module that does not parse has no export table to read; the FLM1011 the
  // scan produced is the actionable diagnostic, so this adds nothing.
  if (scanned.diagnostics.some((entry) => entry.severity === 'error')) {
    return { document: undefined, diagnostic: undefined };
  }
  const exported = scanned.exports.find((entry) => entry.name === PAGE_EXPORT_NAME);
  if (exported === undefined) {
    return {
      document: undefined,
      diagnostic: problem(
        'FLM1028',
        input,
        0,
        `"${input.relativePath}" has no "${PAGE_EXPORT_NAME}" export; export the page's query as \`export const ${PAGE_EXPORT_NAME} = graphql\`…\`\`, import it from a shared module, or delete the file.`,
      ),
    };
  }
  const attempt = resolveBinding(
    scanned,
    exported.local,
    input.file,
    input.documents,
    new Set(),
    0,
  );
  if (attempt.document !== undefined) {
    return { document: attempt.document, diagnostic: undefined };
  }
  return {
    document: undefined,
    diagnostic: problem(
      'FLM1029',
      input,
      exported.offset,
      `"${input.relativePath}" exports "${PAGE_EXPORT_NAME}" but it does not resolve to a document: ${attempt.detail}.`,
    ),
  };
}

/** Builds one page-module diagnostic at `offset` of the module. */
function problem(
  code: PageModuleCode,
  input: ResolvePageModuleInput,
  offset: number,
  detail: string,
): Diagnostic {
  const where = locationAt(input.source, input.relativePath, offset);
  return createDiagnostic({
    code,
    severity: 'error',
    message: `${where.file}:${where.line}:${where.column} ${detail}`,
    location: where,
  });
}

/** Resolves one local binding, following aliases and imports. */
function resolveBinding(
  scanned: ScanResult,
  name: string,
  file: string,
  documents: readonly RawDocument[],
  seen: Set<string>,
  depth: number,
): Attempt {
  if (depth > MAX_DEPTH || seen.has(name)) {
    return { document: undefined, detail: `"${name}" is a cycle`, offset: 0 };
  }
  seen.add(name);
  const binding: ScanBinding | undefined = scanned.bindings.get(name);
  if (binding === undefined) {
    return { document: undefined, detail: `"${name}" is not declared in the module`, offset: 0 };
  }
  if (binding.kind === 'document') {
    const candidate = scanned.candidates[binding.candidate];
    if (candidate === undefined) {
      return { document: undefined, detail: `"${name}" names no document`, offset: 0 };
    }
    const documentName = documentNameOf(candidate.text);
    const document =
      documents.find((entry) => entry.name === documentName && entry.file === file) ??
      documents.find((entry) => entry.name === documentName);
    if (document === undefined) {
      return {
        document: undefined,
        detail: `the graphql\`…\` tag bound to "${name}" declares no document`,
        offset: candidate.offset,
      };
    }
    return { document, detail: '', offset: candidate.offset };
  }
  if (binding.kind === 'alias') {
    return resolveBinding(scanned, binding.name, file, documents, seen, depth + 1);
  }
  if (binding.kind === 'import') {
    return followImport(binding.specifier, binding.imported, file, documents);
  }
  return {
    document: undefined,
    detail: `"${name}" is bound to a value that is not a document`,
    offset: 0,
  };
}

/** Follows one import specifier to the document it names. */
function followImport(
  specifier: string,
  imported: string,
  file: string,
  documents: readonly RawDocument[],
): Attempt {
  const candidates = specifierCandidates(file, specifier);
  const inFile = documents.filter((entry) => candidates.includes(entry.file));
  if (inFile.length === 0) {
    return {
      document: undefined,
      detail: `"${specifier}" declares no document`,
      offset: 0,
    };
  }
  if (inFile.length === 1) {
    const only = inFile[0];
    if (only !== undefined) {
      return { document: only, detail: '', offset: 0 };
    }
  }
  // The generated spelling of a document export is `<Name>Document`.
  const stem = imported.endsWith('Document') ? imported.slice(0, -'Document'.length) : imported;
  const named = inFile.filter((entry) => entry.name === imported || entry.name === stem);
  if (named.length === 1 && named[0] !== undefined) {
    return { document: named[0], detail: '', offset: 0 };
  }
  return {
    document: undefined,
    detail: `"${specifier}" declares ${String(inFile.length)} documents (${inFile
      .map((entry) => entry.name)
      .join(', ')}); import one by name`,
    offset: 0,
  };
}

/** Every absolute path one import specifier may resolve to, most specific first. */
function specifierCandidates(file: string, specifier: string): readonly string[] {
  if (specifier.length === 0) {
    return [];
  }
  if (!specifier.startsWith('.') && !isAbsolute(specifier)) {
    // A package specifier is not a project document: `$flamme` exports artifacts,
    // not sources, and a page module cannot point at one that way.
    return [];
  }
  const base = isAbsolute(specifier) ? specifier : resolve(dirname(file), specifier);
  const extension = extname(base);
  const stem = extension.length === 0 ? base : base.slice(0, -extension.length);
  const out: string[] = [base];
  for (const candidate of MODULE_EXTENSIONS) {
    const path = `${stem}${candidate}`;
    if (!out.includes(path)) {
      out.push(path);
    }
  }
  return out;
}

/** The document name of one candidate's text, or the empty string when it does not parse. */
function documentNameOf(text: string): string {
  try {
    const ast = parseGraphQL(text);
    const definition = ast.definitions[0];
    if (definition === undefined) {
      return '';
    }
    if (definition.kind === Kind.OPERATION_DEFINITION) {
      return definition.name?.value ?? '';
    }
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      return definition.name.value;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * The pages directory as a project-relative prefix (`src/pages/`): the tree the
 * `+page.ts`/`+layout.ts` convention belongs to. The routing convention is
 * mirrored here the way `withRoutingDocuments` mirrors it in `config.ts`: the
 * compiler must not depend on the router package.
 */
export function routingPagesPrefix(config: ResolvedConfig): string {
  const routing = config.routing;
  const value =
    typeof routing === 'object' && routing !== null ? Reflect.get(routing, 'pagesDir') : undefined;
  const directory =
    typeof value === 'string' && value.length > 0
      ? toPosix(value).replace(/^\.\//u, '').replace(/\/+$/u, '')
      : 'src/pages';
  if (directory.length === 0 || directory.startsWith('/') || directory.startsWith('..')) {
    return 'src/pages/';
  }
  return `${directory}/`;
}

/**
 * The configured colocated document file name for one role, with its default.
 *
 * These files are the routing convention's own documents: nothing imports them by
 * path, so two pages may each carry a `+page.gql` without the basename ambiguity
 * FLM1010 reports for imported `.gql` files.
 */
export function routingDocumentName(config: ResolvedConfig, role: 'page' | 'layout'): string {
  const routing = config.routing;
  const value =
    typeof routing === 'object' && routing !== null
      ? Reflect.get(routing, role === 'page' ? 'documentFile' : 'layoutDocumentFile')
      : undefined;
  const fallback = role === 'page' ? DEFAULT_PAGE_DOCUMENT_FILE : DEFAULT_LAYOUT_DOCUMENT_FILE;
  return typeof value === 'string' && value.length > 0 && !value.includes('/') ? value : fallback;
}
