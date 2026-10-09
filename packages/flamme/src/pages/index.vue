<script setup lang="ts">
/**
 * The front page.
 *
 * The identity sits on the left, the section index on the right, and the quote
 * spans the foot. It fills the screen: the quote row absorbs the leftover height
 * rather than the page being sized to its content, which is what left the whole page
 * stranded in the top third with dead space below it.
 *
 * `n` and `p` step the quote, because a page with nothing to paginate should still
 * answer the keys the status row advertises.
 */
import { computed, onMounted, onUnmounted, ref } from "vue"
import { useQuery } from "@flamme/vue"
import { Home } from "$flamme"

// The document is what this route loads; the page reads its own content rather than
// the site facts the layout already shows, so the handle is deliberately unused.
useQuery(Home)

const identity = ["Digital Citizen", "International Empire", "Earth Republic"]

const sections = [
	{ href: "/library", label: "library", blurb: "Open source modules, tools and templates, listed by shelf." },
	{ href: "/blog", label: "blog", blurb: "Long-form writing on philosophy, science and history." },
	{ href: "/experience", label: "experience", blurb: "Roles, education and the ledger of what came before." }
]

/** The quotes, rotated by `n` / `p` and by a timer, as the previous build did. */
const quotes = [
	{ quote: "Let no one ignorant of geometry enter here.", author: "Plato" },
	{ quote: "People dreams never end.", author: "Blackbeard" },
	{
		quote: "And you will know my name is the lord, when I lay my vengeance upon thee.",
		author: "Jules Winnfield"
	},
	{ quote: "Simplicity is the ultimate sophistication.", author: "Leonardo DaVinci" },
	{ quote: "Freedom is a pure idea.", author: "Karis Nemik" },
	{ quote: "For those who come after.", author: "Gustave" },
	{ quote: "Je pense, donc je suis.", author: "René Descartes" },
	{ quote: "These violent delights have violent ends.", author: "William Shakespeare" },
	{ quote: "In the midst of chaos, there is also opportunity.", author: "Sun Tzu" },
	{ quote: "In medio stat virtus.", author: "Loth d'Orcanie" }
]

const index = ref(0)
const current = computed(() => quotes[index.value])
let timer: ReturnType<typeof setInterval> | undefined

/** A manual step restarts the timer, so the automatic one does not undo it. */
const restart = () => {
	clearInterval(timer)
	timer = setInterval(() => {
		index.value = (index.value + 1) % quotes.length
	}, 7500)
}

const step = (delta: number) => {
	index.value = (index.value + delta + quotes.length) % quotes.length
	restart()
}

const onKey = (event: KeyboardEvent) => {
	const target = event.target as HTMLElement | null
	if (target instanceof HTMLInputElement || target?.isContentEditable) return
	if (event.metaKey || event.ctrlKey || event.altKey) return
	if (event.key === "n" || event.key === "PageDown") {
		event.preventDefault()
		step(1)
		return
	}
	if (event.key === "p" || event.key === "PageUp") {
		event.preventDefault()
		step(-1)
	}
}

onMounted(() => {
	restart()
	document.addEventListener("keydown", onKey)
})
onUnmounted(() => {
	clearInterval(timer)
	document.removeEventListener("keydown", onKey)
})
</script>

<template>
  <div class="Front">
    <section class="Identity">
      <h2 class="Name display">Emmanuel LD</h2>
      <ul class="Lines">
        <li v-for="line in identity" :key="line">{{ line }}</li>
      </ul>
      <div class="Icons">
        <a href="https://twitter.com/its_hebilicious" target="_blank" rel="noopener noreferrer">
          twitter
        </a>
        <a href="https://github.com/Hebilicious" target="_blank" rel="noopener noreferrer">github</a>
        <a
          href="https://www.linkedin.com/in/emmanuel-donnet"
          target="_blank"
          rel="noopener noreferrer"
        >
          linkedin
        </a>
      </div>
    </section>

    <nav class="Index" aria-label="Sections">
      <a v-for="section in sections" :key="section.href" class="Entry" :href="section.href">
        <span class="Label">[{{ section.label }}]</span>
        <span class="Blurb">{{ section.blurb }}</span>
        <span class="Arrow" aria-hidden="true">→</span>
      </a>
    </nav>

    <section class="Quote" aria-label="Quote">
      <p class="Key label">quote</p>
      <p class="Text">{{ current?.quote }}</p>
      <p class="Author">— {{ current?.author }}</p>
    </section>
  </div>
</template>

<style scoped>
/*
 * The front page fills the screen. The first row takes what it needs and the quote
 * row absorbs the rest, which is what makes the page read as a full screen instead
 * of a strip at the top.
 */
.Front {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  column-gap: var(--spacing_fluid-column-space-column-s);
  row-gap: var(--spacing_fluid-flow-space-m);
  align-items: start;
  flex: 1 1 auto;
  min-height: 0;
}

.Identity {
  grid-column: 1;
}

.Name {
  font-size: var(--typography_fluid-display-font-size-display-m);
  line-height: 1.05;
  text-transform: uppercase;
}

.Lines {
  margin: var(--spacing_fluid-tight-space-tight-s) 0 0;
  padding: 0;
  list-style: none;
  color: var(--muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.Icons {
  display: flex;
  gap: var(--spacing_fluid-tight-space-tight-m);
  margin-top: var(--spacing_fluid-flow-space-s);
  padding-top: var(--spacing_fluid-tight-space-tight-s);
  border-top: var(--spacing-size-hairline) solid var(--rule);
}

.Index {
  grid-column: 2;
  display: flex;
  flex-direction: column;
  padding-left: var(--spacing_fluid-column-space-column-s);
  border-left: var(--spacing-size-hairline) solid var(--rule);
}

.Entry {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--spacing_fluid-tight-space-tight-m);
  align-items: baseline;
  padding-block: var(--spacing_fluid-flow-space-s);
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
  color: inherit;
  text-decoration: none;
}

.Entry:hover .Label {
  color: var(--accent);
}

.Label {
  color: var(--muted);
}

.Arrow {
  color: var(--faint);
}

.Quote {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--spacing_fluid-tight-space-tight-s);
  padding: var(--spacing_fluid-flow-space-s);
  border: var(--spacing-size-hairline) solid var(--rule);
}

.Key {
  color: var(--accent);
}

.Text {
  font-size: var(--typography_fluid-content-font-size-l);
}

.Author {
  color: var(--muted);
}

@media (max-width: 60rem) {
  .Front {
    grid-template-columns: minmax(0, 1fr);
  }

  .Index {
    grid-column: 1;
    padding-left: 0;
    border-left: 0;
  }
}
</style>
