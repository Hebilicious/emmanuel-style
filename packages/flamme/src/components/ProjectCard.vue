<script setup lang="ts">
/**
 * One project, as the Library shows it: its cover, its number, its name and one
 * line, set like a story on a front page.
 *
 * Three sizes. `lead` is the story the Library opens with, across most of a page,
 * with the first paragraph of its text; `feature` is one of the stories beside it;
 * `card` is an entry on a shelf. The whole card is the link to the project's page,
 * and a row for the cursor.
 */
import { computed } from "vue"
import { RouterLink } from "vue-router"
import Cover from "./Cover.vue"

export interface CardProject {
	readonly name: string
	readonly title: string
	readonly tagline: string
	readonly kind: string
	readonly language: string
	readonly homepage: string | null
	readonly archived: boolean
	readonly started: number
	readonly ended: number | null
	readonly contributions: number | null
	readonly activity: readonly string[]
	readonly cover: string
	readonly body?: readonly string[]
}

const props = withDefaults(
	defineProps<{
		project: CardProject
		number: number
		stars?: number | null
		size?: "lead" | "feature" | "card"
		/** The shelf's name, printed in the kicker on the front page. */
		shelf?: string
		/**
		 * Whether the card fills the height it is given, its plate taking whatever the
		 * text leaves, rather than drawing the plate at its own proportions. The front
		 * page is composed to the height of the page this way.
		 */
		fill?: boolean
	}>(),
	{ stars: null, size: "card", shelf: "", fill: false }
)

const years = computed(() => {
	const { started, ended } = props.project
	if (ended === null) return `since ${started}`
	return started === ended ? String(started) : `${started}–${ended}`
})

const outside = computed(() => props.project.kind !== "project")
const ratio = computed(() =>
	props.size === "lead" ? 16 / 8.2 : props.size === "feature" ? 16 / 7 : 16 / 6
)
const compact = (count: number) =>
	count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
</script>

<template>
  <RouterLink
    :to="`/library/${project.name}`"
    class="Card"
    :class="[size, { Fill: fill }]"
    data-row
    :data-label="project.title">
    <div
      class="Plate"
      :style="fill ? undefined : { aspectRatio: String(ratio) }">
      <Cover
        :motif="project.cover"
        :seed="project.name"
        :activity="project.activity"
        :count="project.contributions"
        :ratio
      />
    </div>
    <p class="Kicker">
      <span class="Number">No.&nbsp;{{ String(number).padStart(2, "0") }}</span>
      <span v-if="shelf" class="Shelf">{{ shelf }}</span>
      <span>{{ project.language }}</span>
      <span>{{ years }}</span>
    </p>
    <h3 class="Title" :class='size === "card" ? "Mono" : "display"'>
      {{ project.title }}
    </h3>
    <p class="Tagline">{{ project.tagline }}</p>
    <p v-if='size === "lead" && project.body?.[0]' class="Body">
      {{ project.body[0] }}
    </p>
    <p class="Meta">
      <span v-if="outside && project.contributions !== null">{{
          project.contributions
        }} merged pull request{{
          project.contributions === 1 ? "" : "s"
        }}</span>
      <span v-else-if="stars !== null && stars > 0" class="Stars">★ {{
          compact(stars)
        }}</span>
      <span v-if="project.archived" class="Archived">archived</span>
      <span v-if="project.homepage" class="Site">site</span>
      <span class="Read" aria-hidden="true">read →</span>
    </p>
  </RouterLink>
</template>

<style scoped>
.Card {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  min-width: 0;
  padding-top: var(--spacing_fluid-tight-space-tight-s);
  border-top: var(--spacing-size-hairline) solid var(--rule-strong);
  color: var(--ink);
  text-decoration: none;
}

.Plate {
  overflow: hidden;
  border: var(--spacing-size-hairline) solid var(--rule);
  background: var(--sunk);
  transition: border-color 160ms linear;
}

/* One line, always: on a narrow card the facts are cut rather than wrapped. */
.Kicker {
  display: flex;
  gap: 0 0.9em;
  overflow: hidden;
  white-space: nowrap;
  margin-top: 0.2rem;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Number {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.Shelf {
  color: var(--ink);
}

.Title {
  margin: 0;
  line-height: 1.08;
  text-wrap: balance;
}

.Title.display {
  font-size: var(--typography_fluid-display-font-size-display-s);
}

.Title.Mono {
  font-size: var(--typography_fluid-content-font-size-m);
  font-weight: var(--typography-weight-body-bold);
  letter-spacing: 0.02em;
}

.Tagline {
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-s);
  line-height: 1.45;
  text-wrap: pretty;
}

.Body {
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-s);
  line-height: 1.55;
  text-wrap: pretty;
}

.Meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 0.9em;
  margin-top: auto;
  padding-top: 0.15rem;
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.Stars {
  color: var(--accent);
}

.Archived {
  color: var(--tertiary);
}

.Read {
  margin-left: auto;
  color: var(--faint);
  transition: color 160ms linear;
}

/* Filling its cell: the plate takes the height the text leaves. */
.Fill {
  height: 100%;
  min-height: 0;
}

/*
 * The drawing is taken out of the flow: drawn in the flow, it asks for its own
 * proportions, and the grid gives every cell that much before sharing the rest.
 */
.Fill .Plate {
  position: relative;
  flex: 1 1 0;
  min-height: 4.5rem;
}

.Fill .Plate > :deep(svg) {
  position: absolute;
  inset: 0;
}

.Fill .Meta {
  margin-top: 0;
}

/* The lead story: the largest plate and headline on the page. */
.lead {
  gap: var(--spacing_fluid-tight-space-tight-s);
  border-top-width: var(--spacing-size-rule);
}

.lead .Title {
  font-size: var(--typography_fluid-display-font-size-display-m);
}

.lead .Tagline {
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-m);
}

.lead .Body {
  color: var(--muted);
}

/*
 * The cursor on a card lights it as a whole: the plate's frame and the headline go
 * to the accent, and the wash the cursor draws elsewhere sits behind it. The mouse
 * draws the same, because hovering puts the cursor there.
 */
@media (hover: hover), (pointer: fine) {
  .Card[data-cursor="true"] {
    background: var(--sunk);
    box-shadow: 0 0 0 0.45rem var(--sunk);
  }

  .Card[data-cursor="true"] .Plate {
    border-color: var(--accent);
  }

  .Card[data-cursor="true"] .Title {
    color: var(--accent);
  }

  .Card[data-cursor="true"] .Title.display {
    font-palette: var(--nabla-accent);
  }

  .Card[data-cursor="true"] .Read {
    color: var(--accent);
  }
}

/* A phone has no cursor to draw (see `global.css`). */
@media (hover: none) and (pointer: coarse) {
  .Card[data-cursor="true"] {
    background: none;
    box-shadow: none;
  }
}
</style>
