/**
 * `mutationPlugin` (§5.2, §6.2, §7.4).
 *
 * `start` opens the request's optimistic layer and writes the optimistic payload into it;
 * `afterNetwork` applies the payload's `@list` operations into the same layer; `end` resolves the
 * layer into the cache on success or rolls it back on failure, and re-reads so subscribers see the
 * real values again. Every operation is applied with `cache.lists.apply`, so an optimistic toggle
 * and its rollback are one layer-scoped array write and no cache logic lives in the client.
 */
import type {
  Artifact,
  ListOperation,
  RecordId,
  SubscriptionSelection,
  Variables,
} from '../artifact.js';
import type { Cache, CacheLayer } from '../cache.js';
import type { ClientPlugin, RequestContext } from '../pipeline.js';
import { requestStateOf } from '../pipeline.js';
import { readDocument, reportPartial, writeDocument } from '../reader.js';
import { asRecord, keyFieldsForType, recordIdFor } from '../cache/keys.js';
import { listSpecFor } from '../cache/lists.js';
import { devWarn } from '../dev.js';
import { optimisticRecordId, stampOptimisticKeys, valueAtPath } from '../optimistic.js';

/** `true` when a mutation request failed: aborted, a transport error, or errors with no data. */
function failed(
  ctx: RequestContext,
  response: { readonly data?: unknown; readonly errors?: unknown } | null,
): boolean {
  const state = requestStateOf(ctx);
  if (state.aborted || state.error !== undefined) {
    return true;
  }
  if (response === null) {
    return true;
  }
  return response.data === undefined || response.data === null;
}

/** The mutation plugin: the optimistic layer, `artifact.operations` and the rollback. */
export function mutationPlugin(): ClientPlugin {
  return {
    name: 'mutationPlugin',
    start: (ctx: RequestContext) => {
      if (ctx.artifact.kind !== 'mutation') {
        return;
      }
      const state = requestStateOf(ctx);
      state.beforeData = ctx.result.data;
      const layer = ctx.client.cache.createLayer(true);
      state.layer = layer;

      const optimistic = state.optimistic;
      if (optimistic === undefined) {
        ctx.commit({ fetching: true, variables: ctx.variables, errors: null });
        return;
      }
      // §7.14: `@optimisticKey` lets the payload omit the id the server will assign. The record is
      // stamped with a generated id *before* it is written, so the record, its list membership and
      // every link to it are all written under one id, and the confirmation remaps them together.
      const stamped = stampOptimisticKeys(ctx.artifact, optimistic);
      state.optimisticKeySites = stamped.sites;
      writeDocument(ctx.client.cache, ctx.artifact, stamped.data, ctx.variables, { layer });
      // the list operations of the optimistic payload land in the same layer, so a rollback undoes
      // them and a resolve merges them down (§6.2, §7.4); the response payload is not re-applied
      applyOperations(ctx.client.cache, ctx.artifact, stamped.data, ctx.variables, layer);
      const read = readDocument<unknown>(ctx.client.cache, ctx.artifact, state.storeVariables, {
        layer,
        previous: ctx.result.data,
      });
      ctx.commit({
        data: read.data,
        partial: reportPartial(read.partial, ctx.artifact.partial ?? ctx.client.config.partial),
        stale: false,
        source: 'optimistic',
        variables: state.storeVariables,
        fetching: true,
        errors: null,
      });
    },
    afterNetwork: (ctx: RequestContext) => {
      const state = requestStateOf(ctx);
      if (ctx.artifact.kind !== 'mutation' || state.layer === null) {
        return;
      }
      if (failed(ctx, state.response)) {
        return;
      }
      // The server confirmed the payload: apply the payload's list operations. They land in the
      // **base** layer even when an `optimistic` payload supplied this request's operations,
      // because they are the server's answer and the mutation layer holds a *guess*: writing them
      // only into the layer loses the confirmed membership the moment that layer is rolled back
      // (`review-slice34-adversarial.md` M3). A successful mutation merges its layer on top of
      // these, so an idempotent action lands once; a rollback leaves the confirmed membership.
      applyOperations(
        ctx.client.cache,
        ctx.artifact,
        state.response?.data ?? null,
        ctx.variables,
        ctx.client.cache.storage.baseLayer(),
      );
    },
    end: (ctx: RequestContext) => {
      const state = requestStateOf(ctx);
      if (ctx.artifact.kind !== 'mutation' || state.layer === null) {
        return;
      }
      const cache = ctx.client.cache;
      const layer = state.layer;
      const partialAllowed = ctx.artifact.partial ?? ctx.client.config.partial;

      if (failed(ctx, state.response)) {
        // rollback: the layer is dropped, its fields are marked stale and the store re-reads (§6.2).
        // The layer handle is dropped only *after* the rollback ran, so a throwing rollback cannot
        // orphan the layer (the optimistic values would otherwise stay live forever, and
        // `serialize()` would disagree with every read, `review-slice34-adversarial.md` M4). A
        // rollback that refuses to run is retried as a raw drop, so the optimistic values never
        // outlive the failure; the rollback's own error is never the outcome the caller sees.
        const rollback = rollbackLayer(cache, layer);
        state.layer = null;
        const read = readDocument<unknown>(cache, ctx.artifact, state.storeVariables, {
          previous: ctx.result.data,
        });
        ctx.commit({
          // the rollback restores what the store held before the request, not the empty re-read
          data: state.beforeData ?? null,
          partial: reportPartial(read.partial, partialAllowed),
          stale: true,
          source: 'cache',
          fetching: false,
        });
        if (rollback !== null) {
          devWarn(
            `The rollback of a failed mutation threw, so it was dropped directly: ${
              rollback instanceof Error ? rollback.message : describeUnknown(rollback)
            } (FLM4007).`,
            'report this with the layer state from client.serialize()',
          );
        }
        return;
      }

      // §7.14: move every stamped record to the id the server assigned before the layer resolves,
      // so the merge into the base layer carries the real ids and no generated one.
      remapOptimisticKeys(ctx, layer);
      state.layer = null;
      cache.clearLayer(layer, { resolve: true });
      const read = readDocument<unknown>(cache, ctx.artifact, state.storeVariables, {
        previous: ctx.result.data,
      });
      ctx.commit({
        data: read.data,
        partial: reportPartial(read.partial, partialAllowed),
        stale: read.stale,
        source: 'network',
        fetching: false,
      });
    },
    cleanup: (ctx: RequestContext) => {
      // a torn-down mutation aborts its layer rather than leaving optimistic values behind
      const state = requestStateOf(ctx);
      if (state.layer === null) {
        return;
      }
      const layer = state.layer;
      state.layer = null;
      ctx.client.cache.clearLayer(layer, { resolve: false });
    },
  };
}

