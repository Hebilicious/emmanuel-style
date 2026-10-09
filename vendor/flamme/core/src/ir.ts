/**
 * The compiled document IR (`spec/spec.md` §3, §4.6), as a type.
 *
 * The IR is built inside the Rust compiler (`crates/flamme-core/src/ir.rs`) and
 * crosses the boundary as the native response's `irDocuments`. This module is the
 * TypeScript shape of one document: what the plugin host hands `beforeEmit`/
 * `afterEmit`, what `rehydrateIrDocuments` rebuilds, and what `flamme explain` and
 * `flamme refs` read.
 */

import type { DocumentNode } from 'graphql';

import type {
  ArtifactKind,
  CachePolicy,
  DeferredSpec,
  InputObject,
  RefetchSpec,
  SubscriptionSelection,
} from './contract.js';
import type { RawDocument } from './extract.js';

/** A compiled document: everything the emitter and `manifest.json` need. */
export interface IrDocument {
  readonly name: string;
  readonly kind: ArtifactKind;
  /** The operation plus every transitively referenced fragment, printed (§4.4a). */
  readonly raw: string;
  /** `sha256(raw)` over the exact bytes above, trailing newline included. */
  readonly hash: string;
  readonly file: string;
  readonly source: string;
  readonly rootType: string;
  readonly selection: SubscriptionSelection;
  readonly input: InputObject;
  readonly refetch?: RefetchSpec;
  readonly pluginData: Readonly<Record<string, unknown>>;
  readonly enableLoadingState?: 'local' | 'global';
  readonly policy?: CachePolicy;
  readonly partial?: boolean;
  readonly paginated: readonly (readonly string[])[];
  readonly lists: readonly string[];
  /** Every `@defer`/`@stream` target the document declares, in source order (§7.13). */
  readonly deferred?: readonly DeferredSpec[];
  /**
   * The companion query a paginated fragment's pages are sent as
   * (`<FragmentName>_Pagination_Query`), when one was generated. The Rust backend
   * generates companions; the oracle does not (§3).
   */
  readonly paginationCompanion?: string;
  /** `true` when a field of the document is marked `@optimisticKey` (§7.14). */
  readonly optimisticKeys?: boolean;
  /** `<selection path>.<key field>` → the type whose key field was injected there. */
  readonly injectedKeys: ReadonlyMap<string, string>;
  readonly fragmentTypes: ReadonlyMap<string, string>;
  /** Fragment name → its artifact selection, for the unmasked flatten. */
  readonly fragmentSelections: ReadonlyMap<string, SubscriptionSelection>;
  readonly ast: DocumentNode;
  readonly document: RawDocument;
}

