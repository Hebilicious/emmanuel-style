/**
 * The six-step extraction algorithm, specialized to Vue (`spec/spec.md` §4.3).
 * This module owns steps 1–3 (discovery, offset extraction, scanning) and the
 * parse/name half of step 4; the rewrite (step 5) lives in the bundler layer and
 * incremental rebuild (step 6) in the Vite plugin.
 *
 * Offsets are always absolute offsets into the file's own text:
 * `block.loc.start.offset + offset within block.content`
 * (`research/extraction-and-vite.md` A.1).
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';

import {
  Kind,
  OperationTypeNode,
  parse as parseGraphQL,
  type DocumentNode,
} from 'graphql';
import { parseSync, type OxcError, type ParserOptions } from 'oxc-parser';

import type { ArtifactKind } from './contract.js';
import {
  DEFAULT_DOCUMENT_EXTENSIONS,
  documentExtensionsOf,
  documentFileNames,
  hasDocumentExtension,
  type ResolvedConfig,
} from './config.js';
import { createDiagnostic, errorMessage, type Diagnostic } from './diagnostics.js';
import { matchesAny, walkFiles, type DiscoveredFile } from './glob.js';
import { compareNames } from './naming.js';
import { locationAt, toPosix } from './offsets.js';
import {
  PAGE_MODULE_FILE,
  pageModuleRole,
  resolvePageModule,
  routingDocumentName,
  routingPagesPrefix,
} from './page-module.js';
import { analyzeVueSfc, SfcParseError, type SfcScriptBlock } from './sfc.js';

/** Which surface a document was extracted from (`spec/spec.md` §4.2). */
export type DocumentSurface = 'file' | 'tag' | 'script' | 'composed';

/** One extracted document surface, after parsing and naming (§4.1.1). */
export interface RawDocument {
  /** Operation or fragment name; the empty string only for an anonymous operation. */
  readonly name: string;
  /** The document's kind. */
  readonly kind: ArtifactKind;
  /** The document text as written (no printing, no injections). */
  readonly raw: string;
  /** Absolute path of the file the document came from. */
  readonly file: string;
  /** Posix path relative to `projectDir`, the form every diagnostic uses. */
  readonly relativePath: string;
  /** Which surface it came from. */
  readonly surface: DocumentSurface;
  /** Absolute offset of `raw[0]` in the file the document came from. */
  readonly offset: number;
  /** Absolute offset of the document's first **source** byte (before unescaping). */
  readonly start: number;
  /** Absolute offset just past the document's last source byte. */
  readonly end: number;
  /**
   * `sourceOffsets[i]` is the absolute file offset of `raw[i]`; the last entry is
   * `end`. `source.slice(start, end)` is the document exactly as written in the
   * file, which is what the Vite transform rewrites (A5).
   */
  readonly sourceOffsets: readonly number[];
  /** The parsed document; extraction always parses, because naming needs it. */
  readonly ast: DocumentNode;
  /** The full text of the file the document came from, for location mapping. */
  readonly source: string;
}

/** A `.gql`/`.graphql` import found in a code file, used for FLM1017. */
export interface GqlImport {
  /** Absolute path of the importing file. */
  readonly file: string;
  /** Posix path of the importing file, relative to `projectDir`. */
  readonly relativePath: string;
  /** The specifier as written. */
  readonly specifier: string;
  /** Absolute path the specifier resolves to, or `undefined` when it does not resolve. */
  readonly resolved: string | undefined;
  /** Absolute offset of the import declaration in the importing file. */
  readonly offset: number;
  /** The importing file's text, for location mapping. */
  readonly source: string;
}

/** Everything extraction produces. */
export interface ExtractResult {
  /** Every document found, sorted by `(relativePath, offset)`. */
  readonly documents: readonly RawDocument[];
  /** Extraction diagnostics (FLM1011, FLM1017 and the unbound-tag warning). */
  readonly diagnostics: readonly Diagnostic[];
  /** Every `.gql`/`.graphql` import found in a code file. */
  readonly imports: readonly GqlImport[];
  /** Every name imported from `$flamme` anywhere in the project (for FLM1018). */
  readonly importedNames: readonly string[];
  /** The files the walk discovered, sorted by relative path. */
  readonly files: readonly DiscoveredFile[];
  /**
   * Per-file contributions, keyed by project-relative posix path: the reuse unit
   * of an incremental run (`ExtractOptions.previous`). A `files`-restricted run
   * without a previous result is a partial scan, so this map covers the files it
   * scanned and nothing else; only a full run is a complete cache.
   */
  readonly byFile: ReadonlyMap<string, FileExtraction>;
}

/** One measured pipeline phase. */
export interface PhaseTiming {
  /** Phase name, stable across runs; `extract:read` is the child of `extract`. */
  readonly phase: string;
  /** Wall-clock milliseconds. */
  readonly ms: number;
}

/** Sink for {@link PhaseTiming} measurements; opt-in, so a normal run pays nothing. */
export type PhaseObserver = (timing: PhaseTiming) => void;

/** Runs `body`, reporting its wall-clock time to `observe` under `phase`. */
async function timed<T>(
  observe: PhaseObserver | undefined,
  phase: string,
  body: () => Promise<T>,
): Promise<T> {
  if (observe === undefined) {
    return body();
  }
  const started = performance.now();
  try {
    return await body();
  } finally {
    observe({ phase, ms: performance.now() - started });
  }
}

/** Options shared by extraction and generation. */
export interface ExtractOptions {
  /** Restricts extraction to these project-relative posix paths (incremental rebuild). */
  readonly files?: readonly string[];
  /** Phase measurements; nothing else reads them. */
  readonly onPhase?: PhaseObserver;
  /**
   * The previous extraction of the same project. Every file that `files` does not
   * name is reused from it verbatim (documents, diagnostics, imports), so an edit
   * costs one file's parse instead of the project's.
   */
  readonly previous?: ExtractResult;
}

/** A minimal structural view of a parser AST node; avoids an `@oxc-project/types` dependency. */
interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly type?: unknown }).type === 'string'
  );
}

function childNode(node: AstNode, key: string): AstNode | undefined {
  const value = node[key];
  return isNode(value) ? value : undefined;
}

function childNodes(node: AstNode, key: string): readonly AstNode[] {
  const value = node[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isNode);
}

function stringField(node: AstNode | undefined, key: string): string {
  const value = node?.[key];
  return typeof value === 'string' ? value : '';
}

