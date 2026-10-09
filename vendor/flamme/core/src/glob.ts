/**
 * Minimal, deterministic glob matching and directory walking. The compiler's
 * discovery step needs `**`, `*`, `?` and `{a,b}` alternatives over posix
 * paths; a full glob engine is unnecessary and would make the file order
 * implementation-defined (`spec/spec.md` §4.2).
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { compareNames } from './naming.js';
import { toPosix } from './offsets.js';
import { type Diagnostic } from './diagnostics.js';

/** Escapes every regular-expression metacharacter in `text`. */
function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Expands the first `{a,b}` group in `pattern` into one pattern per alternative.
 * Nested groups are not supported (the config schema does not use them).
 */
export function expandBraces(pattern: string): readonly string[] {
  const open = pattern.indexOf('{');
  if (open === -1) {
    return [pattern];
  }
  const close = pattern.indexOf('}', open);
  if (close === -1) {
    return [pattern];
  }
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  return pattern
    .slice(open + 1, close)
    .split(',')
    .flatMap((alternative) => expandBraces(`${prefix}${alternative}${suffix}`));
}

/**
 * Translates one expanded glob into a regular expression. `**\/` matches zero
 * or more directories, `*` and `?` never cross a `/`, everything else is
 * literal.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? '';
    if (char === '*') {
      const isDouble = pattern[index + 1] === '*';
      if (isDouble) {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when the posix path `path` matches the glob `pattern`. */
export function matchesGlob(pattern: string, path: string): boolean {
  const candidate = toPosix(path);
  if (pattern.startsWith('!')) {
    return !expandBraces(pattern.slice(1)).some((one) => globToRegExp(one).test(candidate));
  }
  return expandBraces(pattern).some((one) => globToRegExp(one).test(candidate));
}

/** True when any pattern matches; negated patterns subtract from the set. */
export function matchesAny(patterns: readonly string[], path: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (matchesGlob(pattern.slice(1), path)) {
        matched = false;
      }
    } else if (matchesGlob(pattern, path)) {
      matched = true;
    }
  }
  return matched;
}

/** A file discovered by the walk, as a project-relative posix path. */
export interface DiscoveredFile {
  /** Absolute path on disk. */
  readonly absolute: string;
  /** Posix path relative to the walk root. */
  readonly relative: string;
}

/**
 * Walks `root` depth-first, returning files whose project-relative posix path
 * matches `include` and not `exclude`, sorted by that relative path. Symlinked
 * directories are not followed, and unreadable directories are reported rather
 * than thrown so one broken folder cannot hide every document.
 */
export async function walkFiles(
  root: string,
  include: readonly string[],
  exclude: readonly string[],
  diagnostics: Diagnostic[] = [],
  reportFile = 'flamme.config.ts',
): Promise<readonly DiscoveredFile[]> {
  const visit = async (directory: string): Promise<readonly DiscoveredFile[]> => {
    let entries: readonly string[];
    try {
      entries = (await readdir(directory)).toSorted();
    } catch {
      // One stable sentence with no platform text (finding 3, option (b)); the
      // matching comment is in `crates/flamme-core/src/session.rs`. Node reports
      // libuv's `EACCES: permission denied, scandir '<path>'` and Rust reports
      // `Permission denied (os error 13)`, and the two can never be byte-identical
      // on every platform (libuv's errno strings and the path spelling differ), so
      // both backends report the path alone. The code and severity carry what
      // failed.
      diagnostics.push({
        code: 'FLM2001',
        severity: 'error',
        message: `Cannot read directory "${toPosix(directory)}"`,
        location: { file: reportFile, line: 1, column: 1, length: 1 },
      });
      return [];
    }

    const inspected = await Promise.all(
      entries.map(
        async (
          entry,
        ): Promise<{ entry: string; info: Awaited<ReturnType<typeof stat>> | undefined }> => ({
          entry,
          info: await stat(join(directory, entry)).catch(() => undefined),
        }),
      ),
    );

    const files = inspected.flatMap(({ entry, info }) => {
      const absolute = join(directory, entry);
      const relative = toPosix(absolute.slice(root.length + 1));
      if (
        info?.isFile() === true &&
        matchesAny(include, relative) &&
        !matchesAny(exclude, relative)
      ) {
        return [{ absolute, relative }];
      }
      return [];
    });

    const directories = inspected.flatMap(({ entry, info }) => {
      if (info?.isDirectory() !== true || entry === 'node_modules' || entry.startsWith('.')) {
        return [];
      }
      return [join(directory, entry)];
    });

    const nested = await Promise.all(directories.map((child) => visit(child)));
    return [...files, ...nested.flat()];
  };

  const found = await visit(root);
  return found.toSorted((a, b) => compareNames(a.relative, b.relative));
}