/**
 * Moves the records the optimistic payload stamped with a generated id to the ids the confirmation
 * assigned (§7.14), rewriting every reference to them.
 *
 * A confirmation that never supplies the id leaves the temporary record in place, and one whose
 * temporary record was removed underneath it cannot move the fields but can still rewrite the
 * references. Both are reported: a silent remap failure would leave a generated id in the cache
 * forever, which is exactly the corruption the directive exists to prevent.
 */
function remapOptimisticKeys(ctx: RequestContext, layer: CacheLayer): void {
  const state = requestStateOf(ctx);
  if (state.optimisticKeySites.length === 0) {
    return;
  }
  const data = state.response?.data ?? null;
  for (const site of state.optimisticKeySites) {
    const temporary = optimisticRecordId(site);
    const record = asRecord(valueAtPath(data, site.path));
    const keys = keyFieldsForType(ctx.client.cache.config, site.type);
    const resolved =
      record !== null &&
      keys.length > 0 &&
      keys.every((field) => record[field] !== undefined && record[field] !== null);
    if (!resolved) {
      devWarn(
        `The confirmation for "${ctx.artifact.name}" left the @optimisticKey field unresolved at ${describePath(site.path)}; "${temporary}" stays in the cache (FLM1011).`,
        `select the field marked @optimisticKey on every "${site.type}" the mutation writes`,
      );
      continue;
    }
    const real = recordIdFor(ctx.client.cache.config, site.type, record);
    if (real === null || real === temporary) {
      continue;
    }
    if (!ctx.client.cache.remapOptimistic(temporary, real, layer)) {
      devWarn(
        `The @optimisticKey remap of "${temporary}" had no temporary record to move to "${real}"; its references were rewritten, so the cache holds no generated id (FLM1011).`,
        'the optimistic record was deleted before the server answered; do not delete an optimistic insert',
      );
    }
  }
}

/** A payload path as `createSpecies.species`, for a warning a human can act on. */
function describePath(path: readonly (string | number)[]): string {
  return path.length === 0 ? '<root>' : path.map((step) => String(step)).join('.');
}