function numberField(node: AstNode | undefined, key: string): number {
  const value = node?.[key];
  return typeof value === 'number' ? value : 0;
}

const SKIPPED_KEYS = new Set(['loc', 'start', 'end', 'range', 'extra', 'errors', 'tokens']);

/** Depth-first walk over every node reachable from `node`, in source order. */
export function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_KEYS.has(key) || key.endsWith('Comments')) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isNode(entry)) {
          walkAst(entry, visit);
        }
      }
    } else if (isNode(value)) {
      walkAst(value, visit);
    }
  }
}

function toAstNode(value: unknown): AstNode {
  if (!isNode(value)) {
    throw new Error('Unexpected parser AST shape: the program node is missing.');
  }
  return value;
}

/**
 * The Oxc parse options that reproduce the Babel plugin set this scanner used to
 * configure (`typescript` for `.ts`, `typescript` + `jsx` for `.tsx`, `jsx`
 * otherwise). `preserveParens: false` is Babel's default and is load-bearing for
 * parenthesised surfaces: with Oxc's default (`true`) a `(graphql)(…)` callee is
 * a `ParenthesizedExpression` instead of an `Identifier` and the document would
 * be dropped.
 */
function parserOptionsFor(lang: 'js' | 'jsx' | 'ts' | 'tsx'): ParserOptions {
  return {
    // Babel's `jsx` plugin was enabled for `.js` too, and Oxc only parses JSX
    // under the `jsx`/`tsx` langs.
    lang: lang === 'js' ? 'jsx' : lang,
    sourceType: 'module',
    preserveParens: false,
    // Babel performs early-error checks while parsing (duplicate declarations,
    // illegal `break`, `with` in strict mode, …). Oxc's parser does not, so the
    // semantic pass is what keeps "a script that cannot parse degrades to
    // FLM1011" true for the same inputs.
    showSemanticErrors: true,
  };
}

/**
 * The message of the first error Oxc reported, with the offending position
 * appended in the `(line:column)` form Babel's own messages carried. This is the
 * only place a parser's wording reaches a diagnostic, so it is the one string
 * that cannot survive a parser swap byte for byte.
 */
function parseFailureMessage(error: OxcError, code: string, relativePath: string): string {
  const label = error.labels[0];
  if (label === undefined) {
    return error.message;
  }
  const where = locationAt(code, relativePath, label.start);
  return `${error.message} (${where.line}:${where.column})`;
}

/** One string literal discovered by the scanner, before parsing. */
interface Candidate {
  /** The document text, with JS escape sequences resolved (`\n`, `` \` ``, `\$`, …). */
  readonly text: string;
  /** Absolute offset of the text's first character in the file. */
  readonly offset: number;
  /**
   * `sourceOffsets[i]` is the absolute file offset of `text[i]`, and the last entry
   * is the end of the document's source span. Positions are therefore always derived
   * from the unmodified file bytes, even for CRLF files and escaped templates (A5).
   */
  readonly sourceOffsets: readonly number[];
}

/** What one local name in a scanned module is bound to (`+page.ts` Page resolution). */
export type ScanBinding =
  | { readonly kind: 'document'; readonly candidate: number }
  | { readonly kind: 'alias'; readonly name: string }
  | {
      readonly kind: 'import';
      readonly specifier: string;
      /** The imported name; `'default'` for a default import, `'*'` for a namespace. */
      readonly imported: string;
      /** Absolute path the specifier resolves to, or `undefined` when it is not lexical. */
      readonly resolved: string | undefined;
    }
  | { readonly kind: 'other' };

/** One name a scanned module exports, and the local binding it names. */
export interface ScanExport {
  /** The exported name; `'default'` for `export default …`. */
  readonly name: string;
  /** The local binding the export refers to. */
  readonly local: string;
  /** Absolute offset of the export declaration, for diagnostics. */
  readonly offset: number;
}

/**
 * Resolves the JavaScript escape sequences of a template quasi (or string literal)
 * and records where each produced character came from.
 *
 * A parser's own view of a template quasi normalises `\r\n` to `\n` and leaves
 * `` \` `` escaped, which is why the offset of a token inside the template cannot
 * be computed by adding the token's index to the file offset (A5/A12/F2/F3).
 * Cooking the *source* slice here keeps a per-character map back to the file, and
 * is independent of which parser produced the slice's bounds.
 */
export function cookTemplate(
  slice: string,
  start: number,
): { readonly text: string; readonly sourceOffsets: readonly number[] } {
  let text = '';
  const offsets: number[] = [];
  const push = (value: string, at: number): void => {
    text += value;
    offsets.push(at);
  };
  const simple: Readonly<Record<string, string>> = {
    n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0',
    '`': '`', '\\': '\\', $: '$', "'": "'", '"': '"',
  };
  let index = 0;
  while (index < slice.length) {
    const char = slice[index] ?? '';
    if (char !== '\\') {
      // A line terminator cooks to LF: CRLF, and a lone CR as well.
      if (char === '\r') {
        const crlf = slice[index + 1] === '\n';
        push('\n', start + (crlf ? index + 1 : index));
        index += crlf ? 2 : 1;
        continue;
      }
      push(char, start + index);
      index += 1;
      continue;
    }
    const at = start + index;
    const next = slice[index + 1];
    if (next === undefined) {
      index += 1;
      continue;
    }
    // A line continuation produces nothing.
    if (next === '\n') {
      index += 2;
      continue;
    }
    if (next === '\r' && slice[index + 2] === '\n') {
      index += 3;
      continue;
    }
    const replacement = simple[next];
    if (replacement !== undefined) {
      push(replacement, at);
      index += 2;
      continue;
    }
    if (next === 'x' || next === 'u') {
      const braced = next === 'u' && slice[index + 2] === '{';
      const raw = braced
        ? (slice.slice(index + 3).split('}')[0] ?? '')
        : slice.slice(index + 2, index + (next === 'x' ? 4 : 6));
      const code = Number.parseInt(raw, 16);
      if (raw.length > 0 && !Number.isNaN(code)) {
        push(String.fromCodePoint(code), at);
        index += braced ? 4 + raw.length : 2 + raw.length;
        continue;
      }
    }
    // An unrecognised escape is the escaped character itself (JavaScript semantics).
    push(next, at);
    index += 2;
  }
  offsets.push(start + slice.length);
  return { text, sourceOffsets: offsets };
}

/** Unescapes a template quasi the way the reference implementation does. */
export function unescapeTemplate(raw: string): string {
  return raw.replaceAll('\\`', '`');
}

