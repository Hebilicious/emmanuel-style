<script setup lang="ts">
/**
 * The deck: the Library's plates standing in depth, one after the other in front.
 *
 * A front page leads with a picture. This paper's picture is the work itself: the
 * covers of the Library's leading projects set as a fan of plates in perspective,
 * the one in front lit and named, the others turned away behind it. The deck steps
 * on by itself every few seconds, so the picture is never the same twice in a row.
 *
 * It only draws; which plate is in front is the page's to say (`active`), because
 * the pager draws every block on both leaves and the copies have to agree.
 */
import { computed } from "vue"
import Cover from "./Cover.vue"

export interface DeckProject {
	readonly name: string
	readonly title: string
	readonly tagline: string
	readonly cover: string
	readonly activity: readonly string[]
	readonly contributions: number | null
}

const props = defineProps<{
	projects: readonly DeckProject[]
	/** The plate in front, counted from zero. */
	active: number
}>()

/** Each plate's place around the one in front: 0 in front, ±1 beside it, and so on round. */
const places = computed(() => {
	const count = props.projects.length
	return props.projects.map((_, index) => {
		let offset = (index - props.active) % count
		if (offset > count / 2) offset -= count
		if (offset < -count / 2) offset += count
		return offset
	})
})

const front = computed(() => props.projects[props.active] ?? null)
</script>

<template>
  <div class="Deck" aria-hidden="true">
    <div class="Stage">
      <span
        v-for="(project, index) of projects"
        :key="project.name"
        class="Sheet"
        :class="{ Front: places[index] === 0 }"
        :style='{
        	"--place": places[index],
        	"--away": Math.abs(places[index] ?? 0),
        	zIndex: 10 - Math.abs(places[index] ?? 0)
        }'>
        <Cover
          :motif="project.cover"
          :seed="project.name"
          :activity="project.activity"
          :count="project.contributions"
          :ratio="16 / 9"
        />
      </span>
    </div>
    <p v-if="front" class="Caption">
      <span class="Number">No.&nbsp;{{
          String(active + 1).padStart(2, "0")
        }}</span>
      <span class="Name">{{ front.title }}</span>
      <span class="Line">{{ front.tagline }}</span>
      <span class="Ticks">
        <span
          v-for="(project, index) of projects"
          :key="project.name"
          class="Tick"
          :class="{ On: index === active }"></span>
      </span>
    </p>
  </div>
</template>

<style scoped>
.Deck {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  min-height: 0;
}

/* The room the plates stand in: wide, with the eye a little above the middle. */
.Stage {
  position: relative;
  flex: 1 1 0;
  min-height: 7rem;
  perspective: 68rem;
  perspective-origin: 50% 38%;
  container-type: size;
  /* The fan is cut at the edges of its page: a plate far round it does not cross the spine. */
  overflow: clip;
}

/*
 * A plate. Its width is set by the height of the stage, so it is never cut; its
 * place in the fan is `--place`: beside the front one, turned toward it, further
 * back and dimmer the further round it is.
 */
.Sheet {
  position: absolute;
  inset-block: 6% 8%;
  left: 50%;
  aspect-ratio: 16 / 9;
  max-width: 62cqw;
  overflow: hidden;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background: var(--sunk);
  transform: translateX(-50%) translateX(calc(var(--place) * 44cqw))
    translateZ(calc(var(--away) * -9rem)) rotateY(calc(var(--place) * -34deg));
  filter: brightness(calc(1 - var(--away) * 0.3));
  opacity: calc(1.25 - var(--away) * 0.42);
  transition:
    transform 900ms cubic-bezier(0.3, 0.7, 0.2, 1),
    filter 900ms linear,
    opacity 900ms linear,
    border-color 400ms linear,
    box-shadow 900ms linear;
}

.Sheet :deep(svg) {
  position: absolute;
  inset: 0;
}

.Sheet.Front {
  border-color: var(--accent);
  box-shadow:
    0 1.6rem 2.2rem -1.4rem color-mix(in oklab, var(--accent) 60%, transparent),
    0 0 2.4rem -0.6rem color-mix(in oklab, var(--accent) 35%, transparent);
}

.Caption {
  display: flex;
  flex: none;
  align-items: baseline;
  gap: 0.9em;
  min-width: 0;
  padding-top: var(--spacing_fluid-tight-space-tight-xs);
  border-top: var(--spacing-size-hairline) solid var(--rule);
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
  color: var(--ink);
  font-weight: var(--typography-weight-body-bold);
}

.Line {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  letter-spacing: 0.04em;
  text-overflow: ellipsis;
  text-transform: none;
}

.Ticks {
  display: flex;
  flex: none;
  gap: 3px;
  align-self: center;
}

.Tick {
  width: 0.9rem;
  height: 2px;
  background: var(--rule-strong);
  transition: background 400ms linear;
}

.Tick.On {
  background: var(--accent);
}

@media (prefers-reduced-motion: reduce) {
  .Sheet {
    transition: none;
  }
}
</style>
