<script setup lang="ts">
/**
 * The furniture of the sheet: what a printer leaves in the margins.
 *
 * The page is set inside a sheet that is a little larger, and the margin carries
 * what a proof carries: crop marks at the corners of the page, a control strip of
 * the edition's inks down one side, the running line down the other, and, at each
 * outer edge, the pages of the section stacked up: the ones read on the left, the
 * ones to come on the right, so the thickness of each pile says how far in the
 * reader is.
 *
 * It is all decoration: hidden from assistive technology, never in the way of a
 * click, and left out where the margin is too narrow to hold it (a phone).
 */
import { computed } from "vue"
import { useRoute } from "vue-router"
import { sectionOf } from "../shell/sections.js"
import { useShell } from "../shell/shell.js"

const shell = useShell()
const route = useRoute()

/** The most page edges a pile draws; a long section is not a wall of lines. */
const MOST = 9

const read = computed(() => Math.min(MOST, (shell.position?.current ?? 1) - 1))
const left = computed(() =>
	Math.min(MOST, (shell.position?.total ?? 1) - (shell.position?.current ?? 1))
)

const two = (value: number) => String(value).padStart(2, "0")
const running = computed(() => {
	const position = shell.position
	const sheet =
		position === null
			? ""
			: ` · sheet ${two(position.current)} of ${two(position.total)}`
	return `emmanuel.style · earth edition · ${sectionOf(route.path).dateline}${sheet}`
})

const INKS = [
	"accent",
	"ink",
	"muted",
	"faint",
	"rule-strong",
	"tertiary"
] as const
</script>

<template>
  <div class="Furniture" aria-hidden="true">
    <span class="Crop TopLeft"></span>
    <span class="Crop TopRight"></span>
    <span class="Crop BottomLeft"></span>
    <span class="Crop BottomRight"></span>

    <span class="Pile Read" :style='{ "--edges": read }'></span>
    <span class="Pile Ahead" :style='{ "--edges": left }'></span>

    <span class="Strip">
      <span
        v-for="ink of INKS"
        :key="ink"
        class="Patch"
        :style="{ background: `var(--${ink})` }"></span>
      <span class="Target"></span>
    </span>

    <span class="Running">{{ running }}</span>
  </div>
</template>

<style scoped>
.Furniture {
  --margin: var(--spacing_fluid-gutter-space-gutter-s);
  position: absolute;
  inset-block: 0;
  inset-inline: calc(var(--margin) * -1);
  pointer-events: none;
  color: var(--faint);
}

/* A crop mark: two hairlines that stop short of the corner of the page they mark. */
.Crop {
  position: absolute;
  width: calc(var(--margin) * 0.22);
  height: calc(var(--margin) * 0.22);
}

.Crop::before,
.Crop::after {
  content: "";
  position: absolute;
  background: var(--rule-strong);
}

.Crop::before {
  width: 100%;
  height: var(--spacing-size-hairline);
}

.Crop::after {
  width: var(--spacing-size-hairline);
  height: 100%;
}

.TopLeft {
  top: var(--spacing_fluid-tight-space-tight-m);
  left: calc(var(--margin) * 0.28);
}

.TopLeft::before {
  bottom: 0;
}

.TopLeft::after {
  right: 0;
}

.TopRight {
  top: var(--spacing_fluid-tight-space-tight-m);
  right: calc(var(--margin) * 0.28);
}

.TopRight::before {
  bottom: 0;
}

.BottomLeft {
  bottom: var(--spacing_fluid-tight-space-tight-s);
  left: calc(var(--margin) * 0.28);
}

.BottomLeft::after {
  right: 0;
}

.BottomRight {
  bottom: var(--spacing_fluid-tight-space-tight-s);
  right: calc(var(--margin) * 0.28);
}

/*
 * The piles: one hairline per page, three pixels apart, against the outer edge of
 * the page. Each grows and shrinks as the pages turn from one to the other.
 */
.Pile {
  position: absolute;
  inset-block: calc(var(--spacing_fluid-flow-space-xs) + 0.6rem)
    calc(var(--spacing_fluid-tight-space-tight-l) + 0.6rem);
  width: calc(var(--edges) * 3px);
  background: repeating-linear-gradient(
    to right,
    var(--rule-strong) 0 1px,
    transparent 1px 3px
  );
  transition: width 500ms cubic-bezier(0.22, 0.6, 0.36, 1);
}

.Pile.Read {
  right: calc(100% - var(--margin) + 5px);
}

.Pile.Ahead {
  left: calc(100% - var(--margin) + 5px);
}

/* The control strip: a patch of each ink, and a registration target under them. */
.Strip {
  position: absolute;
  top: 50%;
  left: calc(var(--margin) * 0.22);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  transform: translateY(-50%);
}

.Patch {
  width: 0.45rem;
  height: 0.45rem;
}

.Target {
  position: relative;
  width: 0.8rem;
  height: 0.8rem;
  margin-top: 0.5rem;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  border-radius: 50%;
}

.Target::before,
.Target::after {
  content: "";
  position: absolute;
  background: var(--rule-strong);
}

.Target::before {
  inset-inline: -0.25rem;
  top: 50%;
  height: var(--spacing-size-hairline);
}

.Target::after {
  inset-block: -0.25rem;
  left: 50%;
  width: var(--spacing-size-hairline);
}

/* The running line, set up the outer margin the way a sheet's slug is. */
.Running {
  position: absolute;
  top: 50%;
  right: calc(var(--margin) * 0.3);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  white-space: nowrap;
  writing-mode: vertical-rl;
  transform: translateY(-50%);
}

/* A margin too narrow for any of it: a phone, a tablet upright. */
@media (max-width: 60rem) {
  .Furniture {
    display: none;
  }
}
</style>
