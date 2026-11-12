<script setup lang="ts">
/**
 * The Library's index: what it holds, shelf by shelf, with the page each opens on.
 *
 * Each row is a link to that page (`?page=N`), so the index is a real table of
 * contents: the pager follows the address and turns there. On the front page of a
 * spread it is boxed, the way a paper boxes what is inside the issue.
 */
import { RouterLink } from "vue-router"

defineProps<{
	shelves: readonly { slug: string; label: string; count: number }[]
	/** The page a shelf opens on, counted from one, once the pager has laid out. */
	pageOf: (slug: string) => number | null
	projects: number
	merged: number
	boxed?: boolean
}>()
</script>

<template>
  <nav class="Index" :class="{ Boxed: boxed }" aria-label="The shelves">
    <p v-if="boxed" class="Title">
      <span class="Mark" aria-hidden="true">§</span> Inside
    </p>
    <p class="Standfirst">
      {{ projects }} projects, and {{ merged }} pull requests merged into other
      people's.
    </p>
    <ol class="Shelves">
      <li v-for="(shelf, index) of shelves" :key="shelf.slug">
        <RouterLink
          class="Row"
          :to="{ query: { page: pageOf(shelf.slug) ?? undefined } }"
          data-row
          :data-label="`${shelf.label} shelf`">
          <span class="Number">{{ String(index + 1).padStart(2, "0") }}</span>
          <span class="Name">{{ shelf.label }}</span>
          <span class="Leader" aria-hidden="true"></span>
          <span class="Count">{{ shelf.count }}</span>
          <span class="At">{{
            pageOf(shelf.slug) ? `p. ${pageOf(shelf.slug)}` : ""
          }}</span>
        </RouterLink>
      </li>
    </ol>
  </nav>
</template>

<style scoped>
.Index {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-s);
  min-height: 0;
}

.Boxed {
  padding: var(--spacing_fluid-tight-space-tight-s)
    var(--spacing_fluid-tight-space-tight-m);
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background: var(--surface);
}

.Title {
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.Mark {
  color: var(--accent);
}

.Standfirst {
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-s);
  line-height: 1.45;
  text-wrap: balance;
}

.Shelves {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.Row {
  display: flex;
  align-items: baseline;
  gap: 0.6em;
  padding-block: 0.22rem;
  color: var(--ink);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.08em;
  text-decoration: none;
  text-transform: uppercase;
}

.Number,
.At {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

/* Not `.Page`: that is the reading pane's class, and the global rule reaches here. */
.At {
  min-width: 4ch;
  text-align: right;
}

.Leader {
  flex: 1 1 auto;
  min-width: 1rem;
  border-bottom: var(--spacing-size-hairline) dotted var(--rule-strong);
}

.Count {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.Row[data-cursor="true"] {
  box-shadow:
    inset var(--spacing-size-rule) 0 0 0 var(--accent),
    0 0 0 0.25rem var(--sunk);
}
</style>
