<script setup lang="ts">
/**
 * The Library: the repositories, shelf by shelf.
 *
 * Each shelf opens a page and its entries are packed under it until the page is
 * full, then continue on the next. An entry is a row: Enter opens its card, which
 * says what the project is and opens it on GitHub.
 *
 * The star counts are the worker's: one `Stars` query for every repository on the
 * shelves, answered from the durable cache first and refreshed from the network,
 * so the counts are there offline too, as last seen.
 */
import { computed } from "vue"
import { useQuery } from "@flamme/vue"
import { Stars } from "$flamme"
import { usePageQuery } from "$flamme/records/library"
import Pager from "../components/Pager.vue"
import type { PagerItem } from "../components/pager.js"
import { useShell } from "../shell/shell.js"

const { data } = usePageQuery()
const shell = useShell()

const shelves = computed(() => data.value?.shelves ?? [])
const names = computed(() =>
	shelves.value.flatMap((shelf) =>
		(shelf.repositories ?? []).map((repo) => repo.name)
	)
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

type Repository = NonNullable<
	(typeof shelves.value)[number]["repositories"]
>[number]

type LibraryItem =
	| (PagerItem & {
			readonly kind: "shelf"
			readonly label: string
			readonly count: number
			readonly index: number
	  })
	| (PagerItem & {
			readonly kind: "repo"
			readonly repo: Repository
			readonly shelf: string
	  })

const items = computed<LibraryItem[]>(() =>
	shelves.value.flatMap((shelf, index) => [
		{
			id: `shelf-${shelf.slug}`,
			kind: "shelf" as const,
			label: shelf.label,
			count: shelf.repositories?.length ?? 0,
			index: index + 1,
			opens: true,
			keep: true
		},
		...(shelf.repositories ?? []).map((repo) => ({
			id: `repo-${repo.name}`,
			kind: "repo" as const,
			repo,
			shelf: shelf.label,
			atomic: true
		}))
	])
)

const total = computed(() => names.value.length)
const starTotal = computed(() =>
	[...stars.value.values()].reduce<number>(
		(sum, count) => sum + (count ?? 0),
		0
	)
)

const open = (repo: Repository, shelf: string) => {
	shell.dialog = {
		kind: "repo",
		repo: {
			name: repo.name,
			description: repo.description,
			language: repo.language,
			url: repo.url,
			homepage: repo.homepage,
			archived: repo.archived,
			shelf,
			stars: stars.value.get(repo.name) ?? null
		}
	}
}

const host = (url: string) =>
	url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "")
const compact = (count: number) =>
	count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
</script>

<template>
  <Pager :items label="Library">
    <template #lead>
      <p class="Standfirst">
        <span class="Lead">Open source modules, tools and templates.</span>
        <span class="Facts">
          <span>{{ total }} repositories</span>
          <span class="Dot" aria-hidden="true">·</span>
          <span>{{ shelves.length }} shelves</span>
          <template v-if="starTotal > 0">
            <span class="Dot" aria-hidden="true">·</span>
            <span class="Accent">★ {{ compact(starTotal) }}</span>
          </template>
        </span>
      </p>
    </template>

    <template #item="{ item }">
      <h2 v-if='item.kind === "shelf"' class="Shelf">
        <span class="Number display-accent" aria-hidden="true">{{
          String(item.index).padStart(2, "0")
        }}</span>
        <span class="ShelfName">{{ item.label }}</span>
        <span class="ShelfCount">{{ item.count }}</span>
      </h2>

      <button
        v-else
        type="button"
        class="Entry"
        data-row
        :data-label="item.repo.name"
        @click="open(item.repo, item.shelf)">
        <span class="Head">
          <span class="Repo">{{ item.repo.name }}</span>
          <span class="Meta">
            <span v-if="item.repo.archived" class="Flag">archived</span>
            <span class="Lang">{{ item.repo.language }}</span>
            <!-- A dash until the counts arrive; nothing for a repository GitHub has no count for. -->
            <span v-if="!stars.has(item.repo.name)" class="Stars Pending">★
              –</span>
            <span
              v-else-if="stars.get(item.repo.name) !== null"
              class="Stars">★ {{ stars.get(item.repo.name) }}</span>
          </span>
        </span>
        <span class="Body">
          <span class="Description">{{ item.repo.description }}</span>
          <span v-if="item.repo.homepage" class="Home">{{
              host(item.repo.homepage)
            }} ↗</span>
        </span>
      </button>
    </template>
  </Pager>
</template>

<style scoped>
.Standfirst {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-xs)
    var(--spacing_fluid-tight-space-tight-l);
  padding-bottom: var(--spacing_fluid-tight-space-tight-s);
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
}

.Lead {
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-l);
}

.Facts {
  display: flex;
  gap: var(--spacing_fluid-tight-space-tight-s);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Dot {
  color: var(--faint);
}

.Accent {
  color: var(--accent);
}

/* A shelf heading: its number, its name, and how many entries it holds. */
.Shelf {
  display: flex;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-m);
  padding-bottom: var(--spacing_fluid-tight-space-tight-xs);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
}

.Number {
  font-size: var(--typography_fluid-content-font-size-2xl);
  line-height: 1;
}

.ShelfName {
  flex: 1;
  color: var(--ink);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  font-weight: var(--typography-weight-body-bold);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.ShelfCount {
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  font-variant-numeric: tabular-nums;
}

.Entry {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  width: 100%;
  padding: 0.55rem 0.7rem 0.6rem;
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
  text-align: left;
  text-transform: none;
}

.Head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Repo {
  color: var(--ink);
  font-weight: var(--typography-weight-body-bold);
  overflow-wrap: anywhere;
  transition: color 120ms linear;
}

.Meta {
  display: flex;
  flex: none;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-s);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Lang {
  color: var(--faint);
}

.Flag {
  color: var(--tertiary);
}

.Stars {
  min-width: 5ch;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.Stars.Pending {
  color: var(--faint);
}

.Body {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-l);
}

.Description {
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-s);
  line-height: 1.5;
}

.Home {
  flex: none;
  color: var(--link);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.06em;
}

.Entry[data-cursor="true"] .Repo,
:global(.mouse-enabled) .Entry:hover .Repo {
  color: var(--accent);
}

@media (max-width: 40rem) {
  .Lead {
    font-size: var(--typography_fluid-content-font-size-m);
  }

  .Home {
    display: none;
  }
}
</style>