/** What a scan of one script block found. */
export interface ScanResult {
  readonly candidates: readonly Candidate[];
  readonly diagnostics: readonly Diagnostic[];
  readonly imports: readonly GqlImport[];
  readonly importedNames: readonly string[];
  /** Offsets of `graphql` identifiers seen but not bound to a `$flamme` import. */
  readonly unbound: readonly number[];
  /**
   * What each local name of the block is bound to, for the `+page.ts` `Page`
   * resolution: a document declared here, an alias of another local name, an
   * import, or something else. The last binding of a name wins.
   */
  readonly bindings: ReadonlyMap<string, ScanBinding>;
  /** Every name the block exports, with the local binding it names. */
  readonly exports: readonly ScanExport[];
}

/** One `const`/`let`/`var` declaration the binder pass found, before candidates exist. */
interface Declaration {
  readonly name: string;
  /** Absolute offset of the initializer, or `-1` for a declaration without one. */
  readonly initStart: number;
  /** The identifier the initializer names, when it is one. */
  readonly alias: string | undefined;
  /** `true` when the initializer is a `graphql()` document candidate. */
  readonly document: boolean;
}

/**
 * Scans one code block for `graphql` tagged templates, `graphql(…)` calls and
 * `GraphQL<\`…\`>` type signatures. The tag is ours only when the identifier
 * resolves to an import from `$flamme` (§4.3 step 3, §14.2 row 20).
 */
export function scanCode(
  code: string,
  file: string,
  relativePath: string,
  offset: number,
  source: string,
  lang: 'js' | 'jsx' | 'ts' | 'tsx',
  documentExtensions: readonly string[] = DEFAULT_DOCUMENT_EXTENSIONS,
): ScanResult {
  const diagnostics: Diagnostic[] = [];
  const candidates: Candidate[] = [];
  const imports: GqlImport[] = [];
  const importedNames: string[] = [];
  const unbound: number[] = [];
  const bound = new Set<string>();
  const bindings = new Map<string, ScanBinding>();
  const exports: ScanExport[] = [];
  const declarations: Declaration[] = [];

  let ast: AstNode;
  try {
    const parsed = parseSync(file, code, parserOptionsFor(lang));
    // Oxc reports syntax errors instead of throwing, and only some of them are
    // fatal: warnings and advice do not stop a file from being scanned.
    const failure = parsed.errors.find((entry) => (entry.severity as string) === 'Error');
    if (failure !== undefined) {
      throw new Error(parseFailureMessage(failure, code, relativePath));
    }
    ast = toAstNode(parsed.program);
  } catch (error) {
    diagnostics.push(
      createDiagnostic({
        code: 'FLM1011',
        severity: 'error',
        message: `${relativePath}: cannot parse the script block: ${errorMessage(error)}`,
        location: locationAt(source, relativePath, offset),
      }),
    );
    return { candidates, diagnostics, imports, importedNames, unbound, bindings, exports };
  }

  // Pass 1: bindings. Which local names are `graphql` imported from `$flamme`?
  walkAst(ast, (node) => {
    if (node.type === 'ImportDeclaration') {
      const specifier = stringField(childNode(node, 'source'), 'value');
      for (const entry of childNodes(node, 'specifiers')) {
        const importedName =
          entry.type === 'ImportSpecifier'
            ? stringField(childNode(entry, 'imported'), 'name')
            : entry.type === 'ImportDefaultSpecifier'
              ? 'default'
              : '*';
        const localName = stringField(childNode(entry, 'local'), 'name');
        if (specifier === '$flamme') {
          for (const name of [importedName, localName]) {
            if (name.length > 0) {
              importedNames.push(name);
            }
          }
          if (importedName === 'graphql' && localName.length > 0) {
            bound.add(localName);
          }
        }
        if (localName.length === 0) {
          continue;
        }
        bindings.set(localName, {
          kind: 'import',
          specifier,
          imported: importedName,
          resolved: isAbsolute(specifier) ? specifier : resolve(dirname(file), specifier),
        });
        if (hasDocumentExtension(specifier, documentExtensions) && localName.length > 0) {
          imports.push({
            file,
            relativePath,
            specifier,
            resolved: isAbsolute(specifier) ? specifier : resolve(dirname(file), specifier),
            offset: offset + numberField(node, 'start'),
            source,
          });
        }
      }
      // `export { X } from './y'` binds the exported name without a local declaration.
      const reexport = stringField(childNode(node, 'source'), 'value');
      if (reexport.length > 0) {
        for (const entry of childNodes(node, 'specifiers')) {
          const exported = stringField(childNode(entry, 'exported'), 'name');
          if (exported.length === 0) {
            continue;
          }
          exports.push({
            name: exported,
            local: exported,
            offset: offset + numberField(node, 'start'),
          });
          bindings.set(exported, {
            kind: 'import',
            specifier: reexport,
            imported: exported,
            resolved: isAbsolute(reexport) ? reexport : resolve(dirname(file), reexport),
          });
        }
      }
      return;
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
      const at = offset + numberField(node, 'start');
      const declaration = childNode(node, 'declaration');
      if (declaration !== undefined) {
        for (const name of declaredNames(declaration)) {
          exports.push({
            name: node.type === 'ExportDefaultDeclaration' ? 'default' : name,
            local: name,
            offset: at,
          });
        }
      }
      for (const entry of childNodes(node, 'specifiers')) {
        const exported = stringField(childNode(entry, 'exported'), 'name');
        const local = stringField(childNode(entry, 'local'), 'name');
        if (exported.length > 0 && local.length > 0) {
          exports.push({ name: exported, local, offset: at });
        }
      }
      return;
    }
    if (node.type === 'VariableDeclarator') {
      const init = childNode(node, 'init');
      const id = childNode(node, 'id');
      // `const { graphql } = require('$flamme')`
      if (init?.type === 'CallExpression' && id?.type === 'ObjectPattern') {
        const args = childNodes(init, 'arguments');
        if (
          stringField(childNode(init, 'callee'), 'name') === 'require' &&
          stringField(args[0], 'value') === '$flamme'
        ) {
          for (const property of childNodes(id, 'properties')) {
            const key = stringField(childNode(property, 'key'), 'name');
            const value = stringField(childNode(property, 'value'), 'name');
            if (key === 'graphql' && value.length > 0) {
              bound.add(value);
            }
          }
        }
        return;
      }
      const name = id?.type === 'Identifier' ? stringField(id, 'name') : '';
      if (name.length === 0) {
        return;
      }
      const alias = init?.type === 'Identifier' ? stringField(init, 'name') : undefined;
      declarations.push({
        name,
        initStart: init === undefined ? -1 : offset + numberField(init, 'start'),
        alias: alias === undefined || alias.length === 0 ? undefined : alias,
        document:
          init !== undefined &&
          (init.type === 'TaggedTemplateExpression' || init.type === 'CallExpression') &&
          bound.has(
            stringField(
              childNode(init, init.type === 'TaggedTemplateExpression' ? 'tag' : 'callee'),
              'name',
            ),
          ),
      });
    }
  });

  // Pass 2: document candidates.
  const candidateAt = new Map<number, number>();
  walkAst(ast, (node) => {
    if (node.type === 'TaggedTemplateExpression') {
      const tag = childNode(node, 'tag');
      const name = stringField(tag, 'name');
      if (tag?.type !== 'Identifier' || name.length === 0) {
        return;
      }
      if (!bound.has(name)) {
        if (name === 'graphql') {
          unbound.push(offset + numberField(node, 'start'));
        }
        return;
      }
      const candidate = readTemplate(
        childNode(node, 'quasi'),
        offset,
        relativePath,
        source,
        diagnostics,
      );
      if (candidate !== undefined) {
        candidateAt.set(offset + numberField(node, 'start'), candidates.length);
        candidates.push(candidate);
      }
      return;
    }
    if (node.type === 'CallExpression') {
      const callee = childNode(node, 'callee');
      const name = stringField(callee, 'name');
      if (callee?.type !== 'Identifier' || name.length === 0) {
        return;
      }
      if (!bound.has(name)) {
        if (name === 'graphql') {
          unbound.push(offset + numberField(node, 'start'));
        }
        return;
      }
      const args = childNodes(node, 'arguments');
      const argument = args[0];
      if (args.length === 1 && argument?.type === 'TemplateLiteral') {
        const candidate = readTemplate(argument, offset, relativePath, source, diagnostics);
        if (candidate !== undefined) {
          candidateAt.set(offset + numberField(node, 'start'), candidates.length);
          candidates.push(candidate);
        }
        return;
      }
      if (args.length === 1 && argument?.type === 'Literal' && typeof argument['value'] === 'string') {
        const start = offset + numberField(argument, 'start') + 1;
        const end = offset + numberField(argument, 'end') - 1;
        const cooked = cookTemplate(source.slice(start, end), start);
        candidateAt.set(offset + numberField(node, 'start'), candidates.length);
        candidates.push({ ...cooked, offset: start });
        return;
      }
      diagnostics.push(
        createDiagnostic({
          code: 'FLM1011',
          severity: 'error',
          message: `${relativePath}: graphql(…) must be called with exactly one static string.`,
          location: locationAt(source, relativePath, offset + numberField(node, 'start')),
        }),
      );
      return;
    }
    if (node.type !== 'TSPropertySignature' && node.type !== 'TSTypeAliasDeclaration') {
      return;
    }
    const annotation = childNode(node, 'typeAnnotation');
    const type =
      annotation?.type === 'TSTypeAnnotation' ? childNode(annotation, 'typeAnnotation') : annotation;
    if (type?.type !== 'TSTypeReference' || stringField(childNode(type, 'typeName'), 'name') !== 'GraphQL') {
      return;
    }
    // Oxc names a type reference's arguments `typeArguments` (Babel: `typeParameters`).
    const parameters = childNode(type, 'typeArguments');
    if (parameters === undefined) {
      // A bare `GraphQL` reference (no type argument) is not a document surface at
      // all: it is some other type, and it stays ignored.
      return;
    }
    // `GraphQL<\`…\`>` is not a document surface: the compiler does not extract it and
    // the transform has no rewrite branch for it, so it is reported rather than
    // silently ignored (orchestrator ruling; the code used to be silently skipped
    // when the type argument was not a template literal).
    const where = locationAt(source, relativePath, offset + numberField(node, 'start'));
    diagnostics.push(
      createDiagnostic({
        code: 'FLM1022',
        severity: 'error',
        message: `${where.file}:${where.line}:${where.column} GraphQL<…> is not a supported document surface; use a .graphql/.gql file, a graphql\`…\` tag, or the Page export of a +page.ts.`,
        location: where,
      }),
    );
  });

  // Pass 3: name bindings, now that every candidate has an index.
  for (const declaration of declarations) {
    if (declaration.document) {
      const index = candidateAt.get(declaration.initStart);
      bindings.set(
        declaration.name,
        index === undefined ? { kind: 'other' } : { kind: 'document', candidate: index },
      );
      continue;
    }
    bindings.set(
      declaration.name,
      declaration.alias === undefined
        ? { kind: 'other' }
        : { kind: 'alias', name: declaration.alias },
    );
  }

  return { candidates, diagnostics, imports, importedNames, unbound, bindings, exports };
}

