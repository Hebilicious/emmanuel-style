<script setup lang="ts">
/**
 * The blog: every article, newest first.
 *
 * The first spread is the section's landing: what the blog is, its figures, and
 * the way on, a call to action to the latest dispatch that the cursor starts on;
 * beside it, the latest plate and the contents. Then the newest article is the
 * lead story, its opening plate on one side, the headline, the standfirst and a
 * clear "read" on the other, the way a front page sets the story it leads with.
 * Every older article follows as an entry in the columns.
 */
import { computed } from "vue"
import { RouterLink } from "vue-router"
import { usePageQuery } from "$flamme/records/blog"
import FavouriteButton from "../components/FavouriteButton.vue"
import Pager from "../components/Pager.vue"
import SectionLanding from "../components/SectionLanding.vue"
import type { PagerItem } from "../components/pager.js"
import { useWide } from "../shell/wide.js"
import { formatDate, readingTime } from "../utils/format.js"

const { data } = usePageQuery()
const wide = useWide()

const posts = computed(() =>
	[...(data.value?.posts ?? [])].sort((a, b) => b.date.localeCompare(a.date))
)

type Post = (typeof posts.value)[number]

interface LandingItem extends PagerItem {
	readonly kind: "landing"
}

interface BlogItem extends PagerItem {
	readonly kind: "post"
	readonly post: Post
	readonly lead: boolean
	readonly plate: { src: string; caption: string } | null
	readonly minutes: number
	readonly number: number
}

const stories = computed<BlogItem[]>(() =>
	posts.value.map((post, index) => {
		const figure = (post.blocks ?? []).find(
			(block) => block.kind === "figure" && block.image
		)
		return {
			id: post.slug,
			kind: "post" as const,
			post,
			lead: index === 0,
			// The lead is a spread of its own, shown whole: its "read" is never off the page.
			screen: index === 0,
			fit: index === 0,
			opens: index === 0,
			plate: figure?.image
				? { src: figure.image, caption: figure.caption ?? "" }
				: null,
			minutes: readingTime((post.blocks ?? []).map((block) => block.text)),
			number: posts.value.length - index
		}
	})
)

const items = computed<(LandingItem | BlogItem)[]>(() =>
	stories.value.length === 0
		? []
		: [
				{ id: "landing", kind: "landing", screen: wide.value, fit: true },
				...stories.value
			]
)

const latest = computed(() => stories.value[0] ?? null)
const minutes = computed(() =>
	stories.value.reduce((sum, story) => sum + story.minutes, 0)
)
const figures = computed(() => [
	{
		label: posts.value.length === 1 ? "dispatch" : "dispatches",
		value: String(posts.value.length)
	},
	{ label: "minutes of reading", value: String(minutes.value) },
	{ label: "since", value: posts.value.at(-1)?.date.slice(0, 4) ?? "" }
])
const cta = computed(() => ({
	label: "Read the latest dispatch",
	detail: latest.value?.post.title ?? "",
	to: latest.value ? `/blog/${latest.value.post.slug}` : "/blog"
}))
const secondary = { label: "Browse every dispatch", to: { query: { page: 2 } } }
</script>

