<script setup lang="ts">
/**
 * A project, open over the page it was chosen from (`?open=<name>`).
 *
 * The layout renders it, so any page can open a project in place: a card in the
 * Library, a piece of evidence under a skill. It is laid out as a spread of its
 * own: the headline, the plate and the facts on the left; the text, what is worth
 * knowing and the pull requests on the right. On a spread it is set smaller when
 * it would not fit (`zoom`), never cut; on a phone it is a sheet that scrolls.
 *
 * The keys: `n` and `p` for the next and previous project in the Library, the
 * arrows and Enter for its links, Esc to set it back on the page.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import { useQuery } from "@flamme/vue"
import { ProjectDetail, Stars } from "$flamme"
import { homeRow, placeCursor, rows } from "../shell/cursor.js"
import { cardOf, closeProject, openOf, swapProject } from "../shell/project.js"
import { useShell } from "../shell/shell.js"
import { useSiteIndex } from "../shell/site-index.js"
import { formatMonth } from "../utils/format.js"
import Cover from "./Cover.vue"

const route = useRoute()
const router = useRouter()
const shell = useShell()
const index = useSiteIndex()

const name = computed(() => openOf(route.query))
const { data } = useQuery(ProjectDetail, () => ({ name: name.value ?? "" }), {
	enabled: () => name.value !== null
})
const project = computed(() => {
	const value = data.value?.project ?? null
	return value !== null && value.name === name.value ? value : null
})

const { data: starData } = useQuery(
	Stars,
	() => ({ names: project.value?.repo ? [project.value.repo] : [] }),
	{ policy: "CacheAndNetwork", enabled: () => Boolean(project.value?.repo) }
)
const stars = computed(() => starData.value?.stars?.[0]?.stars ?? null)

/** The Library's order, for the number, the shelf and the projects either side. */
const order = computed(() => index.value.projects)
const position = computed(() =>
	order.value.findIndex((entry) => entry.name === name.value)
)
const previous = computed(() => order.value[position.value - 1] ?? null)
const next = computed(() => order.value[position.value + 1] ?? null)
const shelf = computed(() => order.value[position.value]?.shelf ?? "")

const years = computed(() => {
	const value = project.value
	if (value === null) return ""
	if (value.ended === null) return `since ${value.started}`
	return value.started === value.ended
		? String(value.started)
		: `${value.started}–${value.ended}`
})
const outside = computed(
	() => project.value !== null && project.value.kind !== "project"
)
const host = (url: string) =>
	url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "")
const source = computed(() => {
	const value = project.value
	if (value === null) return ""
	if (outside.value) return `${value.contributions ?? 0} merged ↗`
	return `${value.url.replace(/^https?:\/\/(www\.)?/, "")} ↗`
})

const label = computed(() => project.value?.title ?? "Project")
const close = () => void closeProject(router)
const go = (target: { name: string } | null) => {
	if (target) void swapProject(router, target.name)
}

/* --------------------------------------------------------------- the shell */

watch(
	name,
	(value) => {
		if (value !== null) shell.dialog = { kind: "project", name: value }
		else if (shell.dialog?.kind === "project") shell.dialog = null
	},
	{ immediate: true }
)

/*
 * The dialog says when it has drawn the project (the zoom into it waits for that),
 * and the cursor goes into it, to its first link; when it closes, the cursor goes
 * back to the card it came from.
 */
watch(
	() => [name.value, project.value?.name ?? null] as const,
	async ([wanted, drawn], previousValue) => {
		await nextTick()
		if (wanted === null) {
			shell.projectShown = null
			const left = previousValue?.[0] ?? null
			const card = left === null ? null : cardOf(left)
			if (card) shell.focus = placeCursor(card)
			return
		}
		if (drawn !== wanted) return
		fit()
		shell.projectShown = wanted
		const first = homeRow(rows())
		if (first) shell.focus = placeCursor(first)
	},
	{ immediate: true }
)

onMounted(() => {
	shell.project = {
		next: () => go(next.value),
		previous: () => go(previous.value),
		close
	}
	window.addEventListener("resize", fit)
})

onBeforeUnmount(() => {
	shell.project = null
	shell.projectShown = null
	window.removeEventListener("resize", fit)
})

/* ---------------------------------------------------------------- fitting */

const body = ref<HTMLElement | null>(null)
const scale = ref(1)

/**
 * On a spread the dialog is one page: when its text is taller than the sheet the
 * whole of it is set smaller (`zoom` rewraps it, so the height read back is true),
 * down to 0.7. Below that, and on a phone, it scrolls inside the sheet.
 */
const fit = () => {
	const element = body.value
	if (element === null) return
	element.style.zoom = "1"
	scale.value = 1
	if (!window.matchMedia("(min-width: 60rem)").matches) return
	if (element.scrollHeight <= element.clientHeight + 1) return
	let low = 0.7
	let high = 1
	for (let step = 0; step < 6; step += 1) {
		const middle = (low + high) / 2
		element.style.zoom = String(middle)
		if (element.scrollHeight <= element.clientHeight + 1) low = middle
		else high = middle
	}
	element.style.zoom = String(low)
	scale.value = low
}
</script>