/** Every identifier a declaration node binds (a `const` pattern's names included). */
function declaredNames(node: AstNode): readonly string[] {
  if (node.type === 'VariableDeclaration') {
    const names: string[] = [];
    for (const declarator of childNodes(node, 'declarations')) {
      const id = childNode(declarator, 'id');
      const name = id?.type === 'Identifier' ? stringField(id, 'name') : '';
      if (name.length > 0) {
        names.push(name);
      }
    }
    return names;
  }
  const name = stringField(childNode(node, 'id'), 'name');
  return name.length === 0 ? [] : [name];
}

function readTemplate(
  quasi: AstNode | undefined,
  offset: number,
  relativePath: string,
  source: string,
  diagnostics: Diagnostic[],
): Candidate | undefined {
  if (quasi?.type !== 'TemplateLiteral') {
    return undefined;
  }
  const quasis = childNodes(quasi, 'quasis');
  const expressions = childNodes(quasi, 'expressions');
  const first = quasis[0];
  if (quasis.length !== 1 || expressions.length > 0 || first === undefined) {
    diagnostics.push(
      createDiagnostic({
        code: 'FLM1011',
        severity: 'error',
        message: `${relativePath}: graphql\`…\` must be a static string; interpolation is not supported.`,
        location: locationAt(source, relativePath, offset + numberField(quasi, 'start')),
      }),
    );
    return undefined;
  }
  // Oxc spans a `TemplateElement` differently per AST flavour: the `js` flavour
  // spans only the text between the delimiters (as Babel did), the `ts` flavour
  // spans from the opening delimiter through the closing one. The enclosing
  // `TemplateLiteral` is backtick-inclusive in every flavour (and in Babel), so
  // the document's source span is taken from the quasi and narrowed by one
  // character on each side, which is flavour-independent.
  const start = offset + numberField(quasi, 'start') + 1;
  const end = offset + numberField(quasi, 'end') - 1;
  const cooked = cookTemplate(source.slice(start, end), start);
  return { ...cooked, offset: start };
}

