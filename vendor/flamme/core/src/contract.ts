/**
 * The compiler's structural view of the artifact contract.
 *
 * Owned by `@flamme/runtime` (`spec/spec.md` §2.2 rule 1, D1): core reaches
 * these types with `import type` only, so nothing from the runtime package can
 * end up in `dist/`, and re-exports the subset the compiler works with.
 */

export type {
  Artifact,
  ArtifactKind,
  CachePolicy,
  DeferredSpec,
  DeferredState,
  DeferredStatus,
  DirectiveSpec,
  FieldSpec,
  FragmentRef,
  FragmentSpec,
  GraphQLValue,
  InputObject,
  ListOperation,
  ListSpec,
  LoadingSpec,
  PaginationSpec,
  RefetchSpec,
  SubscriptionSelection,
  WhenCondition,
} from '@flamme/runtime';
