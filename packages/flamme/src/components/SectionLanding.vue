<script setup lang="ts">
/**
 * A section's landing page: the first spread of the Library, the Blog, the Ledger
 * and the Skills.
 *
 * It says what the section is before the reader is in it: the section's name in
 * the display face, a standfirst, its figures, and one call to action, large and
 * in the accent, that the cursor starts on, so Enter (or a tap) goes on into the
 * section. The right-hand page is the section's own (an index, a chart, a plate).
 * On a phone the two pages stack.
 */
import { RouterLink, type RouteLocationRaw } from "vue-router"

withDefaults(
	defineProps<{
		/** The section's kicker: `the work`, `dispatches`. */
		kicker: string
		title: string
		standfirst: string
		figures: readonly { label: string; value: string }[]
		cta: { label: string; to: RouteLocationRaw; detail?: string }
		/** A second, quieter way on. */
		secondary?: { label: string; to: RouteLocationRaw } | undefined
		/** Whether the screen is a spread, so the aside takes the right-hand page. */
		wide: boolean
		/**
		 * Whether to draw the aside. A page whose aside is too much for a phone's one page
		 * (a chart, a long listing) turns it off there and sets it as a page of its own.
		 */
		aside?: boolean
	}>(),
	{ aside: true, secondary: undefined }
)
</script>

<template>
  <section class="Landing" :class="{ Spread: wide }">
    <div class="LeftPage">
      <p class="Kicker">
        <span class="Mark" aria-hidden="true">§</span> {{ kicker }}
      </p>
      <h2 class="Title display">{{ title }}</h2>
      <p class="Standfirst">{{ standfirst }}</p>
      <dl v-if="figures.length > 0" class="Figures">
        <div v-for="figure of figures" :key="figure.label" class="Figure">
          <dt>{{ figure.label }}</dt>
          <dd class="display">{{ figure.value }}</dd>
        </div>
      </dl>
      <div class="Way">
        <RouterLink
          class="Cta"
          :to="cta.to"
          data-row
          data-cursor-home
          :data-label="cta.label">
          <span class="CtaLabel">{{ cta.label }}</span>
          <span v-if="cta.detail" class="CtaDetail">{{ cta.detail }}</span>
          <span class="CtaArrow" aria-hidden="true">→</span>
        </RouterLink>
        <p class="Hint">
          <RouterLink
            v-if="secondary"
            class="Secondary"
            :to="secondary.to"
            data-row
            :data-label="secondary.label">{{ secondary.label }} →</RouterLink>
          <span class="Keys" aria-hidden="true">
            <span class="Key">↵</span> to go on
            <span class="Dot">·</span>
            <span class="Key">n</span><span class="Key">→</span> to turn the
            page
          </span>
        </p>
      </div>
    </div>
    <div v-if="aside && $slots.default" class="RightPage">
      <slot></slot>
    </div>
  </section>
</template>

<style scoped>
.Landing {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-flow-space-s);
}

/* Two pages with the pager's gutter between them, a page tall at least. */
.Landing.Spread {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: minmax(0, 1fr);
  column-gap: var(--spacing_fluid-column-space-column-s);
  min-height: var(--page-height);
}

.LeftPage,
.RightPage {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-l);
  min-width: 0;
}

.Kicker {
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.Mark {
  color: var(--accent);
}

.Title {
  font-size: var(--typography_fluid-display-font-size-display-xl);
  line-height: 0.98;
  text-wrap: balance;
}

.Standfirst {
  max-width: 34ch;
  padding-bottom: var(--spacing_fluid-tight-space-tight-l);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-xl);
  line-height: 1.4;
  text-wrap: pretty;
}

/* Each figure as wide as it needs ("10 yrs 2 mos" is wider than "4"), the row wrapping. */
.Figures {
  display: flex;
  flex-wrap: wrap;
  column-gap: var(--spacing_fluid-tight-space-tight-l);
  margin: 0;
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
}

.Figure {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.2rem;
  padding: var(--spacing_fluid-tight-space-tight-s)
    var(--spacing_fluid-tight-space-tight-m)
    var(--spacing_fluid-tight-space-tight-m) 0;
}

.Figure dt {
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.Figure dd {
  margin: 0;
  font-size: var(--typography_fluid-display-font-size-display-s);
  line-height: 1.1;
  white-space: nowrap;
}

/* The way on: the one thing on the page meant to be pressed. */
.Way {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-s);
  margin-top: auto;
}

.Cta {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    "label arrow"
    "detail arrow";
  align-items: center;
  column-gap: var(--spacing_fluid-tight-space-tight-l);
  padding: var(--spacing_fluid-tight-space-tight-l)
    var(--spacing_fluid-flow-space-s);
  border: var(--spacing-size-rule) solid var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
  text-decoration: none;
  transition: background 160ms linear, color 160ms linear;
}

.CtaLabel {
  grid-area: label;
  font-size: var(--typography_fluid-content-font-size-l);
  font-weight: var(--typography-weight-body-bold);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.CtaDetail {
  grid-area: detail;
  overflow: hidden;
  font-size: var(--typography_fluid-content-font-size-s);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.CtaArrow {
  grid-area: arrow;
  font-size: var(--typography_fluid-display-font-size-display-s);
  line-height: 1;
  transition: transform 200ms ease;
}

/* Under the cursor (or the mouse, which puts the cursor there), the block inverts. */
.Cta[data-cursor="true"] {
  background: var(--paper);
  box-shadow: none;
  color: var(--accent);
}

.Cta[data-cursor="true"] .CtaArrow {
  transform: translateX(0.3em);
}

.Hint {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-s)
    var(--spacing_fluid-tight-space-tight-l);
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Secondary {
  color: var(--accent);
}

.Key {
  display: inline-block;
  min-width: 1.5em;
  padding: 0 0.3em;
  border: var(--spacing-size-hairline) solid var(--rule);
  border-bottom-width: 2px;
  color: var(--muted);
  line-height: 1.5;
  text-align: center;
}

.Key + .Key {
  margin-left: -1px;
}

.Dot {
  color: var(--faint);
}

@media (max-width: 60rem) {
  .Title {
    font-size: var(--typography_fluid-display-font-size-display-l);
  }

  .Standfirst {
    font-size: var(--typography_fluid-content-font-size-m);
  }

  .Figure dd {
    font-size: var(--typography_fluid-content-font-size-xl);
  }

  .Way {
    margin-top: 0;
  }
}

@media (hover: none) and (pointer: coarse) {
  .Keys {
    display: none;
  }

  .Cta[data-cursor="true"] {
    background: var(--accent);
    color: var(--accent-ink);
  }
}
</style>