<template>
  <Pager :items label="Articles">
    <template #item="{ item }">
      <SectionLanding
        v-if='item.kind === "landing"'
        kicker="dispatches"
        title="The Blog"
        standfirst="Long-form writing on philosophy, science and history: how ideas met the tools of their time, and what came of it."
        :figures
        :cta
        :secondary
        :wide>
        <figure v-if="wide && latest?.plate" class="LandingPlate">
          <img :src="latest.plate.src" alt="" decoding="async" />
          <figcaption>{{ latest.plate.caption }}</figcaption>
        </figure>
        <nav class="Contents" aria-label="Contents">
          <p class="ContentsTitle">
            <span class="Mark" aria-hidden="true">§</span> Contents
          </p>
          <RouterLink
            v-for="story of stories"
            :key="story.post.slug"
            class="Entry"
            :to="`/blog/${story.post.slug}`"
            data-row
            :data-label="story.post.title">
            <span class="EntryNumber">{{
              String(story.number).padStart(3, "0")
            }}</span>
            <span class="EntryTitle">{{ story.post.title }}</span>
            <span class="EntryMeta">{{ formatDate(story.post.date) }} · {{
                story.minutes
              }} min</span>
          </RouterLink>
        </nav>
      </SectionLanding>

      <article v-else class="Story" :class="{ Lead: item.lead }">
        <RouterLink
          v-if="item.lead && item.plate"
          class="Plate"
          :to="`/blog/${item.post.slug}`"
          tabindex="-1"
          aria-hidden="true">
          <img :src="item.plate.src" alt="" decoding="async" />
          <span class="Credit">{{ item.plate.caption }}</span>
        </RouterLink>

        <div class="Copy">
          <p v-if="item.lead" class="Masthead" aria-hidden="true">
            <span class="Numeral display-accent">{{
              String(item.number).padStart(3, "0")
            }}</span>
            <span class="Latest">the latest<br />dispatch</span>
          </p>
          <p class="Kicker">
            <span class="Issue">no. {{
                String(item.number).padStart(3, "0")
              }}</span>
            <span class="Dot" aria-hidden="true">·</span>
            <time :datetime="item.post.date">{{
              formatDate(item.post.date)
            }}</time>
            <span class="Dot" aria-hidden="true">·</span>
            <span>{{ item.minutes }} min read</span>
          </p>

          <RouterLink
            class="Headline"
            :to="`/blog/${item.post.slug}`"
            data-row
            :data-label="item.post.title">
            <span class="Title display">{{ item.post.title }}</span>
          </RouterLink>

          <p class="Standfirst">{{ item.post.description }}</p>

          <p class="Tags">
            <span v-for="tag of item.post.tags" :key="tag">#{{ tag }}</span>
          </p>

          <p class="Actions">
            <RouterLink
              class="Read"
              :to="`/blog/${item.post.slug}`"
              :data-row="item.lead ? true : undefined"
              :data-cursor-home="item.lead ? true : undefined"
              :data-label="item.lead ? `read: ${item.post.title}` : undefined"
              :tabindex="item.lead ? undefined : -1">
              read the dispatch <span aria-hidden="true">→</span>
            </RouterLink>
            <FavouriteButton :slug="item.post.slug" />
          </p>
        </div>
      </article>
    </template>
  </Pager>
</template>

<style scoped>
.Story {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
  padding-block: var(--spacing_fluid-tight-space-tight-m);
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
}

/*
 * The lead story fills its screen: the plate takes the left of the spread and
 * the copy the right, both as tall as the page, so the screen reads as a front
 * page rather than a row at the top of an empty one.
 */
/*
 * The lead story is a spread: the plate on the left-hand page, the copy on the
 * right, with the pager's gutter between them so the fold falls between the two.
 */
.Story.Lead {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--spacing_fluid-column-space-column-s);
  min-height: var(--page-height);
  padding: 0;
  border: 0;
}

.Plate {
  position: relative;
  display: block;
  min-height: 14rem;
  overflow: hidden;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background: var(--sunk);
}

.Plate img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: grayscale(0.35) contrast(1.05);
  transition: filter 400ms ease;
}

.Plate .Credit {
  position: absolute;
  inset-inline: 0;
  bottom: 0;
  padding: 2.5rem 0.9rem 0.7rem;
  background: linear-gradient(transparent, rgb(0 0 0 / 70%));
  color: oklch(92% 0.01 90);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.06em;
}

.Copy {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
}

/*
 * The copy is set like a cover: the issue's number large at the top, the story
 * low on the page under a rule.
 */
.Lead .Copy {
  justify-content: flex-end;
  padding-bottom: var(--spacing_fluid-tight-space-tight-s);
}

