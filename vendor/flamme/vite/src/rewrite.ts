/**
 * The step-5 rewrite (`spec/spec.md` §4.3 step 5, §10.2): replace `graphql()`
 * tags and document import specifiers with artifact imports, splice every script
 * block of a `.vue` back in one pass, and return a sourcemap that stays correct
 * after the document (the generated side *and* the original side are shifted by
 * MagicString, which is the bug §4.3 step 5.4 records).
 */

import { analyzeVueSfc, type DocumentSurface, type SfcAnalysis } from '@flamme/core';
import { MagicString, type SourceMap } from 'magic-string';

import { scanBlock, type BlockScan, type DocumentRange } from './scan.js';
import { artifactSpecifier, documentNameOf, type ArtifactIndex } from './indexes.js';

/** One document the rewrite bound in the file. */
export interface RewriteDocument {
  /** The document name the artifact is imported under. */
  readonly name: string;
  /** The local identifier the tag now resolves to. */
  readonly local: string;
  /** Which surface it came from. */
  readonly surface: DocumentSurface;
}

/** What one rewrite pass produced. */
export interface RewriteResult {
  /** The rewritten file text; identical to the input when nothing matched. */
  readonly code: string;
  /** `false` when no document or import was rewritten. */
  readonly changed: boolean;
  /** Every document the file now references. */
  readonly documents: readonly RewriteDocument[];
  /** The sourcemap, or `undefined` when nothing changed. */
  readonly map: SourceMap | undefined;
}

/** A `<script>`/`<script setup>` block of a `.vue` file, normalized. */
interface WorkBlock {
  readonly offset: number;
  readonly content: string;
  readonly lang: 'js' | 'jsx' | 'ts' | 'tsx';
  readonly scan: BlockScan;
}

/** Options for {@link rewriteFile}. */
export interface RewriteOptions {
  /** Absolute path of the file being rewritten. */
  readonly filename: string;
  /** Project-relative posix path, for diagnostics. */
  readonly relativePath: string;
  /** The artifacts the last codegen run produced. */
  readonly index: ArtifactIndex;
  /** The SFC analyzer; defaults to `@vue/compiler-sfc` through core. */
  readonly analyze?: (source: string, filename: string) => SfcAnalysis;
  /**
   * The document extensions in effect (`routing.documentExtensions`). An import specifier that ends
   * with one of them is a document import, exactly as extraction decided; without this option the
   * default pair (`.gql`, `.graphql`) applies.
   */
  readonly documentExtensions?: readonly string[];
  /**
   * The generated record module that types this file's `usePageQuery()`, when the file is a route
   * component (a page, a layout or a route-group component).
   *
   * With it, `import { usePageQuery } from '@flamme/router/auto'` becomes
   * `import { usePageQuery } from '$flamme/records/<record>'`: the call site keeps writing
   * `usePageQuery()` and reads the data of the document **its own record** loads. A file that is not
   * a route component passes nothing and keeps the untyped import (its own read is not a page's).
   */
  readonly pageQueryRecord?: string;
}

/** The script language a file extension implies. */
function langOf(filename: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  if (filename.endsWith('.tsx')) {
    return 'tsx';
  }
  if (filename.endsWith('.ts') || filename.endsWith('.mts') || filename.endsWith('.cts')) {
    return 'ts';
  }
  return 'jsx';
}

/** The entry points that re-export `usePageQuery` at runtime. */
const PAGE_QUERY_SPECIFIERS: ReadonlySet<string> = new Set([
  '@flamme/router/auto',
  '@flamme/router',
]);

/** One import statement of a `usePageQuery` binding, and the statement that replaces it. */
interface PageQueryImport {
  /** Absolute offset of the statement's first character. */
  readonly start: number;
  /** Absolute offset just past the statement. */
  readonly end: number;
  /**
   * The replacement statement(s), joined with `;` on one line. A one-line import keeps its line
   * count; a multi-line one collapses, and the sourcemap is what keeps the positions below it.
   */
  readonly replacement: string;
}

/**
 * One named specifier of an import clause (`usePageQuery`, `type X`, `a as b`).
 *
 * `type` marks a type-only specifier, which is never the composable: a file may import
 * `type RouteQueryHandle` from the same entry and that stays where it is.
 */
interface NamedSpecifier {
  readonly text: string;
  readonly imported: string;
  readonly type: boolean;
}

/** Parses the `{ … }` list of an import clause. */
function namedSpecifiers(clause: string): readonly NamedSpecifier[] | undefined {
  const open = clause.indexOf('{');
  const close = clause.lastIndexOf('}');
  if (open === -1 || close < open) {
    return undefined;
  }
  const out: NamedSpecifier[] = [];
  for (const item of clause.slice(open + 1, close).split(',')) {
    const text = item.trim();
    if (text.length === 0) {
      continue;
    }
    const type = /^type\s/u.test(text);
    const withoutType = type ? text.replace(/^type\s+/u, '') : text;
    const imported = withoutType.split(/\s+as\s+/u)[0]?.trim() ?? '';
    out.push({ text, imported, type });
  }
  return out;
}

