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
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { canDrawElements, captureDeck, TILE } from "../press/deck.js"
import Cover from "./Cover.vue"
import Inline from "./Inline.vue"

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

/*
 * Where the browser can draw HTML into a canvas, the plates are laid out a second
 * time inside a capture canvas, and the press draws the deck on the GPU from them
 * (`press/deck.ts`). The canvas is kept painted but out of sight in a box one
 * pixel across: a canvas that is hidden has nothing to draw from.
 */
const stage = ref<HTMLElement | null>(null)
const capture = ref<HTMLCanvasElement | null>(null)
const captured = ref(false)
let release: (() => void) | null = null

onMounted(() => {
	captured.value = canDrawElements()
	if (!captured.value) return
	requestAnimationFrame(() => {
		if (stage.value !== null && capture.value !== null)
			release = captureDeck(stage.value, capture.value)
	})
})
onBeforeUnmount(() => release?.())
</script>

<template>
  <div class="Deck" aria-hidden="true">
    <div
      ref="stage"
      class="Stage"
      data-deck
      :data-deck-places='places.join(" ")'>
      <span v-if="captured" class="Capture">
        <canvas
          ref="capture"
          layoutsubtree
          :width="TILE.width * projects.length"
          :height="TILE.height"
          :style="{
          	width: `${TILE.width * projects.length}px`,
          	height: `${TILE.height}px`
          }">
          <span
            v-for="project of projects"
            :key="project.name"
            class="Tile"
            :style="{ width: `${TILE.width}px`, height: `${TILE.height}px` }">
            <Cover
              :motif="project.cover"
              :seed="project.name"
              :activity="project.activity"
              :count="project.contributions"
              :ratio="16 / 9"
            />
          </span>
        </canvas>
      </span>
      <div class="Room">
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
    </div>
    <p v-if="front" class="Caption">
      <span class="Number">No.&nbsp;{{
          String(active + 1).padStart(2, "0")
        }}</span>
      <span class="Name">{{ front.title }}</span>
      <span class="Line"><Inline :text="front.tagline" /></span>
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

/*
 * The stage is the box the fan is measured against and cut to: a plate far round
 * it does not cross the spine. The room inside it is where the perspective is,
 * wide, with the eye a little above the middle. They are two elements so that the
 * perspective is not on the element that clips and contains.
 */
.Stage {
  position: relative;
  flex: 1 1 0;
  min-height: 7rem;
  container-type: size;
  overflow: clip;
}

.Room {
  position: absolute;
  inset: 0;
  perspective: 68rem;
  perspective-origin: 50% 38%;
}

/* Once the press has drawn the deck on the GPU, the HTML deck under it steps aside. */
:global(:root[data-deck-gpu]) .Room {
  visibility: hidden;
}

/* The capture canvas: painted, and out of sight in a box one pixel across. */
.Capture {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  width: 1px;
  height: 1px;
  overflow: hidden;
  pointer-events: none;
}

.Tile {
  position: absolute;
  inset-block-start: 0;
  inset-inline-start: 0;
  display: block;
  background: var(--sunk);
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
  opacity: calc(1.1 - var(--away) * 0.5);
  transition:
    transform 900ms cubic-bezier(0.3, 0.7, 0.2, 1),
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