/**
 * Applies every list operation a mutation payload carries. Operations recorded on a payload field
 * (`FieldSpec.operations`, what the compiler emits for `...FavoriteSpecies_toggle`) target that
 * field's record; an artifact-level operation carries an explicit `path` into the payload. An
 * operation naming a list that was never registered is FLM4003: a DEV warning, and the payload write
 * still happens (§12.2). The request's variables reach `ListManager.apply` so the operation's
 * `@when`/`@when_not` conditions can be resolved against them (§6.7).
 */
export function applyOperations(
  cache: Cache,
  artifact: Artifact,
  data: unknown,
  variables: Variables,
  layer: CacheLayer,
): void {
  const operations: { readonly operation: ListOperation; readonly target: RecordId }[] = [];

  for (const operation of artifact.operations ?? []) {
    const target = operation.path === undefined ? null : recordAt(cache, data, operation.path);
    if (target !== null) {
      operations.push({ operation, target });
    }
  }
  collectFieldOperations(cache, artifact.selection, data, operations);

  for (const { operation, target } of operations) {
    if (!cache.lists.has(operation.list)) {
      // A list whose own query has not resolved yet can still be registered if the artifact
      // declares the `@list` spec anywhere (the compiler emits it on the field that declares the
      // list); a document that declares it nowhere is the FLM4003 case of §12.2.
      const spec = listSpecFor(artifact.selection, operation.list);
      if (spec === null) {
        devWarn(
          `The operation "${operation.action}" names the list "${operation.list}", which was never registered (FLM4003).`,
          'write the @list(name:) field first, or fix the @list name in the document',
        );
        continue;
      }
      cache.lists.register(operation.list, spec);
    }
    cache.lists.apply(operation, target, layer, variables);
  }
}

/**
 * Rolls a failed mutation's optimistic layer back, returning the rollback failure or `null`.
 *
 * A `clearLayer` that throws (a cache decorator under test, or a future invariant) must not leave
 * the layer in the stack: the optimistic values would stay visible forever and the base layer that
 * `serialize()` reads would disagree with every live read. The raw drop is the fallback, and the
 * primary failure is returned rather than thrown so the caller keeps the server's error.
 */
function rollbackLayer(cache: Cache, layer: CacheLayer): unknown {
  try {
    cache.clearLayer(layer, { resolve: false });
    return null;
  } catch (error) {
    try {
      cache.storage.removeLayer(layer);
      cache.stale.dropLayer(layer.id);
      cache.refresh(recordsOfLayer(layer));
    } catch {
      // the cache is already gone (a disposed client): there is nothing left to drop
    }
    return error;
  }
}

/** A thrown value as a message: an `Error` has one, anything else is described rather than stringified. */
function describeUnknown(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return Object.prototype.toString.call(value);
}

/** Every record a layer touched, for the dirty set a fallback drop still has to publish. */
function recordsOfLayer(layer: CacheLayer): readonly RecordId[] {
  return [...new Set([...layer.fields.keys(), ...layer.links.keys(), ...layer.deleted])];
}

/** The cache's key rules are what turns a payload object into a record id; nothing else is used. */
/** Walks the selection and the payload together, collecting the operations on each payload field. */
function collectFieldOperations(
  cache: Cache,
  selection: SubscriptionSelection,
  data: unknown,
  out: { readonly operation: ListOperation; readonly target: RecordId }[],
): void {
  const record = asRecord(data);
  if (record === null) {
    return;
  }
  for (const [name, spec] of Object.entries(selection.fields ?? {})) {
    if (!Object.hasOwn(record, name)) {
      continue;
    }
    const value = record[name];
    const elements = Array.isArray(value) ? value : [value];
    for (const element of elements) {
      const single = asRecord(element);
      if (single === null) {
        continue;
      }
      if (spec.operations !== undefined && spec.operations.length > 0) {
        const type = typeof single['__typename'] === 'string' ? single['__typename'] : spec.type;
        const id = recordIdFor(cache.config, type, single);
        if (id !== null) {
          for (const operation of spec.operations) {
            out.push({ operation, target: id });
          }
        }
      }
      if (spec.selection !== undefined) {
        collectFieldOperations(cache, spec.selection, single, out);
      }
    }
  }
}

/** The record id of the payload value at a `ListOperation.path`, or `null`. */
function recordAt(cache: Cache, data: unknown, path: readonly string[]): RecordId | null {
  let current: unknown = data;
  for (const name of path) {
    const record = asRecord(current);
    if (record === null) {
      return null;
    }
    current = record[name];
  }
  const record = asRecord(current);
  if (record === null) {
    return null;
  }
  const type = typeof record['__typename'] === 'string' ? record['__typename'] : null;
  if (type === null) {
    return null;
  }
  return recordIdFor(cache.config, type, record);
}
