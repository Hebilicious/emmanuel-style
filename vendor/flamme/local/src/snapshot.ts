/**
 * The persisted envelope's codec: `LocalSnapshot` to a JSON string and back.
 *
 * The cache half is validated by `Cache.hydrate` itself (it raises `SnapshotVersionMismatchError`
 * for a foreign or malformed payload), so this module validates what the cache cannot: the envelope
 * version, and the queue entries, which have to be trustworthy enough to write into the cache. An
 * entry that fails validation is dropped rather than replayed, and the caller reports it.
 */
import type { Artifact, SerializedCache } from '@flamme/runtime';
import { isRecord } from './internal.js';
import type { LocalSnapshot, StoredMutation } from './types.js';

/** The envelope version this package writes and accepts. */
export const SNAPSHOT_VERSION = 1;

/** The result of decoding a stored payload. */
export type DecodeResult =
  | { readonly ok: true; readonly snapshot: LocalSnapshot; readonly dropped: number }
  | { readonly ok: false; readonly problem: string };

/** Encodes a snapshot; the payload is JSON by contract (`Cache.serialize()` is JSON-safe, §6.10). */
export function encodeSnapshot(snapshot: LocalSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * Decodes and validates a stored payload. A payload with a different version, or one that is not an
 * object at all, is refused with a problem string; unreadable queue entries are dropped and counted,
 * so one bad entry cannot make the whole snapshot unreadable.
 */
export function decodeSnapshot(raw: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problem: 'the stored snapshot is not valid JSON' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, problem: 'the stored snapshot is not an object' };
  }
  if (parsed['v'] !== SNAPSHOT_VERSION) {
    return {
      ok: false,
      problem: `the stored snapshot has version ${String(parsed['v'])}, expected ${SNAPSHOT_VERSION}`,
    };
  }
  const cache = parsed['cache'];
  if (!isCachePayload(cache)) {
    return { ok: false, problem: 'the stored snapshot has no readable cache payload' };
  }
  const rawQueue = parsed['queue'];
  const entries = Array.isArray(rawQueue) ? rawQueue : [];
  const queue: StoredMutation[] = [];
  for (const entry of entries) {
    const validated = validateEntry(entry);
    if (validated !== null) {
      queue.push(validated);
    }
  }
  const lastSyncedAt = parsed['lastSyncedAt'];
  return {
    ok: true,
    snapshot: {
      v: SNAPSHOT_VERSION,
      cache,
      queue,
      lastSyncedAt: typeof lastSyncedAt === 'number' && Number.isFinite(lastSyncedAt) ? lastSyncedAt : null,
    },
    dropped: entries.length - queue.length,
  };
}

/**
 * `true` when the value has the shape `Cache.hydrate` accepts.
 *
 * The check is deliberately shallow: the inner records, links, lists and pages are validated by
 * `Cache.hydrate` itself, which refuses a malformed payload with `SnapshotVersionMismatchError`
 * (FLM4005) and leaves the cache untouched. This predicate only decides whether the envelope is
 * worth handing over, which is why a bad inner value is a hydration error rather than a decode one.
 */
function isCachePayload(value: unknown): value is SerializedCache {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['compiler'] === 'string' &&
    isRecord(value['records']) &&
    isRecord(value['links']) &&
    isRecord(value['lists']) &&
    isRecord(value['pages']) &&
    typeof value['fetchedAt'] === 'number'
  );
}

/** One queue entry, or `null` when it cannot be replayed safely. */
function validateEntry(value: unknown): StoredMutation | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value['id'];
  const artifact = value['artifact'];
  const variables = value['variables'];
  if (typeof id !== 'string' || !isArtifact(artifact) || !isRecord(variables)) {
    return null;
  }
  const optimistic = value['optimistic'];
  const createdAt = value['createdAt'];
  const attempts = value['attempts'];
  return {
    id,
    artifact,
    variables,
    ...(isRecord(optimistic) ? { optimistic } : {}),
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
    attempts: typeof attempts === 'number' ? attempts : 0,
  };
}

/** `true` when the value is a mutation artifact a replay can send and write. */
function isArtifact(value: unknown): value is Artifact<'mutation'> {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value['kind'] === 'mutation' &&
    typeof value['name'] === 'string' &&
    typeof value['hash'] === 'string' &&
    typeof value['raw'] === 'string' &&
    isRecord(value['selection'])
  );
}
