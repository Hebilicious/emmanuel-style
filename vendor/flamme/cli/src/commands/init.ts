/**
 * `flamme init`: idempotently create `flamme.config.ts`, add the
 * generated `.flamme/tsconfig.json` to the app's `extends` array and ignore
 * `.flamme/`. `--dry-run` prints a diff and writes nothing.
 *
 * The tsconfig and .gitignore edits are text edits, not `JSON.parse` round
 * trips: tsconfig.json is JSONC (comments and trailing commas are legal) and
 * rewriting it would destroy the user's comments and formatting.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ConfigError } from '@flamme/core';

import { errorText } from '../errors.js';

import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import type { ResolvedIo } from '../io.js';

/** The config file `init` writes when there is none. */
export const INIT_CONFIG_FILE = 'flamme.config.ts';

/** The app tsconfig file `init` edits. */
export const INIT_TSCONFIG_FILE = 'tsconfig.json';

/** The generated tsconfig every app tsconfig should extend. */
export const INIT_TSCONFIG_EXTENDS = './.flamme/tsconfig.json';

/** The `.gitignore` entry `init` adds. */
export const INIT_GITIGNORE_ENTRY = '.flamme/';

/** The default config file contents, with the schema source left to the user. */
export const INIT_CONFIG_TEMPLATE = `import { defineConfig } from '@flamme/core';

export default defineConfig({
  // Point at your schema: an SDL file, an introspection JSON file, or a URL.
  // schemaPath: './schema.graphql',
  // schema: './schema.json',
  // url: 'http://localhost:4000/graphql',
  include: ['src/**/*.{vue,ts,tsx,graphql,gql}'],
});
`;

/** The tsconfig `init` creates when the project has none. */
export const INIT_TSCONFIG_TEMPLATE = `{
  "extends": ["${INIT_TSCONFIG_EXTENDS}"]
}
`;

/** Context lines printed around an edit in the `--dry-run` diff. */
const DIFF_CONTEXT = 2;

/** Matches the `extends` property and captures its string or array value. */
const EXTENDS_PATTERN = /"extends"\s*:\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*")/;

/** One file `init` creates or updates. */
export interface InitChange {
  /** Project-relative posix path. */
  readonly path: string;
  /** `create` when the file does not exist yet, `update` when it does. */
  readonly kind: 'create' | 'update';
  /** Contents before `init` (`''` for a new file). */
  readonly before: string;
  /** Contents after `init`. */
  readonly after: string;
}

/** Everything `init` needs from the parsed command line. */
export interface InitContext {
  /** Resolved output sinks and working directory. */
  readonly io: ResolvedIo;
  /** `--dry-run`: print the diff and write nothing. */
  readonly dryRun: boolean;
}

/** Reads a file, or `undefined` when it does not exist. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The leading whitespace of the line that contains `index`. */
function lineIndent(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  return text.slice(start, index).replace(/[^ \t].*$/, '');
}

/** The indentation the file uses, taken from its first indented property. */
function detectedIndent(text: string): string {
  return /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
}

/** Appends `entry` to an `extends` array literal, keeping the array's layout. */
function extendArray(value: string, entry: string, indent: string): string {
  const inner = value.slice(1, -1).trim();
  const items =
    inner.length === 0
      ? []
      : inner
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
  if (!value.includes('\n')) {
    return `[${[...items, `"${entry}"`].join(', ')}]`;
  }
  const itemIndent = `${indent}  `;
  const body = [...items, `"${entry}"`].map((item) => `${itemIndent}${item}`).join(',\n');
  return `[\n${body}\n${indent}]`;
}

/** Adds an `extends` property as the first member of the tsconfig object. */
function insertExtendsProperty(text: string, entry: string): string {
  const brace = text.indexOf('{');
  if (brace < 0) {
    throw new ConfigError('FLM2001', 'tsconfig.json must contain a JSON object to add "extends".');
  }
  const indent = detectedIndent(text);
  const rest = text.slice(brace + 1);
  if (rest.trimStart().startsWith('}')) {
    return `${text.slice(0, brace + 1)}\n${indent}"extends": ["${entry}"]\n${rest.trimStart()}`;
  }
  return `${text.slice(0, brace + 1)}\n${indent}"extends": ["${entry}"],${rest}`;
}

/**
 * Adds `entry` to the `extends` field of a tsconfig, switching a string value to
 * the TypeScript 5 array form and preserving every existing entry. A file that
 * already extends `entry` is returned unchanged.
 */
export function addExtendsEntry(text: string, entry: string): string {
  const match = EXTENDS_PATTERN.exec(text);
  if (match === null) {
    if (!text.trimStart().startsWith('{')) {
      throw new ConfigError('FLM2001', 'tsconfig.json must contain a JSON object to add "extends".');
    }
    return insertExtendsProperty(text, entry);
  }
  const value = match[1] ?? '';
  if (value.includes(entry)) {
    return text;
  }
  const indent = lineIndent(text, match.index);
  const replacement = value.startsWith('[')
    ? extendArray(value, entry, indent)
    : `[\n${indent}  ${value},\n${indent}  "${entry}"\n${indent}]`;
  const valueStart = match.index + match[0].length - value.length;
  return `${text.slice(0, valueStart)}${replacement}${text.slice(match.index + match[0].length)}`;
}

