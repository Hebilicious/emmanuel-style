/**
 * Reading the CLI's own version out of its package manifest, so `--version`
 * cannot drift from what is published.
 */

import { readFileSync } from 'node:fs';

/** Extracts the `version` field of a parsed `package.json`. */
export function manifestVersion(manifest: unknown): string {
  if (typeof manifest === 'object' && manifest !== null) {
    const value = Reflect.get(manifest, 'version');
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  throw new Error('package.json has no "version" field.');
}

/** The version `--version` prints: the manifest next to this module. */
export function cliVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  return manifestVersion(manifest);
}
