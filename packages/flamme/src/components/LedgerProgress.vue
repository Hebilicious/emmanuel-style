<script setup lang="ts">
/**
 * The ledger's progress bar: the whole career on one line, to jump through.
 *
 * Every screen of the Experience page is a segment: the overview, one per role,
 * the record. A role's segment is as long as the role was (with a floor, so a
 * short one can still be hit), so the bar is a timeline too. The fill runs up to
 * the screen being read, and it is named for the transitions (`ledger-progress`),
 * so it slides along while the page turns rather than jumping when it lands. Each
 * segment is a link to its page (`?page=N`) and a row for the cursor: up from the
 * page reaches it.
 */
import { computed } from "vue"
import { RouterLink } from "vue-router"

export interface Segment {
	readonly id: string
	/** Two characters: `01`, or a mark for the overview and the record. */
	readonly short: string
	readonly label: string
	/** How much of the bar it takes. */
	readonly weight: number
	/** Its page, counted from one, once the pager has laid out. */
	readonly page: number | null
}

const props = defineProps<{
	segments: readonly Segment[]
	/** The page being read, counted from one. */
	current: number
}>()

/** The segment being read: the last one that starts on or before the current page. */
const active = computed(() => {
	let found = 0
	props.segments.forEach((segment, index) => {
		if (segment.page !== null && segment.page <= props.current) found = index
	})
	return found
})

const total = computed(
	() => props.segments.reduce((sum, segment) => sum + segment.weight, 0) || 1
)
const fill = computed(() => {
	const done = props.segments
		.slice(0, active.value + 1)
		.reduce((sum, segment) => sum + segment.weight, 0)
	return `${(done / total.value) * 100}%`
})
const to = (segment: Segment) => ({
	query: {
		page: segment.page !== null && segment.page > 1 ? segment.page : undefined
	}
})
</script>

<template>
  <nav class="Progress" aria-label="The ledger, screen by screen">
    <ol class="Track">
      <li
        v-for="(segment, index) of segments"
        :key="segment.id"
        class="Slot"
        :style="{ flexGrow: segment.weight }">
        <RouterLink
          class="Segment"
          :class="{ Done: index < active, Current: index === active }"
          :to="to(segment)"
          :aria-current='index === active ? "step" : undefined'
          data-row
          :data-label="segment.label">
          <span class="Number">{{ segment.short }}</span>
          <span class="Label">{{ segment.label }}</span>
        </RouterLink>
      </li>
    </ol>
    <span class="Rail" aria-hidden="true">
      <span class="Fill" :style="{ width: fill }"></span>
    </span>
  </nav>
</template>

<style scoped>
.Progress {
  position: relative;
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 0.35rem;
  padding-bottom: var(--spacing_fluid-tight-space-tight-s);
}

.Track {
  display: flex;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.Slot {
  flex-basis: 0;
  min-width: 2.4rem;
}

.Segment {
  display: flex;
  align-items: baseline;
  gap: 0.5em;
  min-width: 0;
  padding: 0.3rem 0.45rem 0.25rem;
  border-top: var(--spacing-size-rule) solid var(--rule);
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.1em;
  text-decoration: none;
  text-transform: uppercase;
  white-space: nowrap;
  transition: color 200ms linear, border-color 200ms linear;
}

.Segment.Done {
  border-top-color: color-mix(in oklab, var(--accent) 45%, var(--rule));
  color: var(--muted);
}

.Segment.Current {
  border-top-color: var(--accent);
  color: var(--ink);
}

.Number {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.Label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.Segment[data-cursor="true"] {
  background: var(--sunk);
  box-shadow: none;
  color: var(--ink);
}

@media (hover: none) and (pointer: coarse) {
  .Segment[data-cursor="true"] {
    background: none;
  }
}

/* The rail under the segments, filled to the screen being read. */
.Rail {
  position: relative;
  display: block;
  height: 3px;
  background: var(--rule);
}

.Fill {
  view-transition-name: ledger-progress;
  position: absolute;
  inset-block: 0;
  left: 0;
  background: var(--accent);
  box-shadow: 0 0 0.6rem color-mix(in oklab, var(--accent) 50%, transparent);
  transition: width 420ms cubic-bezier(0.22, 0.6, 0.36, 1);
}

/* A phone has room for the numbers, not the names. */
@media (max-width: 40rem) {
  .Label {
    display: none;
  }

  .Slot {
    min-width: 1.8rem;
  }
}
</style>
