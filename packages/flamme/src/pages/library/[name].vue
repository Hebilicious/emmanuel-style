<script setup lang="ts">
/**
 * One project, as a story in the paper.
 *
 * The headline runs across the top of the first spread: the shelf and the facts in
 * the kicker, the name in the display face, the tagline as the standfirst. Under
 * it, the plate, the text, what is worth knowing, the facts in a box, and, for
 * outside work, the pull requests worth reading, each one a row the cursor reaches.
 * The foot of the story names the projects before and after it in the Library, so
 * the paper can be read on from here as from the Library itself.
 */
import { computed, watch } from "vue"
import { RouterLink } from "vue-router"
import { useQuery } from "@flamme/vue"
import { Stars } from "$flamme"
import { usePageQuery } from "$flamme/records/library__name_"
import Cover from "../../components/Cover.vue"
import Pager from "../../components/Pager.vue"
import type { PagerItem } from "../../components/pager.js"
import { formatMonth } from "../../utils/format.js"

const { data } = usePageQuery()
const project = computed(() => data.value?.project ?? null)
const shelves = computed(() => data.value?.shelves ?? [])

const order = computed(() =>
	shelves.value.flatMap((shelf) =>
		(shelf.projects ?? []).map((entry) => ({
			...entry,
			shelf: shelf.label,
			slug: shelf.slug
		}))
	)
)
const position = computed(() =>
	order.value.findIndex((entry) => entry.name === project.value?.name)
)
const previous = computed(() => order.value[position.value - 1] ?? null)
const next = computed(() => order.value[position.value + 1] ?? null)
const shelf = computed(() => order.value[position.value]?.shelf ?? "")

const { data: starData } = useQuery(
	Stars,
	() => ({ names: project.value?.repo ? [project.value.repo] : [] }),
	{ policy: "CacheAndNetwork" }
)
const stars = computed(() => starData.value?.stars?.[0]?.stars ?? null)

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

/** The repository as an address (`github.com/Hebilicious/agris`), or the count of merged pull requests. */
const source = computed(() => {
	const value = project.value
	if (value === null) return ""
	if (outside.value) return `${value.contributions ?? 0} merged ↗`
	return `${value.url.replace(/^https?:\/\/(www\.)?/, "")} ↗`
})

const caption = computed(() => {
	const value = project.value
	if (value === null) return ""
	if (!outside.value) return `${value.title}, drawn for its page.`
	const count = value.contributions ?? 0
	return `${count} pull request${count === 1 ? "" : "s"} merged, month by month, ${years.value}.`
})

type ProjectItem =
	| (PagerItem & { readonly kind: "plate" })
	| (PagerItem & {
			readonly kind: "paragraph"
			readonly text: string
			readonly lede: boolean
	  })
	| (PagerItem & { readonly kind: "points" })
	| (PagerItem & { readonly kind: "facts" })
	| (PagerItem & { readonly kind: "links" })
	| (PagerItem & { readonly kind: "foot" })

const items = computed<ProjectItem[]>(() => {
	const value = project.value
	if (value === null) return []
	return [
		{ id: "plate", kind: "plate", atomic: true },
		...value.body.map(
			(text, index): ProjectItem => ({
				id: `body-${index}`,
				kind: "paragraph",
				text,
				lede: index === 0
			})
		),
		...(value.points.length > 0
			? [{ id: "points", kind: "points", atomic: true } as const]
			: []),
		{ id: "facts", kind: "facts", atomic: true },
		...(value.links.length > 0
			? [{ id: "links", kind: "links", atomic: true } as const]
			: []),
		{ id: "foot", kind: "foot", atomic: true }
	]
})

watch(
	project,
	(value) => {
		if (value) document.title = `${value.title} · Library · Emmanuel`
	},
	{ immediate: true }
)
</script>