function kindOf(definition: DocumentNode['definitions'][number]): ArtifactKind | undefined {
  switch (definition.kind) {
    case Kind.OPERATION_DEFINITION:
      switch (definition.operation) {
        case OperationTypeNode.QUERY:
          return 'query';
        case OperationTypeNode.MUTATION:
          return 'mutation';
        case OperationTypeNode.SUBSCRIPTION:
          return 'subscription';
        default:
          return undefined;
      }
    case Kind.FRAGMENT_DEFINITION:
      return 'fragment';
    default:
      return undefined;
  }
}

function nameOf(definition: DocumentNode['definitions'][number]): string {
  if (definition.kind === Kind.OPERATION_DEFINITION) {
    return definition.name?.value ?? '';
  }
  if (definition.kind === Kind.FRAGMENT_DEFINITION) {
    return definition.name.value;
  }
  return '';
}

/** Parses one candidate into a `RawDocument`, reporting FLM1011 when malformed. */
function documentFromCandidate(
  candidate: Candidate,
  file: string,
  relativePath: string,
  source: string,
  surface: DocumentSurface,
  diagnostics: Diagnostic[],
): RawDocument | undefined {
  let ast: DocumentNode;
  try {
    ast = parseGraphQL(candidate.text);
  } catch (error) {
    // The parser's own position is the offending character, so map it back to the
    // file instead of reporting the document start (F7).
    const position = parserLocation(error);
    const local = position === undefined ? 0 : localIndex(candidate, position.line, position.column);
    const where = locationAt(source, relativePath, absoluteAt(candidate, local));
    diagnostics.push(
      createDiagnostic({
        code: 'FLM1011',
        severity: 'error',
        message: `${where.file}:${where.line}:${where.column} cannot parse the document: ${errorMessage(error)}`,
        location: where,
      }),
    );
    return undefined;
  }
  if (ast.definitions.length !== 1) {
    const where = locationAt(source, relativePath, candidate.offset);
    diagnostics.push(
      createDiagnostic({
        code: 'FLM1011',
        severity: 'error',
        message: `${where.file}:${where.line}:${where.column} a document must contain exactly one operation or fragment, found ${ast.definitions.length}.`,
        location: where,
      }),
    );
    return undefined;
  }
  const definition = ast.definitions[0];
  const kind = definition === undefined ? undefined : kindOf(definition);
  if (definition === undefined || kind === undefined) {
    const where = locationAt(source, relativePath, candidate.offset);
    diagnostics.push(
      createDiagnostic({
        code: 'FLM1011',
        severity: 'error',
        message: `${where.file}:${where.line}:${where.column} only operations and fragments can be compiled into artifacts.`,
        location: where,
      }),
    );
    return undefined;
  }
  return {
    name: nameOf(definition),
    kind,
    raw: candidate.text,
    file,
    relativePath,
    surface,
    offset: candidate.offset,
    start: candidate.sourceOffsets[0] ?? candidate.offset,
    end: candidate.sourceOffsets[candidate.text.length] ?? candidate.offset,
    sourceOffsets: candidate.sourceOffsets,
    ast,
    source,
  };
}

/**
 * A candidate whose text is already the source text (a `.gql` file): every
 * character maps to itself and the span is `[start, start + len]`.
 */
function plainCandidate(text: string, start: number): Candidate {
  const sourceOffsets = Array.from({ length: text.length + 1 }, (_, index) => start + index);
  return { text, offset: start, sourceOffsets };
}

/** The first `locations[0]` of a `graphql` syntax error, without asserting its shape. */
function parserLocation(error: unknown): { readonly line: number; readonly column: number } | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const locations = (error as { readonly locations?: unknown }).locations;
  if (!Array.isArray(locations)) {
    return undefined;
  }
  const first: unknown = locations[0];
  if (typeof first !== 'object' || first === null) {
    return undefined;
  }
  const line = (first as { readonly line?: unknown }).line;
  const column = (first as { readonly column?: unknown }).column;
  return typeof line === 'number' && typeof column === 'number' ? { line, column } : undefined;
}

/** The file offset of the character at `line`/`column` (1-based) of a document. */
function localIndex(candidate: Candidate, line: number, column: number): number {
  let currentLine = 1;
  let index = 0;
  for (; index < candidate.text.length; index += 1) {
    if (currentLine === line) {
      break;
    }
    if (candidate.text[index] === '\n') {
      currentLine += 1;
    }
  }
  return Math.min(candidate.text.length, index + Math.max(0, column - 1));
}

/** The absolute file offset of the document's character at `index`. */
export function absoluteAt(candidate: Candidate, index: number): number {
  const clamped = Math.max(0, Math.min(index, candidate.text.length));
  return candidate.sourceOffsets[clamped] ?? candidate.offset;
}

/**
 * One file's contribution to an extraction, kept so a later run can reuse it.
 *
 * The record is the unit of incremental work: it holds everything the per-file
 * scan produced, so a run that reuses it does no I/O and no parsing at all.
 */
export interface FileExtraction {
  /** Project-relative posix path of the file. */
  readonly relative: string;
  /** Size in bytes, as read; a mismatch makes the record stale. */
  readonly size: number;
  /** Modification time in milliseconds, as read; a mismatch makes the record stale. */
  readonly mtimeMs: number;
  /** Every document the file declared, before project-wide name de-duplication. */
  readonly documents: readonly RawDocument[];
  /** Extraction diagnostics of this file alone. */
  readonly diagnostics: readonly Diagnostic[];
  /** Every `.gql`/`.graphql` import the file declares. */
  readonly imports: readonly GqlImport[];
  /** Names imported from `$flamme`, for FLM1018. */
  readonly importedNames: readonly string[];
  /** Project-relative posix paths of the `<script src>` targets this file read. */
  readonly dependencies: readonly string[];
  /** The file's text, for the page-module pass; `undefined` when it could not be read. */
  readonly source: string | undefined;
}

/** The residue of one file: what {@link extractFile} returns. */
interface FileResidue {
  readonly documents: RawDocument[];
  readonly diagnostics: Diagnostic[];
  readonly imports: GqlImport[];
  readonly importedNames: string[];
  readonly dependencies: string[];
}

