<script setup lang="ts">
/**
 * The Library: the work, as a paper's front page and then its sections.
 *
 * The first spread is the section's landing: what the Library is, its figures,
 * and the way on, a call to action the cursor starts on; beside it, the featured
 * work in miniature and the index of the shelves. The second is the front page:
 * the lead story takes the left-hand page, the forecaster with its plate and the
 * opening of its text, and the other featured work is set beside it. Each is one
 * composition across the spread, shown whole (`fit`), never cut between pages. On
 * a phone the stories run one after another instead.
 *
 * Then the shelves, each opening a spread of its own: projects, Nuxt and Vue,
 * tools, the work merged upstream, and the work done for clients. Every entry is a
 * card that opens the project over the page it is on (`?open=<name>`).
 *
 * The star counts are the worker's: one `Stars` query for every repository of the
 * site's own, answered from the durable cache first and refreshed from the
 * network, so the counts are there offline too, as last seen.
 */
import { computed, ref } from "vue"
import { useRouter } from "vue-router"
import { useQuery } from "@flamme/vue"
import { Stars } from "$flamme"
import { usePageQuery } from "$flamme/records/library"
import Cover from "../components/Cover.vue"
import Pager from "../components/Pager.vue"
import ProjectCard from "../components/ProjectCard.vue"
import SectionLanding from "../components/SectionLanding.vue"
import ShelfIndex from "../components/ShelfIndex.vue"
import type { PagerHandle, PagerItem } from "../components/pager.js"
import { openProject, projectHref } from "../shell/project.js"
import { useWide } from "../shell/wide.js"

const { data } = usePageQuery()
const wide = useWide()
const pager = ref<PagerHandle | null>(null)

const shelves = computed(() => data.value?.shelves ?? [])
type Project = NonNullable<(typeof shelves.value)[number]["projects"]>[number]

const all = computed(() =>
	shelves.value.flatMap((shelf) => shelf.projects ?? [])
)
/** Every entry's number, in the order of the Library, as the cards print it. */
const numbers = computed(
	() => new Map(all.value.map((project, index) => [project.name, index + 1]))
)
const shelfLabel = computed(
	() => new Map(shelves.value.map((shelf) => [shelf.slug, shelf.label]))
)
const labelOf = (slug: string) => shelfLabel.value.get(slug) ?? ""

const featured = computed(() =>
	all.value
		.filter((project) => project.featured !== null)
		.sort((a, b) => (a.featured ?? 0) - (b.featured ?? 0))
)
const lead = computed(() => featured.value[0] ?? null)
const others = computed(() => featured.value.slice(1))

const names = computed(() =>
	all.value
		.map((project) => project.repo)
		.filter((repo): repo is string => repo !== null)
)
const { data: starData } = useQuery(Stars, () => ({ names: names.value }), {
	policy: "CacheAndNetwork"
})
const stars = computed(
	() =>
		new Map(
			(starData.value?.stars ?? []).map(
				(entry) => [entry.name, entry.stars ?? null] as const
			)
		)
)
const starsOf = (project: Project) =>
	project.repo === null ? null : (stars.value.get(project.repo) ?? null)

const merged = computed(() =>
	all.value.reduce((sum, project) => sum + (project.contributions ?? 0), 0)
)
const own = computed(
	() => all.value.filter((project) => project.kind === "project").length
)
const index = computed(() =>
	shelves.value.map((shelf) => ({
		slug: shelf.slug,
		label: shelf.label,
		count: shelf.projects?.length ?? 0
	}))
)

type LibraryItem =
	| (PagerItem & { readonly kind: "landing" })
	| (PagerItem & { readonly kind: "front" })
	| (PagerItem & {
			readonly kind: "story"
			readonly project: Project
			readonly size: "lead" | "feature"
	  })
	| (PagerItem & {
			readonly kind: "shelf"
			readonly slug: string
			readonly label: string
			readonly blurb: string
			readonly count: number
			readonly index: number
	  })
	| (PagerItem & {
			readonly kind: "row"
			readonly projects: readonly Project[]
	  })

/** Cards to a row: two to a page of a spread, one on a phone. */
const perRow = computed(() => (wide.value ? 2 : 1))
/*
 * Kept out of the template: an inline object with a quoted key is rewritten by the
 * formatter into `&quot;` entities, which the type checker cannot parse.
 */
const rowStyle = computed(() => ({ "--per-row": String(perRow.value) }))