/**
 * The import statements that bring `usePageQuery` in, and what they become.
 *
 * The rewrite is textual and confined to the statement's own range: the replacement
 * occupies exactly the characters the statement did, and MagicString's map keeps every
 * position after it exact. A one-line import stays one line, so its own line number does
 * not move either; a multi-line import collapses onto one line, which does move the
 * lines below it (the map is what keeps their mapping correct, not the line count).
 */
function pageQueryImports(
  content: string,
  offset: number,
  record: string,
): readonly PageQueryImport[] {
  const out: PageQueryImport[] = [];
  const statements = /^[ \t]*import\b[^;'"]*?from\s*(['"])([^'"]+)\1[ \t]*;?/gmu;
  for (const match of content.matchAll(statements)) {
    const specifier = match[2] ?? '';
    if (!PAGE_QUERY_SPECIFIERS.has(specifier) || match.index === undefined) {
      continue;
    }
    const clause = match[0].replace(/^[ \t]*import\b/u, '').replace(/from\s*['"][^'"]+['"][ \t]*;?\s*$/u, '');
    // `import type { … } from '…'`: the statement-level `type` belongs to the statement,
    // not to any one specifier, so it has to be carried onto both of the statements the
    // rewrite produces. Dropping it turns a type-only import into a value import.
    const statementType = /^\s*type\b/u.test(clause);
    const bindings = statementType ? clause.replace(/^\s*type\s*/u, '') : clause;
    const named = namedSpecifiers(bindings);
    if (named === undefined) {
      continue;
    }
    const moved = named.filter((entry) => entry.imported === 'usePageQuery' && !entry.type);
    if (moved.length === 0) {
      continue;
    }
    const kept = named.filter((entry) => !moved.includes(entry));
    const statementStart = offset + match.index;
    const statementEnd = statementStart + match[0].length;
    const modifier = statementType ? 'type ' : '';
    const imports = moved.map(
      (entry) => `import ${modifier}{ ${entry.text} } from '${record.replaceAll("'", "\\'")}'`,
    );
    if (kept.length > 0) {
      // Everything else the file imported from the entry stays on the original statement. A default
      // or namespace binding is part of `bindings` before the brace and is preserved as written.
      const before = bindings.slice(0, bindings.indexOf('{')).trim().replace(/,$/u, '');
      const head = before.length > 0 ? `${before}, ` : '';
      imports.unshift(
        `import ${modifier}${head}{ ${kept.map((entry) => entry.text).join(', ')} } from '${specifier}'`,
      );
    }
    out.push({ start: statementStart, end: statementEnd, replacement: imports.join(';') });
  }
  return out;
}

/** Local bindings of value imports from `$flamme` (imported name → local). */
function bindingsFromImports(text: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const statements = /\bimport\s+(?!type\b)([^'"]*?)\s+from\s*(['"])([^'"]+)\2/g;
  for (const match of text.matchAll(statements)) {
    const clause = (match[1] ?? '').trim();
    if (match[3] !== '$flamme' || !clause.startsWith('{')) {
      continue;
    }
    for (const item of clause.slice(1, clause.lastIndexOf('}')).split(',')) {
      const parts = item.split(/\s+as\s+/);
      const imported = parts[0]?.trim();
      const local = (parts[1] ?? parts[0])?.trim();
      if (imported !== undefined && imported.length > 0 && local !== undefined && local.length > 0) {
        bindings.set(imported, local);
      }
    }
  }
  return bindings;
}

/** Every identifier in `text`, ignoring the blanked document spans. */
function usedIdentifiers(text: string): Set<string> {
  const used = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    used.add(match[0]);
  }
  return used;
}

