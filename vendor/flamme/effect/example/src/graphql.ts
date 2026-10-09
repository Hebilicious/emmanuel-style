/**
 * The documents this app reads, in the shape the Flamme compiler emits.
 *
 * A real app never writes this file: `flamme generate` writes `src/graphql/artifacts/*.ts` (with
 * `$data`, `$key`, `$input` and the selection tree this app would import). The example is
 * self-contained on purpose, so the three documents are declared by hand exactly as the emitter
 * writes them: the same `selection` tree, the same ` $fragments` marker, the same hashes.
 *
 * The three of them show the point of the fragment: `SpeciesList` selects `id` and `name` and hands
 * `SpeciesCard` down; `SpeciesCard` selects `id` and `favorite`. The list can never read `favorite`,
 * and the card can never read `name`, which is what the generated types enforce at the call site and
 * what the cache enforces at run time.
 */
import type { Artifact, FieldSpec, FragmentRef, SubscriptionSelection } from '@flamme/runtime';

/* ------------------------------------------------------------------------------- type fixtures */

/** `SpeciesList$data`: the list plus the key each row hands to the card fragment. */
export interface SpeciesListData {
  readonly species: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
    readonly ' $fragments': { readonly SpeciesCard: FragmentRef };
  }>;
}

/** `SpeciesCard$data`: the fragment's own view. */
export interface SpeciesCardData {
  readonly id: number;
  readonly favorite: boolean;
}

/** `SpeciesCard$key`: what the list must carry to hand a row to the card. */
export type SpeciesCardKey = {
  readonly ' $fragments': { readonly SpeciesCard: FragmentRef };
};

/** `ToggleFavorite$data`. */
export interface ToggleFavoriteData {
  readonly toggleFavorite: { readonly id: number; readonly favorite: boolean };
}

/* ------------------------------------------------------------------------------------- selections */

const TYPENAME: FieldSpec = { type: 'String', modifiers: 'String!', keyRaw: '__typename' };

/** A visible scalar leaf. */
function leaf(type: string, modifiers: string, keyRaw: string): FieldSpec {
  return { type, modifiers, keyRaw, visible: true, loading: { kind: 'value' } };
}

/** A leaf a spread contributes: stored by the parent's write, masked out of the parent's own read. */
function spreadLeaf(type: string, modifiers: string, keyRaw: string): FieldSpec {
  return { type, modifiers, keyRaw, visible: false, loading: { kind: 'value' } };
}

/** `fragment SpeciesCard on Species { id favorite }`. */
const cardSelection: SubscriptionSelection = {
  fields: {
    __typename: TYPENAME,
    id: leaf('Int', 'Int!', 'id'),
    favorite: leaf('Boolean', 'Boolean!', 'favorite'),
  },
};

/**
 * `query SpeciesList { species { id name ...SpeciesCard } }`.
 *
 * `favorite` appears in the list's `fields` with `visible: false` *and* in `fragments`: the emitter
 * inlines every spread's fields into the parent's selection (they are what the write stores, which
 * is why the card can read them from the first response) and keeps the `fragments` entry that makes
 * the masked read write the child's `$key`. The list's own *type* still excludes `favorite`, and the
 * mask keeps it out of the list's own read.
 */
const listSelection: SubscriptionSelection = {
  fields: {
    __typename: TYPENAME,
    species: {
      type: 'Species',
      modifiers: '[Species!]!',
      keyRaw: 'species',
      visible: true,
      loading: { kind: 'continue', list: { depth: 1, count: 3 } },
      selection: {
        fields: {
          __typename: TYPENAME,
          id: leaf('Int', 'Int!', 'id'),
          name: leaf('String', 'String!', 'name'),
          favorite: spreadLeaf('Boolean', 'Boolean!', 'favorite'),
        },
        fragments: { SpeciesCard: { arguments: {} } },
      },
    },
  },
};

/* ------------------------------------------------------------------------------------ artifacts */

function artifact<K extends Artifact['kind'], TData, TInput, TKey = never>(document: {
  readonly name: string;
  readonly kind: K;
  readonly hash: string;
  readonly raw: string;
  readonly rootType: string;
  readonly selection: SubscriptionSelection;
  readonly input?: Artifact['input'];
}): Artifact<K, TData, TInput, TKey> {
  return {
    name: document.name,
    kind: document.kind,
    hash: document.hash,
    raw: document.raw,
    rootType: document.rootType,
    selection: document.selection,
    stripVariables: [],
    pluginData: {},
    ...(document.input === undefined ? {} : { input: document.input }),
  };
}

/** `query SpeciesList { species { id name ...SpeciesCard } }`. */
export const SpeciesList: Artifact<'query', SpeciesListData> = artifact({
  name: 'SpeciesList',
  kind: 'query',
  hash: 'example-species-list',
  raw: 'query SpeciesList {\n  species {\n    id\n    name\n    ...SpeciesCard\n  }\n}\n',
  rootType: 'Query',
  selection: listSelection,
});

/** `fragment SpeciesCard on Species { id favorite }`. */
export const SpeciesCard: Artifact<'fragment', SpeciesCardData, never, SpeciesCardKey> = artifact<
  'fragment',
  SpeciesCardData,
  never,
  SpeciesCardKey
>({
  name: 'SpeciesCard',
  kind: 'fragment',
  hash: 'example-species-card',
  raw: 'fragment SpeciesCard on Species {\n  id\n  favorite\n}\n',
  rootType: 'Species',
  selection: cardSelection,
});

/** `mutation ToggleFavorite($id: Int!) { toggleFavorite(id: $id) { id favorite } }`. */
export const ToggleFavorite: Artifact<'mutation', ToggleFavoriteData, { id: number }> = artifact({
  name: 'ToggleFavorite',
  kind: 'mutation',
  hash: 'example-toggle-favorite',
  raw: 'mutation ToggleFavorite($id: Int!) {\n  toggleFavorite(id: $id) {\n    id\n    favorite\n  }\n}\n',
  rootType: 'Mutation',
  selection: {
    fields: {
      __typename: TYPENAME,
      toggleFavorite: {
        type: 'Species',
        modifiers: 'Species!',
        keyRaw: 'toggleFavorite(id: $id)',
        visible: true,
        loading: { kind: 'continue' },
        selection: cardSelection,
      },
    },
  },
  input: {
    fields: { id: 'Int' },
    types: {},
    defaults: {},
    runtimeScalars: {},
  },
});
