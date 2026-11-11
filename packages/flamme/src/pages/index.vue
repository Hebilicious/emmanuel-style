<script setup lang="ts">
/**
 * The front page.
 *
 * Laid out as a front page is. On a spread, the left-hand page carries the
 * identity, a quote and the latest dispatch; the right-hand page leads with the
 * Library, the story of the edition, set large with its covers and the way in,
 * which is where the cursor starts; the index of the other sections is under it.
 * On a phone the Library comes straight after the identity, and the quote, kept
 * small, comes last. It goes through the pager like every other route, so a screen
 * too short for the whole of it becomes pages instead of being cut off at the dock.
 *
 * When the whole page fits one screen, `n` and `p` step the quote instead, as the
 * dock says; with more than one screen they turn the page.
 */
import { useMediaQuery } from "@vueuse/core"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { RouterLink } from "vue-router"
import { usePageQuery } from "$flamme/records/index"
import CoverDeck from "../components/CoverDeck.vue"
import Icon from "../components/Icon.vue"
import Pager from "../components/Pager.vue"
import type { PagerHandle, PagerItem } from "../components/pager.js"
import { useShell } from "../shell/shell.js"
import { formatDate } from "../utils/format.js"

const { data } = usePageQuery()
const shell = useShell()

const latest = computed(
	() =>
		[...(data.value?.posts ?? [])].sort((a, b) =>
			b.date.localeCompare(a.date)
		)[0] ?? null
)
const plate = computed(
	() =>
		latest.value?.blocks?.find(
			(block) => block.kind === "figure" && block.image
		) ?? null
)
const tagline = computed(() => data.value?.site?.tagline ?? "")

const identity = ["Digital Citizen", "International Empire", "Earth Republic"]

const links = [
	{
		label: "github",
		href: "https://github.com/Hebilicious",
		icon: "github" as const,
		handle: "Hebilicious"
	},
	{
		label: "twitter",
		href: "https://twitter.com/its_hebilicious",
		icon: "twitter" as const,
		handle: "its_hebilicious"
	},
	{
		label: "linkedin",
		href: "https://www.linkedin.com/in/emmanuel-donnet",
		icon: "linkedin" as const,
		handle: "emmanuel-donnet"
	}
]

/** The Library, as the front page leads with it: its featured covers, and its figures. */
const projects = computed(() =>
	(data.value?.shelves ?? []).flatMap((shelf) => shelf.projects ?? [])
)
const featured = computed(() =>
	projects.value
		.filter((project) => project.featured !== null)
		.sort((a, b) => (a.featured ?? 0) - (b.featured ?? 0))
)
const merged = computed(() =>
	projects.value.reduce((sum, project) => sum + (project.contributions ?? 0), 0)
)
const own = computed(
	() => projects.value.filter((project) => project.kind === "project").length
)

const sections = [
	{
		href: "/blog",
		label: "blog",
		key: "b",
		blurb: "Long-form writing on philosophy, science and history."
	},
	{
		href: "/experience",
		label: "experience",
		key: "e",
		blurb: "Roles, education and the ledger of what came before."
	},
	{
		href: "/skills",
		label: "skills",
		key: "s",
		blurb: "What I do well, and the proof, filed as agent skills."
	}
]

const quotes = [
	{ quote: "Let no one ignorant of geometry enter here.", author: "Plato" },
	{ quote: "People's dreams never end.", author: "Blackbeard" },
	{
		quote:
			"And you will know my name is the Lord, when I lay my vengeance upon thee.",
		author: "Jules Winnfield"
	},
	{
		quote: "Simplicity is the ultimate sophistication.",
		author: "Leonardo da Vinci"
	},
	{
		quote:
			"One Ring to rule them all, One Ring to find them, One Ring to bring them all and in the darkness bind them.",
		author: "J.R.R. Tolkien"
	},
	{ quote: "Freedom is a pure idea.", author: "Karis Nemik" },
	{ quote: "For those who come after.", author: "Gustave" },
	{ quote: "Je pense, donc je suis.", author: "René Descartes" },
	{
		quote: "These violent delights have violent ends.",
		author: "William Shakespeare"
	},
	{
		quote: "Anything that man can imagine is a possibility in reality.",
		author: "Willy Karen"
	},
	{ quote: "In medio stat virtus.", author: "Loth d'Orcanie" },
	{
		quote: "In the midst of chaos, there is also opportunity.",
		author: "Sun Tzu"
	},
	{
		quote:
			"The divine gift does not come from a higher power, but from our own minds.",
		author: "Robert Ford"
	},
	{
		quote: "Rien ne se perd, rien ne se crée, tout se transforme.",
		author: "Antoine Lavoisier"
	}
]