/** Replaces every range with spaces of the same length. */
function blankRanges(source: string, ranges: readonly DocumentRange[]): string {
  if (ranges.length === 0) {
    return source;
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const range of [...ranges].toSorted((a, b) => a.start - b.start)) {
    parts.push(source.slice(cursor, range.start), ' '.repeat(range.end - range.start));
    cursor = range.end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

/** Plans the imports a file needs, reusing existing bindings and aliasing collisions. */
function planImports(args: {
  readonly needed: readonly { readonly name: string; readonly specifier: string }[];
  readonly bindings: ReadonlyMap<string, string>;
  readonly used: ReadonlySet<string>;
}): { readonly imports: readonly { readonly local: string; readonly specifier: string }[]; readonly locals: ReadonlyMap<string, string> } {
  const used = new Set(args.used);
  const locals = new Map<string, string>();
  const imports: { local: string; specifier: string }[] = [];
  for (const entry of args.needed) {
    if (locals.has(entry.name)) {
      continue;
    }
    const existing = args.bindings.get(entry.name);
    if (existing !== undefined) {
      locals.set(entry.name, existing);
      continue;
    }
    let local = entry.name;
    if (used.has(local)) {
      local = `${entry.name}$artifact`;
      while (used.has(local)) {
        local = `${local}$`;
      }
    }
    used.add(local);
    locals.set(entry.name, local);
    imports.push({ local, specifier: entry.specifier });
  }
  return { imports, locals };
}

/**
 * Rewrites every document surface of one file: `graphql()` tags and calls and
 * document import specifiers (`.gql`/`.graphql` by default, or whatever
 * `routing.documentExtensions` lists).
 */
export function rewriteFile(source: string, options: RewriteOptions): RewriteResult {
  const isVue = options.filename.endsWith('.vue');
  const analyze = options.analyze ?? analyzeVueSfc;
  const analysis = isVue ? analyze(source, options.filename) : undefined;

  const blocks: WorkBlock[] = [];
  const scripts = analysis?.scripts.filter((block) => block.src === undefined) ?? [];
  if (isVue) {
    for (const block of scripts) {
      blocks.push({
        offset: block.offset,
        content: block.content,
        lang: block.lang,
        scan: scanBlock({
          code: block.content,
          file: options.filename,
          relativePath: options.relativePath,
          offset: block.offset,
          source,
          lang: block.lang,
          ...(options.documentExtensions === undefined
            ? {}
            : { documentExtensions: options.documentExtensions }),
        }),
      });
    }
  } else {
    const lang = langOf(options.filename);
    blocks.push({
      offset: 0,
      content: source,
      lang,
      scan: scanBlock({
        code: source,
        file: options.filename,
        relativePath: options.relativePath,
        offset: 0,
        source,
        lang,
        ...(options.documentExtensions === undefined
          ? {}
          : { documentExtensions: options.documentExtensions }),
      }),
    });
  }

  const blanked = blankRanges(
    source,
    blocks.flatMap((block) => block.scan.ranges),
  );
  const pageQuery =
    options.pageQueryRecord === undefined
      ? []
      : blocks.flatMap((block) =>
          pageQueryImports(block.content, block.offset, options.pageQueryRecord ?? ''),
        );

  const bindings = bindingsFromImports(blocks.map((block) => block.content).join('\n'));
  const magenta = new MagicString(source);
  const documents: RewriteDocument[] = [];
  const needed: { name: string; specifier: string }[] = [];

  // Surfaces 1 and 2: `graphql()` tags/calls and `.gql` imports in script blocks.
  for (const block of blocks) {
    for (const range of block.scan.ranges) {
      const name = documentNameOf(range.text);
      const record = name === undefined ? undefined : options.index.byName(name);
      if (name === undefined || record === undefined) {
        continue;
      }
      documents.push({ name, local: name, surface: isVue ? 'script' : 'tag' });
      needed.push({ name, specifier: artifactSpecifier(record) });
    }
    for (const entry of block.scan.imports) {
      const record = entry.resolved === undefined ? undefined : options.index.byFile(entry.resolved);
      if (record === undefined) {
        continue;
      }
      magenta.update(entry.start, entry.end, artifactSpecifier(record));
      documents.push({ name: record.name, local: record.name, surface: 'file' });
    }
  }

  const plan = planImports({
    needed,
    bindings,
    used: usedIdentifiers(blanked),
  });

  // Apply the document replacements with their bound local names.
  for (const block of blocks) {
    for (const range of block.scan.ranges) {
      const name = documentNameOf(range.text);
      const local = name === undefined ? undefined : plan.locals.get(name);
      if (local === undefined) {
        continue;
      }
      magenta.update(range.start, range.end, local);
    }
  }

  // The page's own `usePageQuery` import: rewritten to the record module that types it, inside the
  // statement's own range, so the call site is typed and the statement itself does not move.
  for (const entry of pageQuery) {
    magenta.update(entry.start, entry.end, entry.replacement);
  }

  // Insert the artifact imports at the top of the file's first script block
  // (`<script setup>` wins, so its imports are visible to `<script>` too). The
  // spec calls this `unshift`: a new declaration goes above existing imports.
  if (plan.imports.length > 0) {
    // One line, no newline: an inserted line shifts every mapped position after
    // it and the build's map composition does not compensate for it, while a
    // `;`-joined insertion keeps every original line number (`C3` in
    // `research/review-slice25-correctness.md`; dev mode masked the drift).
    const statements = plan.imports
      .map((entry) => `import ${entry.local} from '${entry.specifier.replaceAll("'", "\\'")}';`)
      .join('');
    const target = blocks[0];
    if (isVue && target === undefined) {
      // Appended at the end of the file, so nothing before it can shift.
      magenta.append(`\n<script setup>\n${statements}\n</script>\n`);
    } else if (target !== undefined) {
      magenta.appendLeft(target.offset, statements);
    }
  }

  const code = magenta.toString();
  const changed = code !== source;
  return {
    code,
    changed,
    documents: documents.map((document) => ({
      name: document.name,
      local: plan.locals.get(document.name) ?? document.local,
      surface: document.surface,
    })),
    map: changed
      ? magenta.generateMap({ hires: true, source: options.filename, includeContent: true })
      : undefined,
  };
}
