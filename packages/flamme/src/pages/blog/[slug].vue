<script setup lang="ts">
/**
 * One article, as a run of spreads.
 *
 * The headline sits across the top of the first spread, and the text is set in
 * two columns under it, filled to the foot of each column and continued on the
 * next: a paragraph that does not fit is split between two lines, not pushed
 * whole to the next page. Every footnote is set at the foot of the column whose
 * text cites it, which each block knows (`noteIds`), and the pager finds the line
 * the citation sits on.
 */
import { computed, watch } from "vue"
import { RouterLink, useRoute, useRouter } from "vue-router"
import { usePageQuery } from "$flamme/records/blog__slug_"
import FavouriteButton from "../../components/FavouriteButton.vue"
import Pager from "../../components/Pager.vue"
import type { PagerItem } from "../../components/pager.js"
import type { BlockShape } from "../../content.js"
import { useShell } from "../../shell/shell.js"
import { formatDate, readingTime } from "../../utils/format.js"

const { data } = usePageQuery()
const shell = useShell()
const route = useRoute()
const router = useRouter()
const post = computed(() => data.value?.post ?? null)

/*
 * The generated `kind` is `string`, because the schema declares it as one; the
 * pipeline only emits the kinds `BlockShape` names, and this is the one place the
 * narrowing is applied.
 */
const blocks = computed(
	() => (post.value?.blocks ?? []) as unknown as BlockShape[]
)
const notes = computed(() => post.value?.notes ?? [])

interface ArticleItem extends PagerItem {
	readonly block: BlockShape
	readonly lede: boolean
	readonly figure: number | null
}

/** A short paragraph standing under a heading, as a chapter's dates do. */
const isDateline = (block: BlockShape) =>
	block.kind === "paragraph" && block.text.length <= 48

const items = computed<ArticleItem[]>(() => {
	let figures = 0
	const firstParagraph = blocks.value.findIndex(
		(block) => block.kind === "paragraph"
	)
	return blocks.value.map((block, index) => ({
		id: block.id,
		block,
		// A heading, and a one-line dateline under it (`c. 600 BC – c. 529 AD`), stay
		// with the text they introduce.
		keep:
			block.kind === "heading" ||
			(isDateline(block) && blocks.value[index - 1]?.kind === "heading"),
		// A plate keeps its caption, and a table its header, on the same page.
		atomic: block.kind === "figure" || block.kind === "table",
		lede: index === firstParagraph,
		figure: block.kind === "figure" ? (figures += 1) : null
	}))
})

const minutes = computed(() =>
	readingTime(blocks.value.map((block) => block.text))
)

watch(
	post,
	(value) => {
		if (value) document.title = `${value.title} · Emmanuel`
	},
	{ immediate: true }
)

/**
 * A plate's number, handed to its caption's `::before` as a CSS string. Kept out of the
 * template: an inline object with a quoted key is rewritten by the formatter into
 * `&quot;` entities, which the type checker cannot parse.
 */
const figureStyle = (item: ArticleItem) =>
	item.figure === null ? undefined : { "--figure-number": `'${item.figure}'` }

/*
 * A plate opens full screen, so a painting too small to read in a column can be
 * looked at. The open plate is in the address, `?figure=2`: a link opens the article
 * with it open, and the back button closes it, the way it closes any page.
 */
const figures = computed(() =>
	blocks.value.filter((block) => block.kind === "figure")
)
/** Whether this visit pushed the open figure, so closing it can step back rather than add an entry. */
let pushed = false

const zoom = (figure: number) => {
	pushed = true
	void router.push({ query: { ...route.query, figure: String(figure) } })
}

watch(
	() => [route.query["figure"], figures.value] as const,
	([value]) => {
		const number = Number(value)
		const block = Number.isInteger(number)
			? figures.value[number - 1]
			: undefined
		if (block?.image) {
			shell.dialog = {
				kind: "zoom",
				src: block.image,
				caption: block.caption ?? ""
			}
		} else if (shell.dialog?.kind === "zoom") {
			shell.dialog = null
		}
	},
	{ immediate: true }
)

watch(
	() => shell.dialog,
	(dialog, previous) => {
		if (
			dialog !== null ||
			previous?.kind !== "zoom" ||
			route.query["figure"] === undefined
		)
			return
		if (pushed) {
			pushed = false
			router.back()
		} else {
			void router.replace({ query: { ...route.query, figure: undefined } })
		}
	}
)
</script>

<template>
  <article v-if="post" class="Article">
    <Pager :items :notes label="Article">
      <template #lead>
        <header class="Head">
          <p class="Kicker">
            <RouterLink
              class="Back"
              to="/blog"
              data-row
              data-label="back to the blog">← blog</RouterLink>
            <span class="Dot" aria-hidden="true">·</span>
            <time :datetime="post.date">{{ formatDate(post.date) }}</time>
            <span class="Dot" aria-hidden="true">·</span>
            <span>{{ minutes }} min read</span>
            <span class="Tags">
              <span v-for="tag of post.tags" :key="tag" class="Tag">#{{
                  tag
                }}</span>
            </span>
            <FavouriteButton :slug="post.slug" />
          </p>
          <h2 class="Title display">{{ post.title }}</h2>
          <p class="Standfirst">{{ post.description }}</p>
        </header>
      </template>

      <template #item="{ item }">
        <div
          class="Prose"
          :class='[
          	`is-${item.block.kind}`,
          	`depth-${item.block.depth}`,
          	{ "is-lede": item.lede }
          ]'
          :style="figureStyle(item)"
          @click="item.figure !== null ? zoom(item.figure) : undefined"
          v-html="item.block.html">
        </div>
      </template>
    </Pager>
  </article>
</template>

<style scoped>
.Article {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

/*
 * The headline is a banner across the first spread: the kicker line, the title in
 * the display face, the standfirst, and a double rule under them, which is where a
 * newspaper starts the text.
 */
.Head {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr);
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

.Back {
  color: var(--accent);
}

.Dot {
  color: var(--faint);
}

.Tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing_fluid-tight-space-tight-s);
  margin-left: auto;
  color: var(--faint);
  letter-spacing: 0.04em;
  text-transform: none;
}

.Title {
  grid-area: title;
  font-size: var(--typography_fluid-display-font-size-display-m);
  line-height: 1.08;
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

@media (max-width: 60rem) {
  .Head {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }

  .Standfirst {
    padding-left: 0;
    border-left: 0;
  }

  .Tags {
    display: none;
  }

  .Kicker :deep(.Favourite) {
    margin-left: auto;
  }

  .Title {
    font-size: var(--typography_fluid-display-font-size-display-s);
  }

  .Standfirst {
    font-size: var(--typography_fluid-content-font-size-s);
  }
}
</style>