const quote = ref(0)
/** The plate in front of the Library's deck; it steps on with the quote's clock. */
const plate3d = ref(0)
let timer = 0
let deckTimer = 0
const stepDeck = () => {
	if (featured.value.length > 0)
		plate3d.value = (plate3d.value + 1) % featured.value.length
}

/** A step by hand restarts the rotation, so the timer does not undo it a moment later. */
const restart = () => {
	window.clearInterval(timer)
	timer = window.setInterval(() => {
		quote.value = (quote.value + 1) % quotes.length
	}, 8000)
}

const step = (delta: number) => {
	quote.value = (quote.value + delta + quotes.length) % quotes.length
	restart()
}

const pager = ref<PagerHandle | null>(null)
const screens = ref(1)

/** One screen: `n` and `p` step the quote. More than one: they turn the page. */
const quoteTurner = {
	turn: (delta: number) =>
		screens.value > 1 ? pager.value?.turn(delta) : step(delta),
	go: (target: number) => pager.value?.go(target)
}

const onLayout = (total: number) => {
	screens.value = total
	shell.turnLabel = total > 1 ? "pages" : "quotes"
	shell.turner = quoteTurner
}

onMounted(() => {
	restart()
	shell.turner = quoteTurner
	if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches)
		deckTimer = window.setInterval(stepDeck, 3800)
})

onBeforeUnmount(() => {
	window.clearInterval(timer)
	window.clearInterval(deckTimer)
	if (shell.turner === quoteTurner) shell.turner = null
})

/*
 * On a spread the index opens the right-hand column, beside the identity. On a
 * phone there is one column, and forcing a page there would only strand the quote
 * on a page of its own.
 */
const spread = useMediaQuery("(min-width: 60rem)")

/*
 * A spread: the identity and the index of the edition on the left page, the index
 * growing into it; the Library on the right page, growing into it, and the quote
 * under it. The latest dispatch is the blog's row of the index there. A phone: the
 * Library straight after the identity, the latest dispatch with its plate after
 * the index, the quote last.
 */
type FrontItem = PagerItem & { readonly parts: readonly string[] }

const items = computed<FrontItem[]>(() =>
	spread.value
		? [
				// Each page is one block, set smaller when the screen is short (`fit`), so the
				// front page is always exactly one spread.
				{ id: "left", parts: ["identity", "index"], fit: true, grow: true },
				{
					id: "right",
					parts: ["library", "quote"],
					opens: true,
					fit: true,
					grow: true
				}
			]
		: [
				// The first page of a phone is who and the Library, set to fit it whatever its size.
				{ id: "first", parts: ["identity", "library"], fit: true, grow: true },
				{ id: "index", parts: ["index"], atomic: true },
				...(latest.value
					? [{ id: "latest", parts: ["latest"], atomic: true }]
					: []),
				{ id: "quote", parts: ["quote"], atomic: true }
			]
)

/** The blog's row of the index names the latest dispatch. */
const blurbOf = (section: (typeof sections)[number]) =>
	section.href === "/blog" && latest.value
		? `Latest: ${latest.value.title}`
		: section.blurb
</script>