/** Appends the generated-directory entry to a `.gitignore`, keeping the rest. */
export function addGitignoreEntry(text: string): string {
  const lines = new Set(text.split('\n').map((line) => line.trim()));
  if (lines.has(INIT_GITIGNORE_ENTRY) || lines.has('.flamme')) {
    return text;
  }
  const base = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${INIT_GITIGNORE_ENTRY}\n`;
}

/** Plans the config file: created only when the project has none. */
async function planConfig(root: string): Promise<InitChange | undefined> {
  const existing = await readOptional(join(root, INIT_CONFIG_FILE));
  if (existing !== undefined) {
    return undefined;
  }
  return { path: INIT_CONFIG_FILE, kind: 'create', before: '', after: INIT_CONFIG_TEMPLATE };
}

/** Plans the tsconfig edit: created, or extended in place. */
async function planTsconfig(root: string): Promise<InitChange | undefined> {
  const existing = await readOptional(join(root, INIT_TSCONFIG_FILE));
  if (existing === undefined) {
    return {
      path: INIT_TSCONFIG_FILE,
      kind: 'create',
      before: '',
      after: INIT_TSCONFIG_TEMPLATE,
    };
  }
  const after = addExtendsEntry(existing, INIT_TSCONFIG_EXTENDS);
  if (after === existing) {
    return undefined;
  }
  return { path: INIT_TSCONFIG_FILE, kind: 'update', before: existing, after };
}

/** Plans the `.gitignore` edit. */
async function planGitignore(root: string): Promise<InitChange | undefined> {
  const existing = await readOptional(join(root, '.gitignore'));
  const before = existing ?? '';
  const after = addGitignoreEntry(before);
  if (after === before) {
    return undefined;
  }
  return { path: '.gitignore', kind: existing === undefined ? 'create' : 'update', before, after };
}

/** A minimal `+`/`-`/context diff of one planned change. */
export function diffLines(change: InitChange): readonly string[] {
  const before = change.before === '' ? [] : change.before.replace(/\n$/, '').split('\n');
  const after = change.after.replace(/\n$/, '').split('\n');
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head += 1;
  }
  let tailBefore = before.length;
  let tailAfter = after.length;
  while (tailBefore > head && tailAfter > head && before[tailBefore - 1] === after[tailAfter - 1]) {
    tailBefore -= 1;
    tailAfter -= 1;
  }

  const lines = [
    before.length === 0 ? '--- /dev/null' : `--- a/${change.path}`,
    `+++ b/${change.path}`,
  ];
  for (let index = Math.max(0, head - DIFF_CONTEXT); index < head; index += 1) {
    lines.push(` ${before[index] ?? ''}`);
  }
  for (let index = head; index < tailBefore; index += 1) {
    lines.push(`-${before[index] ?? ''}`);
  }
  for (let index = head; index < tailAfter; index += 1) {
    lines.push(`+${after[index] ?? ''}`);
  }
  for (
    let index = tailBefore;
    index < Math.min(before.length, tailBefore + DIFF_CONTEXT);
    index += 1
  ) {
    lines.push(` ${before[index] ?? ''}`);
  }
  return lines;
}

/** Reverts one already-applied change; `false` when the file could not be restored. */
async function revertChange(root: string, change: InitChange): Promise<boolean> {
  try {
    if (change.kind === 'create') {
      await rm(join(root, change.path), { force: true });
    } else {
      await writeFile(join(root, change.path), change.before, 'utf8');
    }
    return true;
  } catch {
    return false;
  }
}

/** Runs `flamme init` and returns its exit code. */
export async function runInit(context: InitContext): Promise<ExitCode> {
  const root = context.io.cwd;
  const planned = await Promise.all([planConfig(root), planTsconfig(root), planGitignore(root)]);
  const changes = planned.filter((change): change is InitChange => change !== undefined);

  if (changes.length === 0) {
    context.io.stdout('flamme: already initialized; nothing to write.');
    return EXIT_CODES.success;
  }
  if (context.dryRun) {
    for (const change of changes) {
      for (const line of diffLines(change)) {
        context.io.stdout(line);
      }
    }
    context.io.stdout('flamme: dry run; nothing was written.');
    return EXIT_CODES.success;
  }

  // All-or-nothing: write every planned file, and if any of them fails restore
  // the ones that succeeded, so `init` never leaves a half-initialized project
  // behind (A4). The failure is a single one-line config error, not an internal
  // error with a stack. Each write is captured instead of rejected so the
  // outcome of every target is known before anything is reverted.
  const attempts = await Promise.all(
    changes.map(async (change) => {
      try {
        await writeFile(join(root, change.path), change.after, 'utf8');
        return { change, ok: true as const, error: undefined };
      } catch (error) {
        return { change, ok: false as const, error };
      }
    }),
  );
  const failed = attempts.find((attempt) => !attempt.ok);
  if (failed !== undefined) {
    const applied = attempts.filter((attempt) => attempt.ok).map((attempt) => attempt.change);
    const reverted = await Promise.all(applied.map((change) => revertChange(root, change)));
    let suffix = 'a partial write could not be restored';
    if (applied.length === 0) {
      suffix = 'nothing was written';
    } else if (reverted.every(Boolean)) {
      suffix = 'the files this run changed were restored';
    }
    throw new ConfigError(
      'FLM2001',
      `cannot write "${failed.change.path}": ${errorText(failed.error)} (${suffix})`,
    );
  }

  for (const change of changes) {
    const verb = change.kind === 'create' ? 'created' : 'updated';
    context.io.stdout(`flamme: ${verb} ${change.path}`);
  }
  return EXIT_CODES.success;
}
