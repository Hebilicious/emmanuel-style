/**
 * Content hashing for documents (`spec/spec.md` §4.6): `sha256(raw)` over the
 * exact string stored in the artifact, trailing newline included, with no
 * trimming or normalization anywhere.
 */

import { createHash } from 'node:crypto';

/** `sha256` of `raw`, lowercase hex. The single hashing site in the compiler. */
export function hashDocument(raw: string): string {
  return createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
}
