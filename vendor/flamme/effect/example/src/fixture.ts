/**
 * The fixture transport: a tiny in-memory GraphQL server for the three documents, with a switch for
 * "the device is offline" and one for "the endpoint is failing".
 *
 * `@flamme/effect` (and this app) never cares which transport answers: `flammeLayer({ transport })`
 * takes any `TransportFn`. The two switches are what the app's local-first story needs, though:
 *
 * - `setOnline(false)` makes the queue's `online` source report false, so a mutation is queued
 *   without a request at all;
 * - `setFailing(true)` keeps the platform "online" while the endpoint rejects, which is the case
 *   the queue retries and parks.
 */
import { NetworkError } from '@flamme/runtime';
import type { TransportFn, TransportRequest, TransportResponse } from '@flamme/runtime';

/** One species, as the fixture stores it. */
export interface FixtureSpecies {
  readonly id: number;
  readonly name: string;
  favorite: boolean;
}

/** The fixture server: its transport, its data, and the two switches. */
export interface FixtureServer {
  readonly transport: TransportFn;
  /** Every operation the transport was asked for, in order. */
  readonly calls: string[];
  /** The species the fixture holds, by id. */
  readonly species: Map<number, FixtureSpecies>;
  /** What the queue's `online` source answers. */
  readonly online: () => boolean;
  setOnline(online: boolean): void;
  setFailing(failing: boolean): void;
  /** The current favourite of one species, or `undefined`. */
  favoriteOf(id: number): boolean | undefined;
}

/** The three species the example app starts with. */
export const SEED: readonly FixtureSpecies[] = [
  { id: 1, name: 'Bulbasaur', favorite: true },
  { id: 2, name: 'Charmander', favorite: false },
  { id: 3, name: 'Squirtle', favorite: false },
];

/** Builds the fixture server. */
export function createFixtureServer(seed: readonly FixtureSpecies[] = SEED): FixtureServer {
  const species = new Map(seed.map((entry) => [entry.id, { ...entry }]));
  const calls: string[] = [];
  const state = { online: true, failing: false };

  const answer = (request: TransportRequest): TransportResponse => {
    if (request.operationName === 'SpeciesList') {
      return {
        data: {
          species: [...species.values()].map((entry) => ({
            __typename: 'Species',
            id: entry.id,
            name: entry.name,
            favorite: entry.favorite,
          })),
        },
      };
    }
    if (request.operationName === 'ToggleFavorite') {
      const id = Number(request.variables['id']);
      const entry = species.get(id);
      if (entry === undefined) {
        return { data: null, errors: [{ message: `No species with id ${String(id)}.` }] };
      }
      entry.favorite = !entry.favorite;
      return {
        data: { toggleFavorite: { __typename: 'Species', id: entry.id, favorite: entry.favorite } },
      };
    }
    return { data: null, errors: [{ message: `Unknown operation ${request.operationName}.` }] };
  };

  const transport: TransportFn = (request) => {
    calls.push(request.operationName);
    if (state.failing) {
      return Promise.reject(new NetworkError('The fixture endpoint is not answering.'));
    }
    return Promise.resolve(answer(request));
  };

  return {
    transport,
    calls,
    species,
    online: () => state.online && !state.failing,
    setOnline(online) {
      state.online = online;
    },
    setFailing(failing) {
      state.failing = failing;
    },
    favoriteOf: (id) => species.get(id)?.favorite,
  };
}
