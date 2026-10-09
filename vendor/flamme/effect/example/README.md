# The `@flamme/effect` example

A small Vue app that is written the way an Effect v4 app is written, with Flamme slotted in: atoms
for state, `AsyncResult` for loading, a mutation atom for the action, and a local-first queue behind
it. It runs with no server: its endpoint is a fixture transport in `src/fixture.ts`.

```bash
# from packages/effect
pnpm exec vite --config example/vite.config.ts example   # dev server
moon run effect:build-example                            # the production bundle
```

| File                             | What it shows                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/graphql.ts`                 | The three documents in the shape the Flamme compiler emits. A real app imports the generated `graphql/` tree.     |
| `src/fixture.ts`                 | The `TransportFn`: an in-memory `SpeciesList`/`ToggleFavorite` endpoint with `setOnline` and `setFailing`.        |
| `src/app.ts`                     | The layer, the atom client, the local-first store, the row-key/card families, and the queue-status atom.          |
| `src/App.vue`                    | The query atom, the sync banner, the list.                                                                        |
| `src/components/SpeciesCard.vue` | The fragment atom (`SpeciesCard$key` in, `SpeciesCard$data` out) and the mutation atom with the optimistic write. |
| `src/main.ts`                    | The browser entry.                                                                                                |

## What it demonstrates

- **A query atom.** `app.list` is `AsyncResult<SpeciesList$data, FlammeError>`; the template switches
  on `AsyncResult.isWaiting`/`isFailure` and reads `.value`. It reads the cache the client holds, so
  a router loader that fetched the same document would cost nothing here.
- **A fragment atom.** The list hands each card its row **id**, not the row:
  `app.cardOf(id)` reads `fragment SpeciesCard on Species { id favorite }` through the ` $fragments`
  key the list's masked value carries. The card cannot read `name`, and the list cannot read
  `favorite`; both read the same cache record.
- **A mutation atom.** The button writes `{ variables, optimistic }` and the atom's value is the run's
  `AsyncResult`: `{ status: 'confirmed' }` or `{ status: 'queued' }`, or a `FlammeParkedError`.
- **One offline write.** Take the fixture offline and press the button: the optimistic value is in the
  cache immediately (the star flips), the write is queued, the banner counts it, and when the fixture
  comes back the queue drains and the server's own payload is what the atoms show.

## Tests

`packages/effect/test/example/app.test.ts` mounts this app (jsdom) and drives all four flows; it runs
with the package's own suite:

```bash
# from packages/effect
pnpm exec vitest run --root ../.. --project effect test/example
```

## Note on dependencies

The example imports `@flamme/local` for the queue and `@vitejs/plugin-vue` for the Vite config. Both
resolve through the workspace (`tsconfig.json` paths for the typechecker, `vite.config.ts` aliases for
the bundler, the root `vitest.config.ts` aliases for the tests). When `packages/effect/package.json`
is next touched, they belong in its `devDependencies` as `workspace:*` / a pinned plugin version.
