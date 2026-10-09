<script lang="ts">
/**
 * The move stats row (`MoveDisplay.tsx` in the example).
 *
 * The `MoveDisplay` fragment is declared here, next to the component that renders it, and is spread
 * by the `Info` query as `...MoveDisplay` (so the fragment graph is the example's). `Info` also
 * selects the same fields directly, which the example does not need: `SpeciesMove` is an **embedded**
 * type (no key field, so the compiler emits no ` $fragments` reference for the node and
 * `useFragment` cannot read it — `packages/core/src/emit.ts` drops refs below an embedded composite
 * and `packages/runtime/src/cache/write.ts` inlines the node), and `@mask_disable` cannot be used to
 * inline the fragment instead because the compiler leaves that directive in the printed `raw`, which
 * a real GraphQL server rejects. Selecting the fields in the parent is the remaining way to keep both
 * the fragment graph and a valid document. See `research/slice7-report.md` for the blocker entries.
 *
 * The document is exported so the `graphql()` tag is a real use site and not dead code.
 */
import { graphql } from '$flamme';

export const MoveDisplayFragment = graphql(`
	fragment MoveDisplay on SpeciesMove @loading {
		learned_at
		method
		move {
			name
			accuracy
			power
			pp
			type
		}
	}
`);
</script>

<script setup lang="ts">
import type { MoveEntry } from '../species-types.js';

defineProps<{ readonly move: MoveEntry }>();
</script>

<template>
  <div class="move" data-testid="move">
    <h3 class="move-name" data-testid="move-name">{{ move.move.name }}</h3>
    <dl class="move-stats">
      <dt>method</dt>
      <dd data-testid="move-method">{{ move.method }} at {{ move.learned_at }}</dd>
      <dt>type</dt>
      <dd data-testid="move-type">{{ move.move.type ?? '—' }}</dd>
      <dt>power</dt>
      <dd data-testid="move-power">{{ move.move.power ?? '—' }}</dd>
      <dt>accuracy</dt>
      <dd data-testid="move-accuracy">{{ move.move.accuracy ?? '—' }}</dd>
      <dt>pp</dt>
      <dd data-testid="move-pp">{{ move.move.pp }}</dd>
    </dl>
  </div>
</template>

<style scoped>
.move-stats {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.75rem;
  margin: 0;
}
.move-stats dt {
  opacity: 0.6;
}
.move-stats dd {
  margin: 0;
}
</style>
