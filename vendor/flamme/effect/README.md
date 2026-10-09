# @flamme/effect

The Effect v4 seam for [Flamme](../../README.md), in two directions:

- **Effect → Flamme**: the client as a `Context.Service` provided by a `Layer`, queries and mutations
  as `Effect`s with the runtime's error taxonomy as tagged errors, subscriptions and incremental
  responses as scoped `Stream`s, and the local-first queue behind `mutate`.
- **Flamme → Effect**: query, fragment, mutation and subscription atoms over the same client
  (`@flamme/effect/vue`), whose values are the natural Effect shapes: `AsyncResult` for anything that
  loads, `AtomResultFn` for a mutation.

`effect` is a peer dependency. This package adds nothing to `@flamme/runtime`, and nothing to
`@flamme/local`: the queue enters through one interface that package's store satisfies structurally.

The full page is [apps/docs/content/effect.md](../../apps/docs/content/effect.md), and the worked app is
[`example/`](./example).

## A query, as an Effect

```ts
import { Effect } from 'effect';
import { Flamme, flammeLayer, query } from '@flamme/effect';
import { SpeciesList } from './graphql/SpeciesList.js'; // a generated artifact

const program = Effect.gen(function* () {
  const flamme = yield* Flamme; // { client, queue, query, mutate, prefetch, subscribe, incremental }
  const result = yield* query(SpeciesList);
  return result.data; // QueryResult<SpeciesList$data>['data']
});

const data = await Effect.runPromise(
  program.pipe(Effect.provide(flammeLayer({ url: '/graphql' }))),
);
```

## A mutation, with the local-first queue

```ts
import { buildClient, clientLayer, mutate } from '@flamme/effect';
import { createLocalFirst, memoryAdapter } from '@flamme/local';
import { ToggleFavorite } from './graphql/ToggleFavorite.js';

const client = buildClient({ url: '/graphql' });
const local = createLocalFirst({ client, adapter: memoryAdapter() });
await local.restore();

const toggle = mutate(ToggleFavorite, {
  variables: { id: 1 },
  optimistic: { toggleFavorite: { __typename: 'Species', id: 1, favorite: true } },
}).pipe(Effect.provide(clientLayer(client, { local })));
// => { status: 'confirmed', data } once the server took it
// => { status: 'queued', id }      while the queue owns it (offline, or a retryable failure)
// => FlammeParkedError             when the server rejected it with a GraphQL error
```

## The same documents, as atoms

```ts
import { createFlammeAtoms, flammeAtomsPlugin } from '@flamme/effect/vue';
import { flammeLayer } from '@flamme/effect';

const atoms = createFlammeAtoms(flammeLayer({ url: '/graphql' }));
app.use(flammeAtomsPlugin(atoms));
```

```vue
<script setup lang="ts">
import { useAtom, useAtomValue } from '@effect/atom-vue';

const list = useAtomValue(() => atoms.query(SpeciesList)); // AsyncResult<SpeciesList$data, FlammeError>
const card = useAtomValue(() => atoms.fragment(SpeciesCard, keyOf(id))); // AsyncResult<SpeciesCard$data, …>
const [outcome, toggle] = useAtom(() => atoms.mutate(ToggleFavorite), { mode: 'promise' });
</script>
```

- the value carries the loading state (`Initial`/`Success`/`Failure`, `AsyncResult.isWaiting`), and the
  Flamme-only signals live in `atoms.meta(atom)`;
- a fragment atom takes the generated `$key` and yields the fragment's `$data`, so masking holds in
  both directions;
- every atom reads the normalized cache and re-renders on a write to a record it read, so a mutation
  atom's optimistic write shows up without an invalidation key.

## Errors

`FlammeTransportError`, `FlammeHttpError`, `FlammeGraphQLHttpError`, `FlammeGraphQLError`,
`FlammeCacheMissError`, `FlammeDisposedError`, `FlammeSubscriptionError`, `FlammeParkedError`,
`FlammeFragmentError`, `FlammeRuntimeFailure` and `FlammeUnknownError`: all `Data.TaggedError`s, all
selectable with `Effect.catchTag`, all documented in
[apps/docs/content/effect.md](../../apps/docs/content/effect.md).

## Server

```ts
import { makeRuntime } from '@flamme/effect';

const runtime = makeRuntime({ url: 'https://api.example/graphql', headers: { authorization } });
try {
  return await runtime.runPromise(query(SpeciesList));
} finally {
  await runtime.dispose(); // the client owns the cache: one runtime per request
}
```
