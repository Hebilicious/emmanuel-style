/**
 * Module-private helpers of `@flamme/local`.
 *
 * They exist so the public modules do not each grow their own copy of "is this an object", "run this
 * without letting it throw into a caller", and the layer bookkeeping the store repeats.
 */
import type { Cache, CacheLayer, RecordId } from '@flamme/runtime';

/** `true` for a plain object (not `null`, not an array): the shape every payload check starts from. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every record a layer wrote or deleted, for record-level invalidation. */
export function recordsOf(layer: CacheLayer): RecordId[] {
  const records = new Set<RecordId>(layer.deleted);
  for (const recordId of layer.fields.keys()) {
    records.add(recordId);
  }
  for (const recordId of layer.links.keys()) {
    records.add(recordId);
  }
  return [...records];
}

/**
 * Drops a layer without marking its fields stale.
 *
 * `Cache.clearLayer` is the runtime's rollback, and it marks a layer's fields stale so the next
 * `CacheOrNetwork` read refetches. A queued local write is not an invalidation: when the queue
 * changes the layer stack is rebuilt, and marking every pending record stale would turn each
 * enqueue into a refetch. The dirty notification is left to the writer that re-applies the queue.
 */
export function dropLayer(cache: Cache, layer: CacheLayer): void {
  cache.storage.removeLayer(layer);
  cache.stale.dropLayer(layer.id);
}

/** Tells every subscription touching these records that it must re-read. */
export function notifyRecords(cache: Cache, records: readonly RecordId[]): void {
  const keys = cache.subscriptions.keysForRecords(records);
  if (keys.length > 0) {
    cache.subscriptions.markDirty(keys);
  }
}

/** A message for anything thrown; an `Error` contributes its message, everything else is described. */
export function describeError(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  return Object.prototype.toString.call(value);
}
