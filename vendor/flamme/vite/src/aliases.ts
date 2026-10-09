/**
 * The `$flamme` alias injection (`spec/spec.md` §2.4, §10.2 `config`).
 * Both shapes of `resolve.alias` are supported because Vite 8 accepts either and
 * a consumer using the array form must not lose their own entries.
 */

import { join } from 'node:path';

import type { Alias, AliasOptions } from 'vite';

import type { UserConfigLike } from './context.js';

/** The bare specifier every generated module is reachable under. */
export const FLAMME_ALIAS = '$flamme';

/** The two alias entries the plugin injects. */
export function flammeAliases(runtimeDir: string): readonly Alias[] {
  return [
    { find: FLAMME_ALIAS, replacement: runtimeDir },
    { find: `${FLAMME_ALIAS}/*`, replacement: join(runtimeDir, '*') },
  ];
}

/** The object form of the injected aliases. */
function asObject(entries: readonly Alias[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of entries) {
    record[String(entry.find)] = entry.replacement;
  }
  return record;
}

/** Narrows an alias option to its array form. */
function isAliasArray(value: AliasOptions): value is readonly Alias[] {
  return Array.isArray(value);
}

/** Merges our aliases into the user's, preserving the shape they used. */
export function injectAliases(userConfig: UserConfigLike, runtimeDir: string): AliasOptions {
  const entries = flammeAliases(runtimeDir);
  const existing = userConfig.resolve?.alias;
  if (existing === undefined) {
    return asObject(entries);
  }
  if (isAliasArray(existing)) {
    return [...existing, ...entries];
  }
  return { ...existing, ...asObject(entries) };
}