/**
 * Scans one prepared file: the per-file half of extraction, with no project-wide
 * state (de-duplication, page modules, `.gql` import reachability) involved.
 */
function extractFile(
  prepared: PreparedFile,
  config: ResolvedConfig,
): FileResidue {
  const residue: FileResidue = {
    documents: [],
    diagnostics: [],
    imports: [],
    importedNames: [],
    dependencies: [],
  };
  const { entry, source: fileSource, readError, parseError, srcSources } = prepared;
  const { diagnostics, documents, imports, importedNames } = residue;
  diagnostics.push(...prepared.diagnostics);
  const extension = extname(entry.relative).toLowerCase();
  if (fileSource === undefined) {
    diagnostics.push(
      createDiagnostic({
        code: 'FLM1011',
        severity: 'error',
        message:
          parseError === undefined
            ? `${entry.relative}: cannot read the file: ${readError ?? 'unknown error'}`
            : `${entry.relative}: cannot parse the single file component: ${(readError ?? 'invalid SFC').replace(`${entry.absolute}: `, '')}`,
        location: {
          file: entry.relative,
          line: parseError?.line ?? 1,
          column: parseError?.column ?? 1,
          length: 1,
        },
      }),
    );
    return residue;
  }
  const source = fileSource;

  if (hasDocumentExtension(extension, documentExtensionsOf(config.routing))) {
    if (source.trim().length > 0) {
      pushDocument(
        documents,
        documentFromCandidate(
          plainCandidate(source, 0),
          entry.absolute,
          entry.relative,
          source,
          'file',
          diagnostics,
        ),
      );
    }
    return residue;
  }

  if (extension === '.vue') {
    let analysis: ReturnType<typeof analyzeVueSfc>;
    try {
      analysis = analyzeVueSfc(source, entry.absolute);
    } catch (error) {
      diagnostics.push(
        createDiagnostic({
          code: 'FLM1011',
          severity: 'error',
          message: `${entry.relative}: ${errorMessage(error)}`,
          location: { file: entry.relative, line: 1, column: 1, length: 1 },
        }),
      );
      return residue;
    }

    for (const block of analysis.scripts) {
      if (block.src !== undefined) {
        const resolved = resolveScriptTarget(block.src, entry, source, 0, config, []);
        if (resolved !== undefined) {
          residue.dependencies.push(resolved.relativePath);
        }
      }
      const target = resolveScriptSource(block, entry, source, config, srcSources, diagnostics);
      if (target === undefined) {
        continue;
      }
      const scanned = scanCode(
        target.content,
        target.file,
        target.relativePath,
        target.offset,
        target.source,
        block.lang,
        documentExtensionsOf(config.routing),
      );
      diagnostics.push(...scanned.diagnostics);
      imports.push(...scanned.imports);
      importedNames.push(...scanned.importedNames);
      for (const candidate of scanned.candidates) {
        const document = documentFromCandidate(
          candidate,
          target.file,
          target.relativePath,
          target.source,
          'script',
          diagnostics,
        );
        if (document === undefined) {
          continue;
        }
        // A component declares fragments (and the operations that are not page
        // queries); a **query** in a `.vue` is a removed surface (FLM1027): the
        // page's query belongs to `+page.gql` or to `+page.ts`, so that adding a
        // field to a component never means editing a page.
        if (document.kind === 'query') {
          diagnostics.push(inlineQueryDiagnostic(document, config, target.source));
          continue;
        }
        pushDocument(documents, document);
      }
      for (const offset of scanned.unbound) {
        diagnostics.push(unboundTagDiagnostic(target.relativePath, target.source, offset));
      }
    }

    return residue;
  }

  if (extension === '.ts' || extension === '.tsx' || extension === '.js' || extension === '.jsx') {
    const lang = extension === '.tsx' ? 'tsx' : extension === '.ts' ? 'ts' : 'jsx';
    const scanned = scanCode(
      source,
      entry.absolute,
      entry.relative,
      0,
      source,
      lang,
      documentExtensionsOf(config.routing),
    );
    diagnostics.push(...scanned.diagnostics);
    imports.push(...scanned.imports);
    importedNames.push(...scanned.importedNames);
    for (const candidate of scanned.candidates) {
      pushDocument(
        documents,
        documentFromCandidate(candidate, entry.absolute, entry.relative, source, 'tag', diagnostics),
      );
    }
    for (const offset of scanned.unbound) {
      diagnostics.push(unboundTagDiagnostic(entry.relative, source, offset));
    }
  }

  return residue;
}

/** Appends a document unless it is absent, keeping declaration order. */
function pushDocument(documents: RawDocument[], document: RawDocument | undefined): void {
  if (document === undefined) {
    return;
  }
  documents.push(document);
}