<template>
  <Teleport to="body">
    <div v-if="name" class="Backdrop" aria-hidden="true" @click="close"></div>
    <section
      v-if="name"
      class="ProjectSheet"
      role="dialog"
      aria-modal="true"
      :aria-label="label"
      data-cursor-scope>
      <button
        type="button"
        class="Close"
        aria-label="Close"
        data-row
        data-label="close"
        @click="close">
        <span class="Key">esc</span> close
      </button>

      <div v-if="project" ref="body" class="Body">
        <div class="LeftPage">
          <p class="Kicker">
            <span class="Accent">§ {{ shelf }}</span>
            <span class="Dot" aria-hidden="true">·</span>
            <span class="Accent">No.&nbsp;{{
                String(position + 1).padStart(2, "0")
              }}</span>
            <span class="Dot" aria-hidden="true">·</span>
            <span>{{ project.language }}</span>
            <span class="Dot" aria-hidden="true">·</span>
            <span>{{ years }}</span>
            <template v-if="stars !== null && stars > 0">
              <span class="Dot" aria-hidden="true">·</span>
              <span class="Accent">★ {{ stars }}</span>
            </template>
            <span v-if="project.archived" class="Archived">archived</span>
          </p>
          <h2 class="Title display">{{ project.title }}</h2>
          <p class="Standfirst">{{ project.tagline }}</p>
          <div class="Plate" data-project-plate>
            <Cover
              :motif="project.cover"
              :seed="project.name"
              :activity="project.activity"
              :count="project.contributions"
              :ratio="2"
            />
          </div>
          <dl class="Facts">
            <div>
              <dt>{{ outside ? "Pull requests" : "Source" }}</dt>
              <dd>
                <a
                  :href="project.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-row
                  data-cursor-home
                  :data-label='outside ? "the merged pull requests" : "the repository"'>{{
                  source
                }}</a>
              </dd>
            </div>
            <div v-if="project.homepage">
              <dt>Site</dt>
              <dd>
                <a
                  :href="project.homepage"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-row
                  data-label="the project's site">{{ host(project.homepage) }}
                  ↗</a>
              </dd>
            </div>
            <div v-if="project.stack.length > 0" class="Stack">
              <dt>Built with</dt>
              <dd>
                <span v-for="tool of project.stack" :key="tool" class="Tool">{{
                  tool
                }}</span>
              </dd>
            </div>
          </dl>
        </div>

        <div class="RightPage">
          <p
            v-for="(paragraph, index) of project.body"
            :key="index"
            class="Paragraph"
            :class="{ Lede: index === 0 }">
            {{ paragraph }}
          </p>
          <section v-if="project.points.length > 0" class="Box">
            <h3 class="BoxTitle">Worth knowing</h3>
            <ul class="Points">
              <li v-for="point of project.points" :key="point">{{ point }}</li>
            </ul>
          </section>
          <section v-if="project.links.length > 0" class="Box">
            <h3 class="BoxTitle">
              {{ outside ? "Pull requests worth reading" : "Further reading" }}
            </h3>
            <ol class="Links">
              <li v-for="link of project.links" :key="link.url">
                <a
                  :href="link.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-row
                  :data-label="link.label">
                  <span class="LinkDate">{{
                    link.date ? formatMonth(link.date) : ""
                  }}</span>
                  <span class="LinkLabel">{{ link.label }}</span>
                  <span class="LinkArrow" aria-hidden="true">↗</span>
                </a>
              </li>
            </ol>
          </section>
        </div>
      </div>

      <nav class="Foot" aria-label="The Library">
        <button
          v-if="previous"
          type="button"
          class="Neighbour"
          data-row
          :data-label="`previous: ${previous.title}`"
          @click="go(previous)">
          <span class="Key">p</span>
          <span class="NeighbourName">← {{ previous.title }}</span>
        </button>
        <span v-else></span>
        <button
          v-if="next"
          type="button"
          class="Neighbour Next"
          data-row
          :data-label="`next: ${next.title}`"
          @click="go(next)">
          <span class="NeighbourName">{{ next.title }} →</span>
          <span class="Key">n</span>
        </button>
      </nav>
    </section>
  </Teleport>
</template>

<style scoped>
/* The page behind dims, as its own group in the zoom, so it fades rather than snaps. */
.Backdrop {
  view-transition-name: project-backdrop;
  position: fixed;
  inset: 0;
  z-index: 30;
  background: color-mix(in oklab, var(--paper) 70%, transparent);
  backdrop-filter: blur(2px) grayscale(0.5);
}

/*
 * The sheet: most of the screen, the paper's own colour, a heavy rule round it.
 * It carries the zoom's name, so the card grows into it.
 */
.ProjectSheet {
  view-transition-name: project;
  position: fixed;
  inset: 0;
  z-index: 31;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(
    80rem,
    calc(100vw - 2 * var(--spacing_fluid-gutter-space-gutter-s))
  );
  height: min(52rem, calc(100dvh - 5rem));
  margin: auto;
  padding: var(--spacing_fluid-tight-space-tight-l)
    var(--spacing_fluid-flow-space-s);
  border: var(--spacing-size-rule) double var(--rule-strong);
  background: var(--paper);
  box-shadow: 0 2rem 6rem rgb(0 0 0 / 45%);
}

