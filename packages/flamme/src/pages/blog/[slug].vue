<script setup lang="ts">
/**
 * One article, as a spread of screens.
 *
 * The document asks for the article's blocks and its notes separately. Nothing
 * decides here which note belongs to which page: each block already carries the
 * notes it cites (`noteIds`), so the reader places each note under the page that
 * refers to it. That is what the Astro build could not do, and why its footnotes
 * ended up at the end of the article.
 */
import { computed } from "vue"
import { usePageQuery } from "$flamme/records/blog__slug_"
import Reader from "../../components/Reader.vue"
import type { BlockShape, NoteShape } from "../../content.js"

const { data } = usePageQuery()
const post = computed(() => data.value?.post ?? null)

/*
 * The generated `kind` is `string`, because the schema declares it as one; the pipeline
 * only ever emits the kinds `BlockShape` names, and this is the single boundary where
 * that narrowing is applied. A null list is an empty one.
 */
const blocks = computed(() => (post.value?.blocks ?? []) as unknown as BlockShape[])
const notes = computed(() => (post.value?.notes ?? []) as unknown as NoteShape[])
</script>

<template>
  <article v-if="post" class="Post">
    <header class="Head">
      <p class="Kicker">
        <a class="Back" href="/blog">← blog</a>
        <span class="Sep" aria-hidden="true">·</span>
        <time :datetime="post.date">{{ post.date }}</time>
      </p>
      <h1 class="Title display">{{ post.title }}</h1>
      <p class="Standfirst">{{ post.description }}</p>
    </header>

    <Reader :blocks="blocks" :notes="notes" />
  </article>
</template>

<style scoped>
.Post {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

/*
 * The header is a banner across the top of the spread, not a band eaten out of the
 * columns: it is short on purpose, because its height is height the columns cannot
 * use and a tall header is what left the first column too short to hold a paragraph.
 *
 * The title gets the full width and the standfirst is bounded to a reading measure
 * underneath it. An `auto` second column sized itself to the standfirst, which
 * squeezed the title into five lines.
 */
.Head {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  padding-bottom: var(--spacing_fluid-tight-space-tight-s);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
}


.Kicker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing_fluid-tight-space-tight-s);
  color: var(--muted);
}

@media (min-width: 60rem) {
  /* The back link on the left, then the separator and the date pushed to the right
     together, rather than the separator stranded in the middle of the banner. */
  .Kicker .Sep {
    margin-left: auto;
  }
}

.Back {
  color: var(--muted);
  text-decoration: none;
}

.Back:hover {
  color: var(--accent);
}

.Title {
  font-size: var(--typography_fluid-content-font-size-xl);
  line-height: 1.1;
  text-wrap: balance;
}

.Standfirst {
  max-width: 90ch;
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-s);
}

.Tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing_fluid-tight-space-tight-m);
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.08em;
}
</style>
