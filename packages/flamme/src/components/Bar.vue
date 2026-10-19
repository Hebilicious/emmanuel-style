<script setup lang="ts">
/**
 * The bar: the dateline, the nameplate and the sections, on one row.
 *
 * It is a newspaper's masthead folded into a terminal's title bar. The nameplate
 * is the section's own (`The Blog`, `Library`), set in the display face and
 * centred on the screen: the row is a three-track grid whose outer tracks are
 * equal, so the plate is centred whatever flanks it, rather than centred between
 * a long date on one side and a short set of links on the other.
 *
 * Below the tablet breakpoint the bar becomes a masthead of three short rows: the
 * dateline and the theme switch, the plate, then the sections. That and the
 * pager's single column are the only layout changes the site makes.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { RouterLink, useRoute } from "vue-router"
import { SECTIONS, sectionOf } from "../shell/sections.js"
import ThemeSwitch from "./ThemeSwitch.vue"

const route = useRoute()
const section = computed(() => sectionOf(route.path))

/** Written on the client, so it is today's date wherever the page is read. */
const now = ref<Date | null>(null)
let timer = 0
onMounted(() => {
	now.value = new Date()
	// A tab left open past midnight should not keep yesterday's paper.
	timer = window.setInterval(() => (now.value = new Date()), 60_000)
})
onBeforeUnmount(() => window.clearInterval(timer))

const longDate = computed(() =>
	now.value === null
		? ""
		: new Intl.DateTimeFormat("en-GB", {
				weekday: "long",
				day: "numeric",
				month: "long",
				year: "numeric"
			}).format(now.value)
)
const shortDate = computed(() =>
	now.value === null
		? ""
		: new Intl.DateTimeFormat("en-GB", {
				weekday: "short",
				day: "numeric",
				month: "short",
				year: "numeric"
			}).format(now.value)
)
</script>

<template>
  <header class="Bar">
    <p class="Dateline">
      <time
        v-if="now"
        class="Long"
        :datetime="now.toISOString().slice(0, 10)">{{ longDate }}</time>
      <time
        v-if="now"
        class="Short"
        :datetime="now.toISOString().slice(0, 10)">{{ shortDate }}</time>
      <span class="Dot" aria-hidden="true">·</span>
      <span>earth</span>
    </p>

    <h1 class="Plate display">{{ section.plate }}</h1>

    <div class="End">
      <nav class="Sections" aria-label="Sections">
        <RouterLink
          v-for="item of SECTIONS"
          :key="item.href"
          :to="item.href"
          class="Section"
          :class="{ Active: item.label === section.label }"
          :aria-current='item.label === section.label ? "page" : undefined'
          :aria-keyshortcuts="`g ${item.key}`">
          <span
            v-if="item.label === section.label"
            class="Bracket"
            aria-hidden="true">[</span><span class="Name">{{
            item.label
          }}</span><span
            v-if="item.label === section.label"
            class="Bracket"
            aria-hidden="true">]</span><sup class="Keys" aria-hidden="true">{{
            item.key
          }}</sup><span
            v-if="item.label === section.label"
            class="Underline"
            aria-hidden="true"></span>
        </RouterLink>
      </nav>
      <p class="Folio">
        <span class="Mark" aria-hidden="true">§</span>
        {{ section.dateline }}
      </p>
      <ThemeSwitch />
    </div>
  </header>
</template>

<style scoped>
.Bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  column-gap: var(--spacing_fluid-tight-space-tight-xl);
  padding-block: var(--spacing_fluid-tight-space-tight-m)
    var(--spacing_fluid-tight-space-tight-s);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.Dateline {
  display: flex;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  min-width: 0;
  color: var(--muted);
  white-space: nowrap;
}

.Dateline .Short {
  display: none;
}

.Dot {
  color: var(--faint);
}

/*
 * The nameplate. Nabla's colour layers sit above and below the line box, so the
 * plate keeps some leading of its own: with the bar's `line-height` the tops of
 * the letters were cut off by the row above.
 */