<template>
  <article v-if="project" class="Project">
    <Pager :items label="Project">
      <template #lead>
        <header class="Head">
          <p class="Kicker">
            <RouterLink
              class="Back"
              to="/library"
              data-row
              data-label="back to the library">← library</RouterLink>
            <span class="Dot" aria-hidden="true">·</span>
            <span>§ {{ shelf }}</span>
            <span class="Dot" aria-hidden="true">·</span>
            <span class="Number">No.&nbsp;{{
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
        </header>
      </template>

      <template #item="{ item }">
        <figure v-if='item.kind === "plate"' class="Figure">
          <div class="PlateFrame">
            <Cover
              :motif="project.cover"
              :seed="project.name"
              :activity="project.activity"
              :count="project.contributions"
              :ratio="16 / 8"
            />
          </div>
          <figcaption>
            <span class="FigureMark">Plate</span>
            {{ caption }}
          </figcaption>
        </figure>

        <div
          v-else-if='item.kind === "paragraph"'
          class="Prose is-paragraph"
          :class='{ "is-lede": item.lede }'>
          <p>{{ item.text }}</p>
        </div>

        <section v-else-if='item.kind === "points"' class="Box">
          <h3 class="BoxTitle">Worth knowing</h3>
          <ul class="Points">
            <li v-for="point of project.points" :key="point">{{ point }}</li>
          </ul>
        </section>

        <section v-else-if='item.kind === "facts"' class="Box Facts">
          <h3 class="BoxTitle">The facts</h3>
          <dl>
            <div>
              <dt>{{ outside ? "Pull requests" : "Source" }}</dt>
              <dd>
                <a
                  :href="project.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-row
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
            <div>
              <dt>Language</dt>
              <dd>{{ project.language }}</dd>
            </div>
            <div>
              <dt>Years</dt>
              <dd>{{ years }}</dd>
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
        </section>

        <section v-else-if='item.kind === "links"' class="Box">
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

        <nav
          v-else-if='item.kind === "foot"'
          class="Foot"
          aria-label="The Library">
          <RouterLink
            v-if="previous"
            class="Neighbour"
            :to="`/library/${previous.name}`"
            data-row
            :data-label="`previous: ${previous.title}`">
            <span class="NeighbourKicker">← previous · {{
                previous.shelf
              }}</span>
            <span class="NeighbourTitle">{{ previous.title }}</span>
          </RouterLink>
          <RouterLink
            v-if="next"
            class="Neighbour Next"
            :to="`/library/${next.name}`"
            data-row
            :data-label="`next: ${next.title}`">
            <span class="NeighbourKicker">next · {{ next.shelf }} →</span>
            <span class="NeighbourTitle">{{ next.title }}</span>
          </RouterLink>
        </nav>
      </template>
    </Pager>
  </article>

  <section v-else-if="data" class="Missing">
    <h2 class="display">Not in the Library</h2>
    <p>
      There is no project by that name.
      <RouterLink to="/library" data-row data-label="the library">Back to the
        Library →</RouterLink>
    </p>
  </section>
</template>

<style scoped>
.Project {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.Head {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  grid-template-areas:
    "kicker kicker"
    "title standfirst";
  align-items: end;
  gap: var(--spacing_fluid-tight-space-tight-m)
    var(--spacing_fluid-column-space-column-s);
  padding-bottom: var(--spacing_fluid-tight-space-tight-l);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
}

.Kicker {
  grid-area: kicker;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing_fluid-tight-space-tight-xs)
    var(--spacing_fluid-tight-space-tight-s);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.Back,
.Number,
.Accent {
  color: var(--accent);
}

.Dot {
  color: var(--faint);
}

.Archived {
  margin-left: auto;
  color: var(--tertiary);
}

.Title {
  grid-area: title;
  font-size: var(--typography_fluid-display-font-size-display-l);
  line-height: 1.02;
  text-wrap: balance;
}

.Standfirst {
  grid-area: standfirst;
  padding-left: var(--spacing_fluid-tight-space-tight-l);
  border-left: var(--spacing-size-hairline) solid var(--rule);
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-m);
  line-height: 1.5;
  text-wrap: pretty;
}

.Figure {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  margin: 0;
}

.PlateFrame {
  aspect-ratio: 2;
  overflow: hidden;
  border: var(--spacing-size-hairline) solid var(--rule);
}

.Figure figcaption {
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.06em;
}

.FigureMark {
  margin-right: 0.5em;
  color: var(--accent);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

/* A box set in the column, the way a paper sets the facts beside a story. */
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

.Facts dl {
  display: flex;
  flex-direction: column;
  margin: 0;
}

.Facts dl > div {
  display: grid;
  grid-template-columns: 9em minmax(0, 1fr);
  gap: var(--spacing_fluid-tight-space-tight-s);
  padding-block: 0.3rem;
  border-top: var(--spacing-size-hairline) solid var(--rule);
}

.Facts dl > div:first-child {
  border-top: 0;
}

.Facts dt {
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Facts dd {
  margin: 0;
  min-width: 0;
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
  gap: var(--spacing_fluid-tight-space-tight-s);
  align-items: baseline;
  padding-block: 0.35rem;
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

/* The foot of the story: where to read on. */
.Foot {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--spacing_fluid-tight-space-tight-m);
  padding-top: var(--spacing_fluid-tight-space-tight-s);
  border-top: var(--spacing-size-rule) double var(--rule-strong);
}

.Neighbour {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.35rem 0.5rem;
  color: var(--ink);
  text-decoration: none;
}

.Neighbour.Next {
  grid-column: 2;
  align-items: flex-end;
  text-align: right;
}

.NeighbourKicker {
  color: var(--accent);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.NeighbourTitle {
  font-size: var(--typography_fluid-content-font-size-m);
  font-weight: var(--typography-weight-body-bold);
}

.Missing {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
  padding-top: var(--spacing_fluid-flow-space-m);
}

@media (max-width: 60rem) {
  .Head {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  .Title {
    font-size: var(--typography_fluid-display-font-size-display-m);
  }

  .Standfirst {
    padding-left: 0;
    border-left: 0;
    font-size: var(--typography_fluid-content-font-size-s);
  }

  .Facts dl > div {
    grid-template-columns: 7em minmax(0, 1fr);
  }
}
</style>