/** The last `stat` of a path, or `undefined` when it cannot be read. */
async function fileStamp(
  absolute: string,
): Promise<{ readonly size: number; readonly mtimeMs: number } | undefined> {
  try {
    const info = await stat(absolute);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * True when `record` still describes what is on disk: same size and same
 * modification time. This is the best-effort guard for a file the watcher never
 * reported (a write the batch does not name); the change set itself is
 * authoritative, and a rewrite inside one millisecond with an unchanged size is
 * the one case this cannot see.
 */
function recordIsCurrent(
  record: FileExtraction | undefined,
  stamp: { readonly size: number; readonly mtimeMs: number } | undefined,
): record is FileExtraction {
  return (
    record !== undefined &&
    stamp !== undefined &&
    record.size === stamp.size &&
    record.mtimeMs === stamp.mtimeMs
  );
}

/**
 * Extracts every document of the project: walks `include` minus `exclude`,
 * analyzes each `.vue`, scans each script block, parses and names the documents,
 * and reports the extraction-time diagnostics.
 *
 * With `options.previous` and `options.files`, every file the change set does not
 * name (directly or through a `<script src>`) is reused from the previous result
 * instead of being read and parsed again. The assembled result is byte-identical
 * either way: re-use replaces work, never decisions.
 */
export async function extractProject(
  config: ResolvedConfig,
  options: ExtractOptions = {},
): Promise<ExtractResult> {
  const observe = options.onPhase;
  const diagnostics: Diagnostic[] = [];
  const documents: RawDocument[] = [];
  const imports: GqlImport[] = [];
  const importedNames: string[] = [];
  const seen = new Set<string>();

  const allFiles = await timed(observe, 'extract:discover', () =>
    walkFiles(config.projectDir, config.include, config.exclude, diagnostics, 'flamme.config.ts'),
  );

  const previous = options.previous;
  const changed = options.files === undefined ? undefined : new Set(options.files);
  // A file whose `<script src>` target changed is stale too: part of its text was
  // scanned out of that target.
  const dependents = new Set<string>();
  if (previous !== undefined && changed !== undefined) {
    for (const record of previous.byFile.values()) {
      if (record.dependencies.some((dependency) => changed.has(dependency))) {
        dependents.add(record.relative);
      }
    }
  }
  const reusable = (path: string): boolean =>
    previous !== undefined &&
    changed !== undefined &&
    !changed.has(path) &&
    !dependents.has(path);

  // Every file the change set does not name is reused from the previous
  // extraction, after a `stat` confirms nothing rewrote it behind the watcher's
  // back. Only the remainder is read and parsed.
  const records = new Map<string, FileExtraction>();
  const stale: DiscoveredFile[] = [];
  if (previous === undefined || changed === undefined) {
    // No cache to reuse from, or no change set that would justify it: everything
    // is read and parsed. `files` without `previous` is the partial scan the
    // caller asked for (the change set alone, as it has always been).
    stale.push(
      ...(changed === undefined ? allFiles : allFiles.filter((entry) => changed.has(entry.relative))),
    );
  } else {
    await timed(observe, 'extract:stat', async () => {
      const verdicts = await Promise.all(
        allFiles.map(async (entry): Promise<readonly [DiscoveredFile, FileExtraction | undefined]> => {
          if (!reusable(entry.relative)) {
            return [entry, undefined];
          }
          const stamp = await fileStamp(entry.absolute);
          const record = previous.byFile.get(entry.relative);
          return [entry, recordIsCurrent(record, stamp) ? record : undefined];
        }),
      );
      for (const [entry, record] of verdicts) {
        if (record === undefined) {
          stale.push(entry);
        } else {
          records.set(entry.relative, record);
        }
      }
    });
  }

  // Files and their `src` targets are read concurrently: extraction is I/O bound
  // and the per-file work below stays synchronous and ordered.
  const prepared = await timed(observe, 'extract:read', () =>
    Promise.all(stale.map((entry) => prepareFile(entry, config))),
  );
  await timed(observe, 'extract:scan', async () => {
    const stamps = await Promise.all(stale.map((entry) => fileStamp(entry.absolute)));
    prepared.forEach((item, index) => {
      const residue = extractFile(item, config);
      const stamp = stamps[index];
      records.set(item.entry.relative, {
        relative: item.entry.relative,
        // -1 marks a file that could not be stamped, so it is never reused.
        size: stamp?.size ?? -1,
        mtimeMs: stamp?.mtimeMs ?? -1,
        documents: residue.documents,
        diagnostics: residue.diagnostics,
        imports: residue.imports,
        importedNames: residue.importedNames,
        dependencies: residue.dependencies,
        source: item.source,
      });
    });
  });

  // Assembly runs over the walk's sorted order whatever was reused, so the
  // assembled result cannot depend on which files the cache happened to hold:
  // every document passes the same project-wide de-duplication.
  const byFile = new Map<string, FileExtraction>();
  for (const entry of allFiles) {
    const record = records.get(entry.relative);
    if (record === undefined) {
      continue;
    }
    byFile.set(entry.relative, record);
    diagnostics.push(...record.diagnostics);
    imports.push(...record.imports);
    importedNames.push(...record.importedNames);
    for (const document of record.documents) {
      const key = `${document.relativePath}#${document.offset}#${document.name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      documents.push(document);
    }
  }

  // The programmatic page-query surface: the `Page` export of a `+page.ts`/`+layout.ts`
  // **inside the pages directory** (§4.3). A module that is not matched by `include` is
  // invisible to the compiler, so it is resolved here, where every document is known,
  // rather than in the router.
  const fileSet = new Set(allFiles.map((entry) => entry.relative));
  const pagesPrefix = routingPagesPrefix(config);
  await timed(observe, 'extract:pages', async () => {
    for (const entry of allFiles) {
      const moduleSource = byFile.get(entry.relative)?.source;
      if (moduleSource === undefined || !entry.relative.startsWith(pagesPrefix)) {
        continue;
      }
      const role = pageModuleRole(entry.relative);
      if (role === undefined) {
        continue;
      }
      const sibling = documentFileNames(config.routing, role)
        .map((name) => colocatedDocument(entry.relative, name))
        .find((candidate) => candidate !== undefined && fileSet.has(candidate));
      if (sibling !== undefined && fileSet.has(sibling)) {
        diagnostics.push(
          createDiagnostic({
            code: 'FLM1030',
            severity: 'error',
            message: `${entry.relative}: this directory declares both "${basename(sibling)}" and "${basename(entry.relative)}"; "${basename(sibling)}" is the ${role}'s loader. Delete one of them.`,
            location: locationAt(moduleSource, entry.relative, 0),
          }),
        );
        continue;
      }
      const resolution = resolvePageModule({
        file: entry.absolute,
        relativePath: entry.relative,
        source: moduleSource,
        documents,
      });
      if (resolution.diagnostic !== undefined) {
        diagnostics.push(resolution.diagnostic);
      }
    }
  });

  // FLM1017: an imported `.gql` file that `include` does not match, or that has no document.
  for (const entry of imports) {
    const relativeTarget =
      entry.resolved === undefined ? entry.specifier : toPosix(relative(config.projectDir, entry.resolved));
    const lexical = relativeTarget.startsWith('..') || isAbsolute(relativeTarget);
    const included = !lexical && matchesAny(config.include, relativeTarget) && !matchesAny(config.exclude, relativeTarget);
    const hasDocument = documents.some((document) => document.relativePath === relativeTarget);
    if (included && hasDocument) {
      continue;
    }
    diagnostics.push(
      createDiagnostic({
        code: 'FLM1017',
        severity: 'error',
        message: `${relativeTarget} is imported by ${entry.relativePath} but is not matched by include; add it to flamme.config.ts.`,
        location: locationAt(entry.source, entry.relativePath, entry.offset),
      }),
    );
  }

  return {
    documents: documents.toSorted(
      (a, b) => compareNames(a.relativePath, b.relativePath) || a.offset - b.offset,
    ),
    diagnostics,
    imports,
    importedNames: [...new Set(importedNames)],
    files: allFiles,
    byFile,
  };
}