const items = computed<LibraryItem[]>(() => {
	if (lead.value === null) return []
	const front: LibraryItem[] = wide.value
		? [{ id: "front", kind: "front", screen: true, fit: true }]
		: [
				// On a phone the front page is the stories one after another, from a page of their own.
				{
					id: "front",
					kind: "story",
					project: lead.value,
					size: "lead",
					atomic: true,
					opens: true
				},
				...others.value.map(
					(project): LibraryItem => ({
						id: `story-${project.name}`,
						kind: "story",
						project,
						size: "feature",
						atomic: true
					})
				)
			]
	const sections = shelves.value.flatMap((shelf, index): LibraryItem[] => {
		const projects = shelf.projects ?? []
		const rows: LibraryItem[] = []
		for (let at = 0; at < projects.length; at += perRow.value) {
			rows.push({
				id: `row-${shelf.slug}-${at}`,
				kind: "row",
				projects: projects.slice(at, at + perRow.value),
				atomic: true
			})
		}
		return [
			{
				id: `shelf-${shelf.slug}`,
				kind: "shelf",
				slug: shelf.slug,
				label: shelf.label,
				blurb: shelf.blurb,
				count: projects.length,
				index: index + 1,
				opens: true,
				keep: true
			},
			...rows
		]
	})
	const landing: LibraryItem = {
		id: "landing",
		kind: "landing",
		screen: wide.value,
		fit: true
	}
	return [landing, ...front, ...sections]
})

const router = useRouter()
const starTotal = computed(() =>
	[...stars.value.values()].reduce<number>(
		(sum, count) => sum + (count ?? 0),
		0
	)
)
const figures = computed(() => [
	{ label: "entries", value: String(all.value.length) },
	{ label: "projects", value: String(own.value) },
	{ label: "merged upstream", value: String(merged.value) },
	...(starTotal.value > 0
		? [{ label: "stars", value: `★ ${starTotal.value}` }]
		: [])
])
/** A page of the pager as a place to go: `?page=N`, or the first page without a query. */
const toPage = (page: number | null) => ({
	query: { page: page !== null && page > 1 ? page : undefined }
})
const cta = computed(() => ({
	label: "Open the front page",
	detail:
		lead.value === null
			? ""
			: `${lead.value.title}, and ${others.value.length} more`,
	to: toPage(pageOfItem("front") ?? 2)
}))
const secondary = computed(() => {
	const first = shelves.value[0]
	return first === undefined
		? undefined
		: { label: "Straight to the shelves", to: toPage(pageOf(first.slug)) }
})
const open = (name: string) => void openProject(router, name)

/** The page an item starts on, counted from one, once the pager has laid out. */
const pageOfItem = (id: string): number | null => {
	void layout.value
	const screen = pager.value?.screenOf(id) ?? -1
	return screen === -1 ? null : screen + 1
}

/** The page each shelf opens on, for the index; known once the pager has laid out. */
const layout = ref(0)
const pageOf = (slug: string): number | null => {
	void layout.value
	const screen = pager.value?.screenOf(`shelf-${slug}`) ?? -1
	return screen === -1 ? null : screen + 1
}
</script>