.Masthead {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing_fluid-tight-space-tight-l);
  margin-bottom: auto;
}

.Numeral {
  font-size: clamp(3.5rem, 1.5rem + 5vw, 7rem);
  line-height: 0.85;
}

.Latest {
  padding-bottom: 0.6rem;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.16em;
  line-height: 1.5;
  text-transform: uppercase;
}

.Lead .Kicker {
  padding-top: var(--spacing_fluid-tight-space-tight-m);
  border-top: var(--spacing-size-rule) double var(--rule-strong);
}

.Kicker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing_fluid-tight-space-tight-s);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Issue {
  color: var(--accent);
}

.Dot {
  color: var(--faint);
}

.Headline {
  display: block;
  padding: 0.15rem 0.4rem 0.25rem;
  margin-inline: -0.4rem;
}

.Title {
  display: block;
  font-size: var(--typography_fluid-display-font-size-display-s);
  line-height: 1.1;
  text-wrap: balance;
}

.Lead .Title {
  font-size: var(--typography_fluid-display-font-size-display-m);
  line-height: 1.04;
}

.Standfirst {
  max-width: 62ch;
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-m);
  line-height: 1.55;
  text-wrap: pretty;
}

.Lead .Standfirst {
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-l);
}

.Tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing_fluid-tight-space-tight-m);
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.04em;
}

.Actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-m);
  padding-top: var(--spacing_fluid-tight-space-tight-s);
}

.Read {
  color: var(--accent);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

/* The lead story's "read" is the way into it, so it is set as the call to action. */
.Lead .Read {
  display: inline-flex;
  align-items: center;
  gap: 0.8em;
  padding: var(--spacing_fluid-tight-space-tight-m)
    var(--spacing_fluid-tight-space-tight-xl);
  border: var(--spacing-size-rule) solid var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
  font-size: var(--typography_fluid-content-font-size-m);
  font-weight: var(--typography-weight-body-bold);
}

.Lead .Read[data-cursor="true"] {
  background: var(--paper);
  box-shadow: none;
  color: var(--accent);
}

/* The landing's right-hand page: the latest plate, then the contents. */
.LandingPlate {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  min-height: 10rem;
  margin: 0;
}

.LandingPlate img {
  flex: 1 1 0;
  width: 100%;
  min-height: 0;
  object-fit: cover;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  filter: grayscale(0.3) contrast(1.05);
}

.LandingPlate figcaption {
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.06em;
}

.Contents {
  display: flex;
  flex-direction: column;
}

.ContentsTitle {
  padding-bottom: var(--spacing_fluid-tight-space-tight-xs);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.Mark {
  color: var(--accent);
}

.Entry {
  display: grid;
  grid-template-columns: 3.4em minmax(0, 1fr);
  grid-template-areas:
    "number title"
    ". meta";
  gap: 0.1rem var(--spacing_fluid-tight-space-tight-s);
  padding-block: 0.5rem;
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
  color: var(--ink);
  text-decoration: none;
}

.EntryNumber {
  grid-area: number;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.EntryTitle {
  grid-area: title;
  font-weight: var(--typography-weight-body-bold);
}

.EntryMeta {
  grid-area: meta;
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

:global(.mouse-enabled) .Plate:hover img {
  filter: none;
}

@media (max-width: 60rem) {
  .Story.Lead {
    display: flex;
    flex-direction: column;
    gap: var(--spacing_fluid-tight-space-tight-l);
  }

  .Plate {
    flex: 1 1 0;
    min-height: 9rem;
  }

  .Lead .Copy {
    flex: none;
    padding-block: var(--spacing_fluid-tight-space-tight-l);
  }

  .Masthead {
    display: none;
  }

  .Lead .Title {
    font-size: var(--typography_fluid-display-font-size-display-m);
  }

  .Lead .Standfirst {
    font-size: var(--typography_fluid-content-font-size-m);
  }
}
</style>
