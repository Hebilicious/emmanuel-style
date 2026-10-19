<script setup lang="ts">
/**
 * The Library: the work, as a paper's front page and then its sections.
 *
 * The first spread is the front page. The lead story takes the left-hand page,
 * the forecaster with its plate and the opening of its text; the other featured
 * work is set beside it on the right, under an index of the shelves. It is one
 * composition across the spread, shown whole (`fit`), never cut between pages.
 * On a phone the stories run one after another instead.
 *
 * Then the shelves, each opening a spread of its own: projects, Nuxt and Vue,
 * tools, the work merged upstream, and the work done for clients. Every entry is a
 * card that opens the project's page, `/library/<name>`.
 *
 * The star counts are the worker's: one `Stars` query for every repository of the
 * site's own, answered from the durable cache first and refreshed from the
 * network, so the counts are there offline too, as last seen.
 */
import { computed, ref } from "vue"
import { useQuery } from "@flamme/vue"
import { Stars } from "$flamme"
import { usePageQuery } from "$flamme/records/library"
import Pager from "../components/Pager.vue"
import ProjectCard from "../components/ProjectCard.vue"
import ShelfIndex from "../components/ShelfIndex.vue"
import type { PagerHandle, PagerItem } from "../components/pager.js"
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
				// On a phone the lead story comes first, then the index, then the others.
				{
					id: `story-${lead.value.name}`,
					kind: "story",
					project: lead.value,
					size: "lead",
					atomic: true
				},
				{ id: "front", kind: "front", atomic: true },
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
	return [...front, ...sections]
})

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
      <!--
        The front page: on a spread, the lead story on the left page and the index
        and the other stories on the right, one composition split at the spine. On a
        phone, only the index, after the lead story; the stories are items of their own.
      -->
      <div v-if='item.kind === "front"' class="Front" :class="{ Spread: wide }">
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