<template>
  <Pager
    ref="pager"
    :items
    label="Front page"
    :turns="false"
    @layout="onLayout">
    <template #item="{ item }">
      <div class="Parts">
        <template v-for="part of item.parts" :key="part">
          <section v-if='part === "identity"' class="Identity" aria-label="Who">
            <figure class="Portrait">
              <span class="Window" data-relief="/images/Profile.webp">
                <img
                  class="Photo"
                  src="/images/Profile.webp"
                  width="460"
                  height="460"
                  alt="Emmanuel"
                  decoding="async"
                />
              </span>
              <figcaption class="Live" aria-hidden="true">
                <span class="Pulse"></span> fig. 1 · live plate
              </figcaption>
            </figure>
            <div class="Who">
              <h2 class="Name display">Emmanuel LD</h2>
              <ul class="Lines">
                <li v-for="line of identity" :key="line">{{ line }}</li>
              </ul>
            </div>
            <p v-if="tagline" class="Tagline">{{ tagline }}</p>
            <ul class="Links">
              <li v-for="link of links" :key="link.label">
                <a
                  class="Link"
                  :href="link.href"
                  target="_blank"
                  rel="noopener noreferrer"
                  data-row
                  :data-label="link.label">
                  <Icon :name="link.icon" />
                  <span class="Handle">{{ link.label }}</span>
                  <span class="Out" aria-hidden="true">↗</span>
                </a>
              </li>
            </ul>
          </section>

          <section
            v-else-if='part === "quote"'
            class="Quote"
            aria-label="Quote"
            aria-live="polite">
            <p class="Overline label">
              <span>quote</span>
              <span class="Next" aria-hidden="true"><span
                  class="Key">n</span><span class="Key">p</span> another</span>
              <span class="Count">{{ String(quote + 1).padStart(2, "0") }} / {{
                  quotes.length
                }}</span>
            </p>
            <!--
          Every quote is laid out in the same box and only the current one is shown,
          so the block does not change height (and re-paginate the page) every eight
          seconds.
        -->
            <div class="Stack">
              <blockquote
                v-for="(entry, index) of quotes"
                :key="entry.author"
                class="Words"
                :class="{ Shown: index === quote }"
                :aria-hidden="index !== quote">
                <p class="Text">“{{ entry.quote }}”</p>
                <footer class="Author">— {{ entry.author }}</footer>
              </blockquote>
            </div>
          </section>

          <section
            v-else-if='part === "library"'
            class="Library"
            aria-label="The Library">
            <p class="Overline label">
              <span>the story of the edition</span>
              <span class="Count">{{ projects.length }} entries</span>
            </p>
            <CoverDeck class="Covers" :projects="featured" :active="plate3d" />
            <h2 class="LibraryTitle display">The Library</h2>
            <p class="LibraryStandfirst">
              {{ own }} projects built end to end, Nuxt modules, tools, and {{
                merged
              }}
              pull requests merged into other people's code.
            </p>
            <RouterLink
              class="Open"
              to="/library"
              data-row
              data-cursor-home
              data-label="open the library">
              <span>Open the Library</span>
              <span class="OpenArrow" aria-hidden="true">→</span>
            </RouterLink>
          </section>

          <nav v-else-if='part === "index"' class="Index" aria-label="Sections">
            <p class="Overline label">in this edition</p>
            <RouterLink
              v-for="section of sections"
              :key="section.href"
              class="Entry"
              :to="section.href"
              data-row
              :data-label="section.label">
              <span class="Label">[{{ section.label }}]</span>
              <span class="Blurb">{{ blurbOf(section) }}</span>
              <span class="Shortcut" aria-hidden="true"><span
                  class="Key">g</span><span class="Key">{{
                  section.key
                }}</span></span>
            </RouterLink>
          </nav>

          <article v-else-if="latest" class="Latest">
            <p class="Overline label">latest dispatch</p>
            <RouterLink
              class="Story"
              :to="`/blog/${latest.slug}`"
              data-row
              :data-label="latest.title">
              <span v-if="plate?.image" class="Thumb">
                <img :src="plate.image" alt="" decoding="async" />
              </span>
              <span class="Copy">
                <time class="Date" :datetime="latest.date">{{
                  formatDate(latest.date)
                }}</time>
                <span class="Title display">{{ latest.title }}</span>
                <span class="Standfirst">{{ latest.description }}</span>
                <span class="Read">read <span
                    aria-hidden="true">→</span></span>
              </span>
            </RouterLink>
          </article>
        </template>
      </div>
    </template>
  </Pager>