/**
 * FLM1027: a **query** declared inline in a component is a removed surface
 * (§4.3). Fragments (and mutations/subscriptions) stay, because a fragment is
 * colocated with the component that reads it; a page's query is the page's, so
 * it belongs to `+page.gql` or to the `Page` export of `+page.ts`.
 */
function inlineQueryDiagnostic(
  document: RawDocument,
  config: ResolvedConfig,
  source: string,
): Diagnostic {
  const where = locationAt(source, document.relativePath, document.offset);
  return createDiagnostic({
    code: 'FLM1027',
    severity: 'error',
    message:
      `${where.file}:${where.line}:${where.column} "${where.file}" declares the query ` +
      `"${document.name}" (operation "${document.name}") in a component; move it to a colocated ` +
      `"${routingDocumentName(config, 'page')}" document or a "${PAGE_MODULE_FILE}" Page export.`,
    location: where,
  });
}

/** The colocated document of a page module, as a project-relative posix path. */
function colocatedDocument(relativePath: string, fileName: string): string | undefined {
  if (fileName.length === 0 || fileName.includes('/')) {
    return undefined;
  }
  const at = relativePath.lastIndexOf('/');
  return at === -1 ? fileName : `${relativePath.slice(0, at)}/${fileName}`;
}

function unboundTagDiagnostic(relativePath: string, source: string, offset: number): Diagnostic {
  return createDiagnostic({
    code: 'FLM1011',
    severity: 'warning',
    message: `${relativePath}: a graphql\`…\` tag is not bound to an import from '$flamme' and was ignored.`,
    location: locationAt(source, relativePath, offset),
    hint: "import { graphql } from '$flamme'",
  });
}

/** The script text of one `<script>`/`<script setup>` block. */
interface ScriptSource {
  readonly file: string;
  readonly relativePath: string;
  readonly content: string;
  readonly source: string;
  readonly offset: number;
}

/** A file's text plus every `<script src>` target it points at, read ahead of the scan. */
interface PreparedFile {
  readonly entry: DiscoveredFile;
  readonly source: string | undefined;
  readonly readError: string | undefined;
  /** Position of an SFC parse error, so it is not reported as I/O at 1:1 (F6). */
  readonly parseError?: { readonly line: number; readonly column: number };
  readonly srcSources: ReadonlyMap<string, { readonly content: string } | { readonly error: string }>;
  readonly diagnostics: readonly Diagnostic[];
}

/** Reads one file and every `<script src>` target it references. */
async function prepareFile(entry: DiscoveredFile, config: ResolvedConfig): Promise<PreparedFile> {
  const diagnostics: Diagnostic[] = [];
  let source: string;
  try {
    source = await readFile(entry.absolute, 'utf8');
  } catch (error) {
    return {
      entry,
      source: undefined,
      readError: errorMessage(error),
      srcSources: new Map(),
      diagnostics,
    };
  }
  if (extname(entry.relative).toLowerCase() !== '.vue') {
    return { entry, source, readError: undefined, srcSources: new Map(), diagnostics };
  }

  let analysis: ReturnType<typeof analyzeVueSfc>;
  try {
    analysis = analyzeVueSfc(source, entry.absolute);
  } catch (error) {
    return {
      entry,
      source: undefined,
      readError: errorMessage(error),
      ...(error instanceof SfcParseError
        ? { parseError: { line: error.line, column: error.column } }
        : {}),
      srcSources: new Map(),
      diagnostics,
    };
  }

  const targets = analysis.scripts.flatMap((block) => (block.src === undefined ? [] : [block.src]));
  const entries = await Promise.all(
    targets.map(async (src): Promise<readonly [string, { content: string } | { error: string }]> => {
      const resolved = resolveScriptTarget(src, entry, source, 0, config, []);
      if (resolved === undefined) {
        return [src, { error: 'resolves outside the project' }];
      }
      try {
        return [src, { content: await readFile(resolved.absolute, 'utf8') }];
      } catch (error) {
        return [src, { error: errorMessage(error) }];
      }
    }),
  );
  return { entry, source, readError: undefined, srcSources: new Map(entries), diagnostics };
}

/**
 * The script text of one `<script>`/`<script setup>` block, following its `src`
 * attribute when it has one.
 */
function resolveScriptSource(
  block: SfcScriptBlock,
  entry: DiscoveredFile,
  source: string,
  config: ResolvedConfig,
  srcSources: ReadonlyMap<string, { readonly content: string } | { readonly error: string }>,
  diagnostics: Diagnostic[],
): ScriptSource | undefined {
  if (block.src === undefined) {
    return {
      file: entry.absolute,
      relativePath: entry.relative,
      content: block.content,
      source,
      offset: block.offset,
    };
  }
  const resolved = resolveScriptTarget(block.src, entry, source, block.offset, config, diagnostics);
  if (resolved === undefined) {
    return undefined;
  }
  const prepared = srcSources.get(block.src);
  if (prepared === undefined || 'error' in prepared) {
    diagnostics.push(
      createDiagnostic({
        code: 'FLM1011',
        severity: 'error',
        message: `${entry.relative}: cannot read <script src="${block.src}">: ${prepared?.error ?? 'unresolved'}`,
        location: locationAt(source, entry.relative, block.offset),
      }),
    );
    return undefined;
  }
  return {
    file: resolved.absolute,
    relativePath: resolved.relativePath,
    content: prepared.content,
    source: prepared.content,
    offset: 0,
  };
}

/** Resolves one `<script src="…">` target to an in-project path, or reports FLM1011. */
function resolveScriptTarget(
  src: string,
  entry: DiscoveredFile,
  source: string,
  offset: number,
  config: ResolvedConfig,
  diagnostics: Diagnostic[],
): { readonly absolute: string; readonly relativePath: string } | undefined {
  const absolute = isAbsolute(src) ? src : resolve(dirname(entry.absolute), src);
  const relativePath = toPosix(relative(config.projectDir, absolute));
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    diagnostics.push(
      createDiagnostic({
        code: 'FLM1011',
        severity: 'error',
        message: `${entry.relative}: src="${src}" resolves outside the project.`,
        location: locationAt(source, entry.relative, offset),
      }),
    );
    return undefined;
  }
  return { absolute, relativePath };
}

/** True when `path` is matched by the project's `include` globs and not by `exclude`. */
export function isIncluded(config: ResolvedConfig, path: string): boolean {
  return matchesAny(config.include, path) && !matchesAny(config.exclude, path);
}
