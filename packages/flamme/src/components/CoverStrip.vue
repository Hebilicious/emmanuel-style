<script setup lang="ts">
/**
 * The strip: the Library's covers passing by, one after the other, without a stop.
 *
 * A front page leads with a picture. This paper's picture is the work itself: the
 * covers of the Library's projects, each with its number and its name, moving
 * slowly and evenly from right to left the way a ticker does. The row is set
 * twice, end to end, and moved by half its length, so it never comes to an end.
 *
 * It only draws: it is hidden from assistive technology, and the way into the
 * Library is the button under it.
 */
import Cover from "./Cover.vue"

export interface StripProject {
	readonly name: string
	readonly title: string
	readonly cover: string
	readonly activity: readonly string[]
	readonly contributions: number | null
}

defineProps<{ projects: readonly StripProject[] }>()

const two = (value: number) => String(value).padStart(2, "0")
</script>

<template>
  <div class="Strip" aria-hidden="true">
    <div class="Track" :style='{ "--count": projects.length }'>
      <div v-for="copy of 2" :key="copy" class="Run">
        <figure
          v-for="(project, index) of projects"
          :key="project.name"
          class="Card">
          <span class="Plate">
            <Cover
              :motif="project.cover"
              :seed="project.name"
              :activity="project.activity"
              :count="project.contributions"
              :ratio="16 / 9"
            />
          </span>
          <figcaption class="Caption">
            <span class="Number">No.&nbsp;{{ two(index + 1) }}</span>
            <span class="Name">{{ project.title }}</span>
          </figcaption>
        </figure>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * The window the row passes behind. Its height is what the page leaves it, and a
 * cover is as tall as the window less its caption, so nothing is ever cut top or
 * bottom. The two ends fade out, so a cover arrives and leaves instead of being
 * cut by an edge.
 */
.Strip {
  --caption: 1.7rem;
  --gap: var(--spacing_fluid-tight-space-tight-m);
  position: relative;
  flex: 1 1 0;
  min-height: 7rem;
  overflow: clip;
  container-type: size;
  mask-image: linear-gradient(
    to right,
    transparent 0,
    #000 7%,
    #000 93%,
    transparent 100%
  );
}

/* Both copies of the row, moved left by one of them, at the same pace for ever. */
.Track {
  display: flex;
  width: max-content;
  height: 100%;
  animation: strip-drift calc(var(--count) * 7s) linear infinite;
}

.Run {
  display: flex;
  gap: var(--gap);
  padding-inline-end: var(--gap);
}

.Card {
  display: flex;
  flex: none;
  flex-direction: column;
  width: calc((100cqh - var(--caption)) * 16 / 9);
  margin: 0;
}

.Plate {
  position: relative;
  display: block;
  height: calc(100cqh - var(--caption));
  overflow: hidden;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background: var(--sunk);
}

.Plate :deep(svg) {
  position: absolute;
  inset: 0;
}

.Caption {
  display: flex;
  align-items: baseline;
  gap: 0.8em;
  height: var(--caption);
  padding-top: 0.45rem;
  overflow: hidden;
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  white-space: nowrap;
}

.Number {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.Name {
  overflow: hidden;
  color: var(--ink);
  font-weight: var(--typography-weight-body-bold);
  text-overflow: ellipsis;
}

@keyframes strip-drift {
  to {
    transform: translateX(-50%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .Track {
    animation: none;
  }
}
</style>
