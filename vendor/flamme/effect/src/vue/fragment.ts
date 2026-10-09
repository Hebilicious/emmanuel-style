/**
 * The fragment atom.
 *
 * The atom takes the generated `$key` a parent hands down and yields the fragment's own `$data`:
 *
 * ```ts
 * const species = querySelect(atoms.query(Info, { id }), (data) => data?.species ?? null)
 * const sprite = atoms.fragment(SpriteInfo, species)   // AsyncResult<SpriteInfo$data, FlammeError>
 * ```
 *
 * Masking is preserved in both directions. The key type carries only the ` $fragments` marker, so a
 * value without a reference for this fragment (a parent's `$unmasked` object, a hand-built record)
 * is not assignable, and the value type is the fragment's `$data`, so the parent's own fields are not
 * reachable through the atom even though the reference addresses the same record. At runtime the
 * read goes through `client.readFragment`, which reads the fragment's own selection only.
 *
 * The subscription is at fragment granularity (`client.subscribeFragment`, keyed on the parent record
 * and the fragment's hash), so a write to an unrelated record re-renders nobody, which is the same
 * guarantee `useFragment` gives a component. When the parent hands over a different reference (a list
 * row, a route change) the atom's previous subscription is released and a new one is taken.
 */
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult';
import * as Atom from 'effect/unstable/reactivity/Atom';
import * as Option from 'effect/Option';

import { fragmentKey, isFragmentRef } from '@flamme/runtime';
import type {
  Artifact,
  ArtifactData,
  ArtifactKey,
  Client,
  FragmentReference,
  QueryResult,
} from '@flamme/runtime';

import { FlammeFragmentError } from '../errors.js';
import type { FlammeError } from '../errors.js';
import type { FlammeAtomMeta } from './query.js';

/** One fragment as an atom: `AsyncResult` of the fragment's masked data. */
export type FragmentAtom<TData> = Atom.Atom<AsyncResult.AsyncResult<TData, FlammeError>>;

/**
 * What a fragment atom is read from: the generated `$key`, an `AsyncResult` of it, an atom of
 * either, or nothing.
 *
 * `null`/`undefined` is the honest "the parent has no record yet": the atom answers `Initial` and
 * starts nothing, which is what a nullable prop needs. The `AsyncResult` form is what a query atom
 * produces, so a fragment reads a parent without a `computed` in between:
 *
 * ```ts
 * const badge = atoms.fragment(FavouriteBadge, Atom.mapResult(species, (data) => data.species ?? null))
 * ```
 */
export type FragmentKeyValue<A extends Artifact<'fragment'>> =
  | ArtifactKey<A>
  | null
  | undefined
  | AsyncResult.AsyncResult<ArtifactKey<A> | null | undefined, unknown>;

export type FragmentAtomKey<A extends Artifact<'fragment'>> =
  FragmentKeyValue<A> | Atom.Atom<FragmentKeyValue<A>>;

/** One fragment atom plus the meta atom derived from the same read. */
export interface FragmentAtoms<TData> {
  /** The value a component reads: `AsyncResult<Data, FlammeError>`. */
  readonly atom: FragmentAtom<TData>;
  /** The Flamme signals the value cannot carry: `partial`, `stale`, `source`, `errors`. */
  readonly meta: Atom.Atom<FlammeAtomMeta>;
}

/** The key a source value carries: an `AsyncResult` is unwrapped, anything else is the key. */
function keyOf<A extends Artifact<'fragment'>>(value: FragmentKeyValue<A>): unknown {
  return AsyncResult.isAsyncResult(value) ? Option.getOrNull(AsyncResult.value(value)) : value;
}

/** `true` for a plain object: the only shape a ` $fragments` marker is written as. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The ` $fragments` entry a masked parent carries for one fragment, or `null`. */
function referenceOf(value: unknown, name: string): FragmentReference | null {
  if (!isRecord(value)) {
    return null;
  }
  const marker = value[fragmentKey];
  if (!isRecord(marker)) {
    return null;
  }
  const entry = marker[name];
  return isFragmentRef(entry) ? entry : null;
}

