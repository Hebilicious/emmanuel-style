<script setup lang="ts">
/**
 * The wire: one line of news running under the masthead.
 *
 * A paper printed on the reader's own screen can say when and where it was
 * printed, so the wire's fixed end carries a clock to the second and the place the
 * browser reports, and the rest of the line runs past it: the edition, the latest
 * dispatch, what is on the shelves. Each item is a link. The line is set twice so
 * that it runs without a seam; the second copy is hidden from assistive
 * technology, and the whole line stands still for a reader who asked for reduced
 * motion or who puts the pointer on it.
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { RouterLink } from "vue-router"
import { useShell } from "../shell/shell.js"
import { useSiteIndex } from "../shell/site-index.js"

const shell = useShell()
const index = useSiteIndex()

const now = ref<Date | null>(null)
let timer = 0
onMounted(() => {
	now.value = new Date()
	timer = window.setInterval(() => (now.value = new Date()), 1000)
})
onBeforeUnmount(() => window.clearInterval(timer))

const clock = computed(() =>
	now.value === null
		? "--:--:--"
		: new Intl.DateTimeFormat("en-GB", {
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit"
			}).format(now.value)
)

/** The city of the reader's time zone, which is as near as a browser says where it is. */
const place = computed(() => {
	if (now.value === null) return ""
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
	return zone.includes("/")
		? (zone.split("/").at(-1) ?? "").replace(/_/g, " ")
		: ""
})

const ROMAN: readonly (readonly [number, string])[] = [
	[10, "X"],
	[9, "IX"],
	[5, "V"],
	[4, "IV"],
	[1, "I"]
]
const roman = (value: number): string => {
	let rest = value
	let out = ""
	for (const [amount, numeral] of ROMAN) {
		while (rest >= amount) {
			out += numeral
			rest -= amount
		}
	}
	return out
}

/** The paper started in 2020: a volume a year, a number a day. */
const edition = computed(() => {
	const date = now.value
	if (date === null) return ""
	const start = Date.UTC(date.getFullYear(), 0, 0)
	const day = Math.floor(
		(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) /
			86_400_000
	)
	return `Vol. ${roman(date.getFullYear() - 2019)} · No. ${day}`
})

interface Item {
	readonly label: string
	readonly text: string
	readonly to?: string
}

const items = computed<Item[]>(() => {
	const articles = [...index.value.articles].sort((a, b) =>
		b.date.localeCompare(a.date)
	)
	const latest = articles[0]
	const projects = index.value.projects
	const list: Item[] = [{ label: "edition", text: `Earth · ${edition.value}` }]
	if (latest)
		list.push({
			label: "latest dispatch",
			text: latest.title,
			to: `/blog/${latest.slug}`
		})
	if (projects.length > 0) {
		list.push({
			label: "on the shelves",
			text: `${projects.length} entries: ${projects
				.slice(0, 3)
				.map((project) => project.title)
				.join(", ")} and more`,
			to: "/library"
		})
	}
	if (index.value.skills.length > 0) {
		list.push({
			label: "for hire",
			text: `${index.value.skills.length} skills on file`,
			to: "/skills"
		})
	}
	if (place.value)
		list.push({ label: "printed for", text: `${place.value}, Earth` })
	list.push({
		label: "press",
		text: shell.online
			? "online · reads with the network off"
			: "offline · printing from the last edition"
	})
	return list
})
</script>

<template>
  <div class="Wire">
    <p class="Stamp">
      <span class="Pulse" aria-hidden="true"></span>
      <span class="Name">wire</span>
      <time class="Clock">{{ clock }}</time>
    </p>
    <div class="Run">
      <ul
        v-for="copy of 2"
        :key="copy"
        class="Line"
        :aria-hidden='copy === 2 ? "true" : undefined'>
        <li v-for="item of items" :key="item.label" class="Item">
          <span class="Label">{{ item.label }}</span>
          <RouterLink
            v-if="item.to"
            class="Text Link"
            :to="item.to"
            :tabindex="copy === 2 ? -1 : undefined">{{ item.text }}</RouterLink>
          <span v-else class="Text">{{ item.text }}</span>
          <span class="Sep" aria-hidden="true">◆</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.Wire {
  display: flex;
  flex: none;
  align-items: stretch;
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.12em;
  line-height: 1.9;
  text-transform: uppercase;
  white-space: nowrap;
}

/* The fixed end: the wire's name and the time to the second. */
.Stamp {
  display: flex;
  flex: none;
  align-items: center;
  gap: 0.6em;
  padding-inline: 0.7em;
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: var(--typography-weight-body-bold);
}

.Pulse {
  width: 0.5em;
  height: 0.5em;
  border-radius: 50%;
  background: currentColor;
  animation: wire-pulse 1s steps(2, jump-none) infinite;
}

.Clock {
  font-variant-numeric: tabular-nums;
  font-weight: var(--typography-weight-body-regular);
}

@keyframes wire-pulse {
  50% {
    opacity: 0.2;
  }
}

.Run {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  mask-image: linear-gradient(
    to right,
    transparent,
    #000 2rem,
    #000 calc(100% - 3rem),
    transparent
  );
}

.Line {
  display: flex;
  flex: none;
  animation: wire-run 70s linear infinite;
}

.Wire:hover .Line {
  animation-play-state: paused;
}

@keyframes wire-run {
  to {
    transform: translateX(-100%);
  }
}

.Item {
  display: flex;
  align-items: baseline;
  gap: 0.8em;
  padding-left: 1.4em;
}

.Label {
  color: var(--accent);
}

.Text {
  color: var(--muted);
}

.Link {
  text-decoration: underline;
  text-decoration-color: var(--rule-strong);
  text-decoration-thickness: var(--spacing-size-hairline);
  text-underline-offset: 0.25em;
}

:global(.mouse-enabled) .Wire .Link:hover {
  color: var(--ink);
  text-decoration-color: var(--accent);
}

.Sep {
  padding-left: 0.6em;
  color: var(--faint);
  font-size: 0.7em;
}

@media (prefers-reduced-motion: reduce) {
  .Line {
    animation: none;
  }
}

/* A short screen keeps its lines for the page. */
@media (max-height: 34rem) {
  .Wire {
    display: none;
  }
}
</style>
