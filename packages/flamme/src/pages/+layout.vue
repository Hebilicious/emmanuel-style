<script setup lang="ts">
/**
 * The shell, as the root layout.
 *
 * One row at the top carries the dateline, the nameplate, the sections and the
 * section name; the reading pane fills the middle; the dock holds the status row at
 * the bottom. The nameplate is centred by taking the leftover space with `flex: 1`
 * rather than by `text-align: center` on an auto-width box, which is what makes it
 * centred on the screen instead of centred between its neighbours.
 *
 * The theme class is applied by the inline script in `index.html` before the first
 * paint, so this only reacts to a later change.
 */
import { computed, onMounted, onUnmounted, ref } from "vue"
import { RouterLink, RouterView } from "vue-router"
import { useQuery } from "@flamme/vue"
import { Chrome } from "$flamme"
import ThemeSwitch from "../components/ThemeSwitch.vue"

const { data } = useQuery(Chrome)
const site = computed(() => data.value?.site ?? null)

const sections = [
	{ label: "home", href: "/", keys: "h", match: (path: string) => path === "/" },
	{ label: "library", href: "/library", keys: "l", match: (p: string) => p.startsWith("/library") },
	{ label: "blog", href: "/blog", keys: "b", match: (p: string) => p.startsWith("/blog") },
	{
		label: "experience",
		href: "/experience",
		keys: "e",
		match: (p: string) => p.startsWith("/experience")
	}
]

/** The dateline, written on mount so it is today's date in the reader's locale. */
const today = ref("")
onMounted(() => {
	today.value = new Intl.DateTimeFormat("en-GB", {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric"
	}).format(new Date())
})

const plate = computed(() => site.value?.name ?? "Emmanuel")

/* The keyboard layer owns the page, so the shortcuts are documented once here. */
const onKey = (event: KeyboardEvent) => {
	if (event.metaKey || event.ctrlKey || event.altKey) return
	const target = event.target as HTMLElement | null
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target?.isContentEditable
	)
		return
	const el = document.documentElement
	if (event.key === "t") {
		event.preventDefault()
		const dark = el.classList.contains("DarkTheme")
		el.classList.remove("LightTheme", "DarkTheme")
		el.classList.add(dark ? "LightTheme" : "DarkTheme")
	}
}
onMounted(() => document.addEventListener("keydown", onKey))
onUnmounted(() => document.removeEventListener("keydown", onKey))
</script>

<template>
  <div class="Terminal">
    <header class="Bar">
      <p class="Standing">
        <span>{{ today }}</span>
        <span class="Dot" aria-hidden="true">·</span>
        <span>earth</span>
      </p>

      <h1 class="Plate display">{{ plate }}</h1>

      <nav class="Commands" aria-label="Sections">
        <RouterLink
          v-for="section in sections"
          :key="section.href"
          :to="section.href"
          class="Command"
          :class="{ Active: section.match($route.path) }"
        >
          <span>{{ section.label }}</span>
          <sup class="Keys" aria-hidden="true">{{ section.keys }}</sup>
        </RouterLink>
      </nav>

      <ThemeSwitch />
    </header>
    <div class="Edge" aria-hidden="true" />

    <main class="Page" id="main">
      <RouterView />
    </main>

    <div class="Dock">
      <div class="Status">
        <span class="Cell">emmanuel.style · 2026</span>
        <span class="Hint">
          <span class="Key">g</span> then
          <span class="Key">h</span><span class="Key">l</span><span class="Key">b</span
          ><span class="Key">e</span><span class="Key">t</span> sections ·
          <span class="Key">n</span><span class="Key">p</span> pages ·
          <span class="Key">j</span><span class="Key">k</span> rows ·
          <span class="Key">↵</span> open
        </span>
      </div>
    </div>
  </div>
</template>
