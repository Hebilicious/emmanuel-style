<script setup lang="ts">
/**
 * The blog: every article, newest first.
 *
 * The newest article is the lead story and takes the first screen: its opening
 * plate on one side, the headline, the standfirst and the meta on the other, the
 * way a front page sets the story it leads with. Every older article follows as
 * an entry in the columns.
 */
import { computed } from "vue"
import { RouterLink } from "vue-router"
import { usePageQuery } from "$flamme/records/blog"
import FavouriteButton from "../components/FavouriteButton.vue"
import Pager from "../components/Pager.vue"
import type { PagerItem } from "../components/pager.js"
import { formatDate, readingTime } from "../utils/format.js"

const { data } = usePageQuery()

const posts = computed(() =>
	[...(data.value?.posts ?? [])].sort((a, b) => b.date.localeCompare(a.date))
)

type Post = (typeof posts.value)[number]

interface BlogItem extends PagerItem {
	readonly post: Post
	readonly lead: boolean
	readonly plate: { src: string; caption: string } | null
	readonly minutes: number
	readonly number: number
}

const items = computed<BlogItem[]>(() =>
	posts.value.map((post, index) => {
		const figure = (post.blocks ?? []).find(
			(block) => block.kind === "figure" && block.image
		)
		return {
			id: post.slug,
			post,
			lead: index === 0,
			screen: index === 0,
			plate: figure?.image
				? { src: figure.image, caption: figure.caption ?? "" }
				: null,
			minutes: readingTime((post.blocks ?? []).map((block) => block.text)),
			number: posts.value.length - index
		}
	})
)
</script>

<template>
  <Pager :items label="Articles">
    <template #item="{ item }">
      <article class="Story" :class="{ Lead: item.lead }">
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
              tabindex="-1">
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
.Story.Lead {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
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
  font-size: clamp(4.5rem, 2rem + 8vw, 11rem);
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
  font-size: var(--typography_fluid-display-font-size-display-l);
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