</template>

<style scoped>
/* The parts of one page, one under the other; the index and the Library take what is left. */
.Parts {
  display: flex;
  flex-direction: column;
  gap: var(--block-gap, 0.85rem);
}

.Parts > .Index,
.Parts > .Library {
  flex: 1 1 auto;
}

.Overline {
  display: flex;
  justify-content: space-between;
  color: var(--accent);
}

/* The identity: a newspaper cut of the portrait, the name, and where to find him. */
.Identity {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto 1fr;
  grid-template-areas:
    "portrait who"
    "portrait tagline"
    "portrait links";
  align-items: start;
  gap: var(--spacing_fluid-tight-space-tight-l)
    var(--spacing_fluid-column-space-column-s);
  padding-bottom: var(--spacing_fluid-flow-space-s);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
}

/*
 * The portrait's plate. The press draws the portrait in it in relief, a field of
 * halftone dots that turns with the pointer; the photograph under it is what shows
 * until the press has printed it, and where there is no press.
 */
.Portrait {
  grid-area: portrait;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: clamp(6.5rem, 1rem + 15vw, 17rem);
  margin: 0;
}

.Window {
  position: relative;
  display: block;
  aspect-ratio: 1;
  overflow: hidden;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  outline: var(--spacing-size-hairline) solid var(--rule);
  outline-offset: 4px;
  background: var(--sunk);
}

.Photo {
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: grayscale(1) contrast(1.15);
  transition: opacity 500ms linear;
}

:global(:root[data-relief-shown]) .Photo {
  opacity: 0;
}

/* The tag in the plate's corner, once the press is drawing it: this picture moves. */
.Live {
  display: flex;
  align-items: center;
  gap: 0.5em;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0;
  transition: opacity 400ms linear 600ms;
}

:global(:root[data-relief-shown]) .Live {
  opacity: 1;
}

.Pulse {
  width: 0.5em;
  height: 0.5em;
  border-radius: 50%;
  background: var(--accent);
  animation: live-pulse 1.6s ease-in-out infinite;
}

@keyframes live-pulse {
  50% {
    opacity: 0.25;
  }
}

.Who {
  grid-area: who;
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
  min-width: 0;
}

/* As large as the column allows: on a tablet the full size broke the name in two. */
.Name {
  font-size: clamp(
    1.6rem,
    3.5vw,
    var(--typography_fluid-display-font-size-display-l)
  );
  line-height: 1;
  text-transform: uppercase;
  white-space: nowrap;
}

.Lines {
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  letter-spacing: 0.14em;
  line-height: 1.55;
  text-transform: uppercase;
}

.Tagline {
  grid-area: tagline;
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-m);
  line-height: 1.45;
  text-wrap: balance;
}

.Links {
  grid-area: links;
  align-self: end;
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing_fluid-tight-space-tight-xs)
    var(--spacing_fluid-tight-space-tight-l);
}

.Link {
  display: inline-flex;
  align-items: center;
  gap: 0.55em;
  padding: 0.2rem 0.4rem;
  margin-inline: -0.4rem;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  letter-spacing: 0.08em;
}

.Link :deep(svg) {
  width: 1.05rem;
  height: 1.05rem;
  color: var(--accent);
}

.Out {
  color: var(--faint);
  font-size: 0.85em;
}

:global(.mouse-enabled) .Link:hover {
  color: var(--ink);
}

/* The quote: set like a pull quote, in the accent's rule. */
/* The label at the top, the words in the middle of what is left, the hint at the foot. */
.Quote {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  padding: var(--spacing_fluid-tight-space-tight-s)
    var(--spacing_fluid-tight-space-tight-m);
  border-left: var(--spacing-size-rule) solid var(--accent);
  background: var(--surface);
}