/** The record id the parent value belongs to, for the diagnostic. */
function parentOf(value: unknown): string {
  if (isRecord(value) && typeof value['id'] === 'string') {
    return value['id'];
  }
  if (isRecord(value) && typeof value['id'] === 'number') {
    return String(value['id']);
  }
  return 'unknown';
}

/** The meta of a read that produced nothing, and of a read that never happened. */
function neutralMeta<TData>(result: QueryResult<TData> | null): FlammeAtomMeta {
  return {
    partial: result?.partial ?? false,
    stale: result?.stale ?? false,
    source: result?.source ?? null,
    errors: result?.errors ?? null,
    hasNext: false,
    deferred: {},
    variables: result?.variables ?? null,
  };
}

/**
 * Reads one fragment of the record the key addresses, and derives its meta from the same read.
 *
 * `data === null` (the reference exists but the fragment's fields are not in the cache yet, which is
 * what a `@defer`ed spread looks like before its patch lands) is `Initial`, not a failure: the
 * subscription delivers the value when the fields arrive.
 */
export function makeFragmentAtoms<A extends Artifact<'fragment'>>(
  client: Client,
  artifact: A,
  key: FragmentAtomKey<A>,
): FragmentAtoms<ArtifactData<A>> {
  type TData = ArtifactData<A>;
  // the generated document is `Artifact<'fragment', TData, never, ArtifactKey<A>>`; the generic `A`
  // only guarantees the constraint, so the document is re-typed once at this boundary (§3.1)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the phantom carriers are not reachable through the constraint
  const document = artifact as Artifact<'fragment', TData, unknown, ArtifactKey<A>>;
  const parent: Atom.Atom<FragmentKeyValue<A>> = Atom.isAtom(key)
    ? key
    : Atom.make<FragmentKeyValue<A>>(key ?? null);
  /** The meta of the last read; the value atom's read is what writes it. */
  const box: { current: FlammeAtomMeta } = { current: neutralMeta<TData>(null) };
  // Register the fragment's selection with the cache now: a document that spreads this fragment
  // writes the spread's fields from its own payload through the *registered* selection, so a parent
  // whose response lands before anything read the fragment would store none of them. `useFragment`
  // does the same thing by reading with a null reference at setup; here the read happens when the
  // atom is built, which is a component's setup.
  client.readFragment<TData, ArtifactKey<A>>(document, null);

  const atom: FragmentAtom<TData> = Atom.readable((get) => {
    const value = keyOf(get(parent));
    if (value === null || value === undefined) {
      box.current = neutralMeta<TData>(null);
      return AsyncResult.initial<TData, FlammeError>(false);
    }
    const reference = referenceOf(value, artifact.name);
    if (reference === null) {
      box.current = neutralMeta<TData>(null);
      return AsyncResult.fail<FlammeError, TData>(
        new FlammeFragmentError({
          message:
            `"${artifact.name}" was read from a value that carries no \`${artifact.name}\` spread; ` +
            'add `...' +
            artifact.name +
            '` to the parent document or guard the key with `null`',
          fragment: artifact.name,
          parent: parentOf(value),
        }),
      );
    }
    const wrap = (result: QueryResult<TData>): AsyncResult.AsyncResult<TData, FlammeError> => {
      box.current = neutralMeta(result);
      return result.data === null
        ? AsyncResult.initial<TData, FlammeError>(false)
        : AsyncResult.success<TData, FlammeError>(result.data);
    };
    // the immediate first delivery re-reads the entry the call below reads, so the subscription is
    // what makes a later write to the parent record reach this atom
    const off = client.subscribeFragment<TData, ArtifactKey<A>>(document, reference, (result) => {
      get.setSelf(wrap(result));
    });
    get.addFinalizer(off);
    return wrap(client.readFragment<TData, ArtifactKey<A>>(document, reference));
  });

  // reading the meta reads the value first, so one cache subscription serves both
  const meta: Atom.Atom<FlammeAtomMeta> = Atom.readable((get) => {
    get(atom);
    return box.current;
  });

  return { atom, meta };
}