.Close {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  gap: 0.5em;
  padding: 0.2rem 0.4rem;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Key {
  display: inline-block;
  min-width: 1.6em;
  padding: 0 0.3em;
  border: var(--spacing-size-hairline) solid var(--rule);
  border-bottom-width: 2px;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  line-height: 1.5;
  text-align: center;
  text-transform: uppercase;
}

/* Two pages, with the paper's gutter between them. */
.Body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-content: start;
  gap: var(--spacing_fluid-tight-space-tight-l)
    var(--spacing_fluid-column-space-column-s);
  min-height: 0;
  overflow: hidden;
}

.LeftPage,
.RightPage {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
  min-width: 0;
}

.Kicker {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.2rem 0.6em;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.Accent {
  color: var(--accent);
}

.Dot {
  color: var(--faint);
}

.Archived {
  color: var(--tertiary);
}

.Title {
  font-size: var(--typography_fluid-display-font-size-display-l);
  line-height: 1.02;
  text-wrap: balance;
}

.Standfirst {
  padding-bottom: var(--spacing_fluid-tight-space-tight-s);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-l);
  line-height: 1.4;
  text-wrap: pretty;
}

.Plate {
  aspect-ratio: 2;
  overflow: hidden;
  border: var(--spacing-size-hairline) solid var(--rule);
}

.Facts {
  display: flex;
  flex-direction: column;
  margin: 0;
}

.Facts > div {
  display: grid;
  grid-template-columns: 9em minmax(0, 1fr);
  gap: var(--spacing_fluid-tight-space-tight-s);
  padding-block: 0.3rem;
  border-top: var(--spacing-size-hairline) solid var(--rule);
}

.Facts dt {
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Facts dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-size: var(--typography_fluid-content-font-size-s);
}

.Facts a {
  color: var(--link);
}

.Stack dd {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.Tool {
  padding: 0 0.45em;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.08em;
  line-height: 1.7;
  text-transform: uppercase;
}

.Paragraph {
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-m);
  line-height: 1.6;
  hyphens: auto;
  text-wrap: pretty;
}

/* The first paragraph opens on a drop cap, as a story does. */
.Lede::first-letter {
  float: left;
  margin: 0.08em 0.12em 0 0;
  color: var(--accent);
  font-family: var(--font-nabla);
  font-palette: var(--nabla-accent);
  font-size: 3.4em;
  line-height: 0.8;
}

.Box {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-s);
  padding: var(--spacing_fluid-tight-space-tight-s)
    var(--spacing_fluid-tight-space-tight-m);
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background: var(--surface);
}

.BoxTitle {
  color: var(--accent);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  font-weight: var(--typography-weight-body-bold);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.Points {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--typography_fluid-content-font-size-s);
  line-height: 1.5;
}

.Points li {
  display: grid;
  grid-template-columns: 1.4em minmax(0, 1fr);
}

.Points li::before {
  content: "▸";
  color: var(--accent);
}

.Links {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.Links a {
  display: grid;
  grid-template-columns: 6.5em minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-s);
  padding-block: 0.3rem;
  border-top: var(--spacing-size-hairline) solid var(--rule);
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-s);
  line-height: 1.4;
  text-decoration: none;
}

.Links li:first-child a {
  border-top: 0;
}

.LinkDate {
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.LinkArrow {
  color: var(--accent);
}

/* The foot of the sheet: the projects either side, and their keys. */
.Foot {
  display: flex;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-m);
  margin-top: var(--spacing_fluid-tight-space-tight-m);
  padding-top: var(--spacing_fluid-tight-space-tight-s);
  border-top: var(--spacing-size-rule) double var(--rule-strong);
}

.Neighbour {
  display: inline-flex;
  align-items: center;
  gap: 0.6em;
  min-width: 0;
  padding: 0.3rem 0.4rem;
  color: var(--ink);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  letter-spacing: 0.06em;
  text-align: left;
}

.NeighbourName {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* A phone: the sheet is the screen, one page that scrolls. */
@media (max-width: 60rem) {
  .ProjectSheet {
    width: 100vw;
    height: 100dvh;
    padding: var(--spacing_fluid-tight-space-tight-m)
      var(--spacing_fluid-gutter-space-gutter-s);
    border: 0;
  }

  .Body {
    grid-template-columns: minmax(0, 1fr);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .Title {
    font-size: var(--typography_fluid-display-font-size-display-m);
  }

  .Standfirst {
    font-size: var(--typography_fluid-content-font-size-m);
  }

  .Paragraph {
    font-size: var(--typography_fluid-content-font-size-s);
  }

  .Facts > div {
    grid-template-columns: 7em minmax(0, 1fr);
  }
}

@media (hover: none) and (pointer: coarse) {
  .Key {
    display: none;
  }
}
</style>
