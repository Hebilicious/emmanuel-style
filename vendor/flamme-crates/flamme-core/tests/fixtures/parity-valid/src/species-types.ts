/**
 * Types derived from the generated `Info` artifact, named once so the page and its panels agree.
 *
 * `Info$result['species']` is the union `loaded | loadingFrame | null`; `LoadedBranchOf` removes the
 * frame and `NonNullable` removes `null`, which is exactly the shape a panel can read
 * (`spec/spec.md` §8.3, §8.9).
 */
import type { Info$result, LoadedBranchOf } from '$flamme';

/** The loaded form of `Info.species`. */
export type InfoSpecies = NonNullable<LoadedBranchOf<Info$result['species']>>;

/**
 * One loaded evolution-chain entry, as `...SpeciesPreview` sees it.
 *
 * The chain lives in a deferred inline fragment (`@defer(label: "evolutionChain")`), so the field is
 * optional in the generated type until the patch lands; `NonNullable` names the entry the boundary
 * renders once `Deferred` says the label is ready.
 */
export type EvolutionForm = NonNullable<InfoSpecies['evolution_chain']>[number];

/**
 * One loaded move node, as the `MoveDisplay` fragment selects it.
 *
 * `SpeciesMove` is an **embedded** type (no key field: the example's
 * `types: { SpeciesMove: { keys: ['name'] } }` is a verified no-op because the type has no `name`
 * field), so the compiler cannot emit a ` $fragments` reference for it and `useFragment` cannot be
 * used on this node. `Info` therefore selects the move fields itself alongside the `...MoveDisplay`
 * spread, and this alias names that shape. See `research/slice7-report.md`.
 */
export type MoveEntry = NonNullable<InfoSpecies['moves']['edges'][number]['node']>;

/** The evolution chain keeps this many slots; the rest render as placeholders (behaviour 3). */
export const EVOLUTION_SLOTS = 3;