.Quote .Overline {
  display: flex;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Quote .Next {
  margin-left: auto;
}

.Count {
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}

/*
 * The quote is a small thing on this page, a strip of two lines. The quotes are
 * out of the flow, all in one box, so the strip keeps its height while they
 * rotate, and the words are set to the room it has (`cqh` is its height, `cqi`
 * its width).
 */
.Stack {
  position: relative;
  flex: 1 1 auto;
  min-height: 4.6rem;
  container-type: size;
}

.Next {
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Next .Key {
  margin-right: 0;
}

.Next .Key + .Key {
  margin-right: 0.6em;
}

/* A phone turns with a swipe or the dock's arrows, and has no keys to press. */
@media (hover: none) and (pointer: coarse) {
  .Next,
  .Shortcut {
    display: none;
  }
}

.Words {
  position: absolute;
  inset: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.2rem;
  margin: 0;
  visibility: hidden;
  opacity: 0;
  transform: translateY(0.4rem);
  transition:
    opacity 600ms ease,
    transform 600ms ease,
    visibility 0s linear 600ms;
}

.Words.Shown {
  visibility: visible;
  opacity: 1;
  transform: none;
  transition: opacity 600ms ease, transform 600ms ease;
}

.Text {
  color: var(--ink);
  /* Three lines and the author fit the strip whatever the quote: about five lines of height. */
  font-size: clamp(
    0.8rem,
    min(3.6cqi, 19cqh),
    var(--typography_fluid-content-font-size-m)
  );
  line-height: 1.35;
  text-wrap: balance;
}

.Author {
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

/*
 * The Library leads the edition: its covers in a strip, the lead project's widest,
 * its name in the display face, its figures, and the way in, which is where the
 * cursor starts. On a spread it grows into the right-hand page, the covers taking
 * the room.
 */
.Library {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Library .Overline {
  display: flex;
  justify-content: space-between;
  padding-bottom: var(--spacing_fluid-tight-space-tight-xs);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
}

/* The deck of plates takes the room the text under it leaves. */
.Covers {
  flex: 1 1 0;
  min-height: 9rem;
}

.LibraryTitle {
  font-size: var(--typography_fluid-display-font-size-display-l);
  line-height: 1;
}

.LibraryStandfirst {
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-l);
  line-height: 1.4;
  text-wrap: pretty;
}

.Open {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing_fluid-tight-space-tight-m)
    var(--spacing_fluid-flow-space-s);
  border: var(--spacing-size-rule) solid var(--accent);
  background: var(--accent);
  color: var(--accent-ink);
  font-size: var(--typography_fluid-content-font-size-l);
  font-weight: var(--typography-weight-body-bold);
  letter-spacing: 0.08em;
  text-decoration: none;
  text-transform: uppercase;
}

.OpenArrow {
  font-size: 1.4em;
  line-height: 1;
  transition: transform 200ms ease;
}

.Open[data-cursor="true"] {
  background: var(--paper);
  box-shadow: none;
  color: var(--accent);
}

.Open[data-cursor="true"] .OpenArrow {
  transform: translateX(0.3em);
}

@media (hover: none) and (pointer: coarse) {
  .Open[data-cursor="true"] {
    background: var(--accent);
    color: var(--accent-ink);
  }
}

/* The index of the edition: one row per section, with its shortcut. */
.Index {
  display: flex;
  flex-direction: column;
}

.Index .Overline {
  padding-bottom: var(--spacing_fluid-tight-space-tight-s);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
}

/* On a spread the index grows into the left-hand page, its rows sharing the height. */
.Entry {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: 12ch minmax(0, 1fr) auto;
  align-content: center;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-l);
  padding: var(--spacing_fluid-tight-space-tight-s) 0.6rem;
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
}

/* A laptop's screen is short: the index and the Library tighten, so the front page stays one spread. */
@media (min-width: 60rem) and (max-height: 52rem) {
  .Portrait {
    width: clamp(6rem, 24vh, 12rem);
  }

  .Identity {
    padding-bottom: var(--spacing_fluid-tight-space-tight-l);
  }

  .Covers {
    min-height: 5rem;
  }

  .LibraryStandfirst {
    font-size: var(--typography_fluid-content-font-size-m);
  }

  .Entry {
    padding-block: var(--spacing_fluid-tight-space-tight-s);
  }

  .Blurb {
    font-size: var(--typography_fluid-content-font-size-s);
  }

  .Thumb {
    min-height: 6rem;
  }
}

.Label {
  color: var(--accent);
}

/* Two lines at most, so a long headline does not push the page onto a second spread. */
.Blurb {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  color: var(--ink);
  line-height: 1.5;
}

.Shortcut {
  display: inline-flex;
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  text-transform: uppercase;
}

.Key {
  min-width: 1.6em;
  padding: 0 0.3em;
  border: var(--spacing-size-hairline) solid var(--rule);
  border-bottom-width: 2px;
  color: var(--muted);
  text-align: center;
}

.Key + .Key {
  margin-left: -1px;
}

/* The latest dispatch, as the front page's second story. */
.Latest {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Story {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1fr);
  gap: var(--spacing_fluid-tight-space-tight-l);
  padding: 0.6rem;
  margin-inline: -0.6rem;
}

.Thumb {
  position: relative;
  display: block;
  min-height: 9rem;
  overflow: hidden;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background: var(--sunk);
}

.Thumb img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: grayscale(0.4) contrast(1.05);
}