<template>
  <Pager
    ref="pager"
    :items
    :opens-screen="true"
    label="Library"
    @layout="layout += 1">
    <template #item="{ item }">
      <SectionLanding
        v-if='item.kind === "landing"'
        kicker="the work"
        title="The Library"
        standfirst="A portfolio, kept like a paper's archive: systems built end to end, modules for Nuxt and Vue, tools, and the work merged into other people's code."
        :figures
        :cta
        :secondary
        :wide>
        <section v-if="wide" class="Featured" aria-label="On the front page">
          <p class="Flag">
            <span class="Mark" aria-hidden="true">§</span> On the front page
          </p>
          <div class="Thumbs">
            <a
              v-for="project of featured"
              :key="project.name"
              class="Thumb"
              :href="projectHref(router, project.name)"
              data-row
              :data-label="project.title"
              :data-project="project.name"
              @click.exact.prevent="open(project.name)">
              <span class="ThumbPlate" data-project-plate>
                <Cover
                  :motif="project.cover"
                  :seed="project.name"
                  :activity="project.activity"
                  :count="project.contributions"
                  :ratio="16 / 9"
                />
              </span>
              <span class="ThumbNumber">No.&nbsp;{{
                  String(numbers.get(project.name) ?? 0).padStart(2, "0")
                }}</span>
              <span class="ThumbTitle">{{ project.title }}</span>
            </a>
          </div>
        </section>
        <ShelfIndex
          :shelves="index"
          :page-of="pageOf"
          :projects="own"
          :merged
          boxed
        />
      </SectionLanding>

      <!--
        The front page: on a spread, the lead story on the left page and the index
        and the other stories on the right, one composition split at the spine. On a
        phone, only the index, after the lead story; the stories are items of their own.
      -->
      <div
        v-else-if='item.kind === "front"'
        class="Front"
        :class="{ Spread: wide }">
        <section
          v-if="wide && lead"
          class="LeftPage"
          aria-label="The lead story">
          <p class="Flag">
            <span class="Mark" aria-hidden="true">§</span> The front page
          </p>
          <ProjectCard
            :project="lead"
            :number="numbers.get(lead.name) ?? 1"
            :stars="starsOf(lead)"
            :shelf="labelOf(lead.shelf)"
            size="lead"
            fill
          />
        </section>

        <section class="RightPage" aria-label="Featured work and the index">
          <div v-if="wide" class="Features">
            <ProjectCard
              v-for="project of others"
              :key="project.name"
              :project
              :number="numbers.get(project.name) ?? 0"
              :stars="starsOf(project)"
              :shelf="labelOf(project.shelf)"
              size="feature"
              fill
            />
            <ShelfIndex
              :shelves="index"
              :page-of="pageOf"
              :projects="own"
              :merged
              boxed
            />
          </div>
          <ShelfIndex
            v-else
            :shelves="index"
            :page-of="pageOf"
            :projects="own"
            :merged
          />
        </section>
      </div>

      <ProjectCard
        v-else-if='item.kind === "story"'
        :project="item.project"
        :number="numbers.get(item.project.name) ?? 0"
        :stars="starsOf(item.project)"
        :shelf="labelOf(item.project.shelf)"
        :size="item.size"
      />

      <header v-else-if='item.kind === "shelf"' class="ShelfHead">
        <p class="ShelfKicker">
          <span class="Mark">Shelf {{ item.index }}</span>
          <span class="Dot" aria-hidden="true">·</span>
          <span>{{ item.count }} {{
              item.count === 1 ? "entry" : "entries"
            }}</span>
        </p>
        <h2 class="ShelfTitle display">{{ item.label }}</h2>
        <p class="ShelfBlurb">{{ item.blurb }}</p>
      </header>

      <div v-else-if='item.kind === "row"' class="Row" :style="rowStyle">
        <ProjectCard
          v-for="project of item.projects"
          :key="project.name"
          :project
          :number="numbers.get(project.name) ?? 0"
          :stars="starsOf(project)"
        />
      </div>
    </template>
  </Pager>
</template>

<style scoped>
/*
 * The front page on a spread: two pages with the pager's own gutter between them,
 * so the split falls exactly at the spine and each half is a page of its own.
 */
.Front.Spread {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: var(--spacing_fluid-column-space-column-s);
  /* At least a page; taller, and the pager sets it smaller until it fits. */
  min-height: var(--page-height);
}

.LeftPage,
.RightPage {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
  min-width: 0;
  min-height: 0;
}

.Flag,
.ShelfKicker {
  display: flex;
  align-items: baseline;
  gap: 0.9em;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.Mark {
  color: var(--accent);
}

.Dot {
  color: var(--faint);
}

.LeftPage :deep(.Card) {
  flex: 1 1 0;
}

.Features {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(3, minmax(min-content, 1fr));
  gap: var(--spacing_fluid-tight-space-tight-m)
    var(--spacing_fluid-tight-space-tight-l);
  min-height: 0;
}

/* The landing's right-hand page: the featured work in miniature, then the index. */
.Featured {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-s);
}

.Thumbs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Thumb {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
  padding: 0.3rem;
  margin: -0.3rem;
  color: var(--ink);
  text-decoration: none;
}

.ThumbPlate {
  display: block;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: var(--spacing-size-hairline) solid var(--rule);
}

.ThumbNumber {
  color: var(--accent);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.12em;
}

.ThumbTitle {
  overflow: hidden;
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  font-weight: var(--typography-weight-body-bold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.Thumb[data-cursor="true"] .ThumbPlate {
  border-color: var(--accent);
}

.Thumb[data-cursor="true"] .ThumbTitle {
  color: var(--accent);
}

/* A shelf's opening: its number, its title in the display face, and its line. */
.ShelfHead {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  padding-bottom: var(--spacing_fluid-tight-space-tight-s);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
}

.ShelfTitle {
  font-size: var(--typography_fluid-display-font-size-display-m);
  line-height: 1.05;
}

.ShelfBlurb {
  max-width: 46ch;
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-s);
  line-height: 1.5;
}

.Row {
  display: grid;
  grid-template-columns: repeat(var(--per-row), minmax(0, 1fr));
  gap: var(--spacing_fluid-tight-space-tight-l);
}

@media (max-width: 60rem) {
  .Standfirst {
    font-size: var(--typography_fluid-content-font-size-s);
  }

  .ShelfTitle {
    font-size: var(--typography_fluid-display-font-size-display-s);
  }
}
</style>
