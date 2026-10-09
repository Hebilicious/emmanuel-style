/**
 * `@flamme/runtime` — the shared contract module.
 *
 * This module owns every artifact, result, pipeline, lifecycle and cache **type** the other slices
 * compile against, plus the three pieces of runtime behaviour that are pure and framework-agnostic:
 * the `Pending` sentinel with its frame marker (`./loading.js`), the ` $fragments` masking channel
 * (`./mask.js`), and the public runtime error classes (`./errors.js`).
 *
 * The §5 client (its plugins, the pipeline runner, the document store and the lifecycle) and the
 * §6 cache are real implementations behind those declarations. Dependency direction: this package
 * imports nothing from the workspace, never `vue` and never `@flamme/core` (§2.2 rule 3, D1).
 */

/* -------------------------------------------------------------------------- values (§2.1) */

export {
  isLoaded,
  isLoadingFrame,
  isPending,
  LOADING_FRAME,
  markLoadingFrame,
  Pending,
  PendingValue,
} from './loading.js';
export {
  advanceDeferredState,
  applyIncrementalPatch,
  cacheDeferredState,
  deferKeys,
  deferredLabels,
  initialDeferredState,
  insertItems,
  isDeferred,
  matchDeferred,
  NO_DEFERRED,
} from './incremental.js';
export type { IncrementalPatch, PatchOutcome } from './incremental.js';
export {
  boundaryOf,
  INCREMENTAL_ACCEPT,
  isMultipart,
  normalizePart,
  parseMultipart,
  readMultipartResponse,
  readTransportResponse,
} from './network/incremental.js';
export type { IncrementalPart } from './network/incremental.js';
export { fragmentKey, hasFragment, isFragmentRef } from './mask.js';
export { REQUIRED_MISSING_TYPENAME } from './required.js';
export {
  ClientDisposedError,
  FrozenSnapshotError,
  GraphQLHttpError,
  FlammeRuntimeError,
  HttpError,
  MaskedFieldReadError,
  MissingFragmentSpreadError,
  MissingRecordError,
  NetworkError,
  SnapshotVersionMismatchError,
  SubscriptionTransportError,
  UnknownListError,
  UnknownPaginationError,
} from './errors.js';

/* ------------------------------------------------------------- the artifact format (§3.2) */

export type {
  Artifact,
  ArtifactData,
  ArtifactInput,
  ArtifactKey,
  ArtifactKind,
  CachePolicy,
  DataSource,
  DeferredSpec,
  DeferredState,
  DeferredStatus,
  DirectiveSpec,
  FieldSpec,
  FragmentKey,
  FragmentMarker,
  FragmentRef,
  FragmentReference,
  FragmentSpec,
  FrameKey,
  GraphQLValue,
  Incremental,
  InputObject,
  ListOperation,
  ListSpec,
  ListWhen,
  LoadingSpec,
  PaginationSpec,
  RecordId,
  RefetchSpec,
  SubscriptionSelection,
  Variables,
  WhenCondition,
} from './artifact.js';

/* ------------------------------------------------------------------ the sentinel and predicates */

export type { LoadedBranchOf, LoadingType } from './loading.js';

/* ------------------------------------------------------------------------------ the runtime (§5) */

export { Client, clientRequests, createClient, isClientDisposed, pluginsFor } from './client.js';
export type {
  ClientConfig,
  GraphQLResponseError,
  MutationOptions,
  ObserveOptions,
  PersistedQueryConfig,
  PersistedQueryOptions,
  PersistedQuerySpec,
  QueryOptions,
  ResolvedClientConfig,
  ResolvedPersistedQueryConfig,
  SubscribeFn,
  SubscriptionHandlers,
  TransportFn,
  TransportRequest,
  TransportResponse,
} from './client.js';

export {
  cleanupPlugins,
  createRequestContext,
  requestStateOf,
  runPipeline,
  REQUEST_STATE,
} from './pipeline.js';
export type { ClientPlugin, PipelineStage, RequestContext, RequestState } from './pipeline.js';

export { createQueryLifecycle, DefaultQueryLifecycle, isStoreLifecycle } from './lifecycle.js';
export type {
  QueryLifecycle,
  QueryLifecycleOptions,
  RequestOutcome,
  StoreLifecycle,
} from './lifecycle.js';

export { DocumentStore } from './store.js';
export type { DocumentStoreOptions, SendOptions } from './store.js';
export type { QueryResult } from './result.js';

export { DisposalStack } from './disposal.js';

export {
  RequestRegistry,
  dedupeConfigOf,
  requestKey,
  resolveCachePolicy,
  stableStringify,
} from './requests.js';
export type { DedupeConfig, InFlightRequest } from './requests.js';

export {
  CACHE_MISS,
  applyOperations,
  cachePlugin,
  defaultPlugins,
  fetchPlugin,
  fragmentPlugin,
  isAbortError,
  isCacheMiss,
  kindPlugin,
  mutationPlugin,
  queryPlugin,
  requiresNetwork,
  subscriptionPlugin,
  throwOnError,
} from './plugins/index.js';
export type { DefaultPluginsOptions, ThrowOnErrorOptions } from './plugins/index.js';

export { createFetchTransport, isPersistedQueryMiss } from './network/transport.js';
export type { FetchLike, FetchTransportOptions } from './network/transport.js';
export { createWebSocketTransport } from './network/websocket.js';
export type {
  SubscriptionTransport,
  WebSocketEventLike,
  WebSocketFactory,
  WebSocketLike,
  WebSocketTransportOptions,
} from './network/websocket.js';
export { createSseTransport } from './network/sse.js';
export type { SseMode, SseTransportOptions } from './network/sse.js';

export { isOptimisticId, OPTIMISTIC_ID_PREFIX } from './optimistic.js';
export type { OptimisticKeySite } from './optimistic.js';
export { marshalInputs } from './variables.js';
export { devWarn, isProduction } from './dev.js';
export { readDocument, reportPartial, writeDocument, ROOT_RECORD } from './reader.js';
export type { DocumentRead, ReadDocumentOptions, WriteDocumentOptions } from './reader.js';

/* -------------------------------------------------------------------------------- the cache (§6) */

export {
  Cache,
  CacheSubscriptions,
  GarbageCollector,
  InMemoryStorage,
  ListManager,
  StaleManager,
  computeID,
  computeKey,
  countPage,
  cursorHandlers,
  evaluateKey,
  offsetHandlers,
  extractPageInfo,
  keyFieldsForType,
  opaqueListID,
} from './cache.js';
export type {
  CacheConfig,
  CacheLayer,
  CacheMessage,
  ConnectionSnapshot,
  ListHandle,
  ListSnapshot,
  OffsetHandlers,
  PageInfo,
  ReadOptions,
  ReadResult,
  StorageSnapshot,
  SubscriptionSpec,
  WriteOptions,
  WriteResult,
} from './cache.js';
export type {
  PageKey,
  SerializedCache,
  SerializedChanges,
  SerializedList,
  SerializedPage,
  SerializedRecordFields,
  SerializedRecordLinks,
} from './serialize.js';

/* ------------------------------------------------------------------------------------ errors (§12) */

export type { FlammeRuntimeErrorOptions } from './errors.js';