.Plate {
  /* Its own group in a turn, so the masthead changes while the leaves do (`turns.css`). */
  view-transition-name: plate;
  margin: 0;
  padding-block: 0.08em 0.02em;
  font-size: var(--typography_fluid-display-font-size-display-s);
  line-height: 1.12;
  text-align: center;
  text-transform: uppercase;
  white-space: nowrap;
}

.End {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--spacing_fluid-tight-space-tight-l);
  min-width: 0;
}

.Sections {
  display: flex;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-l);
}

.Section {
  position: relative;
  display: inline-flex;
  align-items: baseline;
  color: var(--muted);
  white-space: nowrap;
  transition: color 120ms linear;
}

/*
 * A rule under the current section. It is one element under whichever link is
 * current, named for the transitions, so a turn to another section slides it there.
 */
.Underline {
  view-transition-name: section-mark;
  position: absolute;
  inset-inline: 0;
  bottom: -0.3em;
  height: var(--spacing-size-rule);
  background: var(--accent);
}

/* The brackets mark the current section, the way a shell marks the current item. */
.Bracket {
  color: var(--accent);
}

.Active {
  color: var(--accent);
  font-weight: var(--typography-weight-body-bold);
}

/* The shortcut, raised beside the label so it costs no line height. */
.Keys {
  margin-left: 0.2em;
  color: var(--faint);
  font-size: 0.66em;
  line-height: 0;
  vertical-align: 0;
  transform: translateY(-0.55em);
  display: inline-block;
}

.Active .Keys {
  color: var(--accent);
}

:global(.mouse-enabled) .Section:hover {
  color: var(--ink);
}

:global(.mouse-enabled) .Section:hover .Keys {
  color: var(--accent);
}

.Folio {
  display: flex;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  color: var(--muted);
  white-space: nowrap;
}

.Mark {
  color: var(--accent);
}

/* The folio repeats what the bracketed link already says, so it goes first when room runs out. */
@media (max-width: 100rem) {
  .Folio {
    display: none;
  }
}

@media (max-width: 80rem) {
  .Dateline .Long {
    display: none;
  }

  .Dateline .Short {
    display: inline;
  }
}

/*
 * Where one row cannot hold everything (a laptop, a tablet, a phone on its side),
 * the bar takes two: the dateline, the plate and the switch on the first, still
 * centred on the screen, and the sections across the second. A phone on its side
 * is short rather than narrow, so the height counts too: three rows there left a
 * page of a few lines.
 */
@media (max-width: 84rem), (max-height: 32rem) {
  .Bar {
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    grid-template-areas:
      "dateline plate switch"
      "sections sections sections";
    row-gap: 0.15rem;
    padding-block: var(--spacing_fluid-tight-space-tight-s) 0.15rem;
  }

  .Dateline {
    grid-area: dateline;
  }

  .Plate {
    grid-area: plate;
  }

  .End {
    display: contents;
  }

  .End > :deep(.Switch) {
    grid-area: switch;
    justify-self: end;
  }

  .Folio {
    display: none;
  }

  .Sections {
    grid-area: sections;
    justify-content: center;
    gap: var(--spacing_fluid-tight-space-tight-xl);
  }

  .Section {
    padding-block: 0.3rem;
  }
}

@media (max-height: 32rem) {
  .Plate {
    font-size: var(--typography_fluid-display-font-size-display-s);
  }
}

/*
 * A phone held upright: a masthead of three short rows. The dateline and the
 * switch share the top row, the plate takes the middle, and the sections are
 * spread across the bottom so each is an easy target for a thumb.
 */
@media (max-width: 40rem) and (min-height: 32rem) {
  .Bar {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "dateline switch"
      "plate plate"
      "sections sections";
    row-gap: var(--spacing_fluid-tight-space-tight-xs);
    padding-block: var(--spacing_fluid-tight-space-tight-s)
      var(--spacing_fluid-tight-space-tight-xs);
  }

  .Dateline {
    font-size: var(--typography_fluid-micro-font-size-micro-s);
  }

  .Plate {
    font-size: clamp(1.35rem, 6.4vw, 2.2rem);
  }

  .Sections {
    justify-content: space-between;
    gap: 0;
    padding-top: var(--spacing_fluid-tight-space-tight-xs);
  }

  .Section {
    padding-block: 0.35rem;
  }
}
</style>