.Copy {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--spacing_fluid-tight-space-tight-s);
}

.Date {
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

/*
 * The latest story shares the right-hand page with the index. Its headline and its
 * standfirst are held to a few lines, so a long title does not push the story, and
 * the front page with it, onto a second spread; the article has them in full.
 */
.Title {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  font-size: var(--typography_fluid-display-font-size-display-s);
  line-height: 1.1;
  text-wrap: balance;
}

.Standfirst {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-s);
  line-height: 1.5;
}

.Read {
  color: var(--accent);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

@media (max-width: 60rem) {
  .LibraryTitle {
    font-size: var(--typography_fluid-display-font-size-display-m);
  }

  .LibraryStandfirst {
    font-size: var(--typography_fluid-content-font-size-m);
  }

  .Covers {
    min-height: 8rem;
  }

  .Identity {
    gap: var(--spacing_fluid-tight-space-tight-m)
      var(--spacing_fluid-tight-space-tight-l);
    padding-bottom: var(--spacing_fluid-tight-space-tight-l);
  }

  .Identity {
    grid-template-rows: auto;
    grid-template-areas:
      "portrait who"
      "tagline tagline"
      "links links";
    align-items: center;
  }

  .Portrait {
    width: 6.5rem;
  }

  .Tagline {
    font-size: var(--typography_fluid-content-font-size-m);
  }

  .Live {
    display: none;
  }

  .Name {
    font-size: clamp(
      1.6rem,
      8vw,
      var(--typography_fluid-display-font-size-display-m)
    );
  }

  .Lines {
    font-size: var(--typography_fluid-micro-font-size-micro-m);
  }

  .Tagline {
    font-size: var(--typography_fluid-content-font-size-m);
  }

  .Links {
    flex-wrap: nowrap;
    gap: var(--spacing_fluid-tight-space-tight-l);
  }

  .Link {
    font-size: var(--typography_fluid-micro-font-size-micro-m);
  }

  .Quote {
    gap: var(--spacing_fluid-tight-space-tight-m);
    padding: var(--spacing_fluid-tight-space-tight-l);
  }

  .Text {
    font-size: var(--typography_fluid-content-font-size-m);
  }

  .Entry {
    grid-template-columns: minmax(0, 1fr) auto;
    row-gap: 0.2rem;
  }

  .Blurb {
    grid-column: 1 / -1;
    grid-row: 2;
    color: var(--muted);
    font-size: var(--typography_fluid-content-font-size-s);
  }

  .Story {
    grid-template-columns: minmax(0, 1fr);
  }

  .Thumb {
    min-height: 7.5rem;
  }
}
</style>
