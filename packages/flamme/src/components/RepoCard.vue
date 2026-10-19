<script setup lang="ts">
/**
 * The repository card.
 *
 * A Library entry opens this rather than leaving the site: the card says what the
 * project is, and its own buttons open the repository, or its site, in a new tab.
 * `o` opens the repository, `s` the site, Esc closes.
 */
import { computed, nextTick, ref, watch } from "vue"
import { useShell } from "../shell/shell.js"

const shell = useShell()
const repo = computed(() =>
	shell.dialog?.kind === "repo" ? shell.dialog.repo : null
)
const primary = ref<HTMLButtonElement | null>(null)

const open = (url: string) => {
	window.open(url, "_blank", "noopener,noreferrer")
	shell.dialog = null
}

/** A URL as a reader would say it: no scheme, no `www.`, no trailing slash. */
const bare = (url: string) =>
	url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")

watch(repo, (value) => {
	if (value) void nextTick(() => primary.value?.focus())
})
</script>

<template>
  <div v-if="repo" class="Overlay" @click.self="shell.dialog = null">
    <div
      class="Sheet Card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="repo-name">
      <p class="Overline label">
        <span class="Mark" aria-hidden="true">#</span>
        {{ repo.shelf }}
      </p>
      <h2 id="repo-name" class="Name display">{{ repo.name }}</h2>
      <p class="Meta">
        <span>{{ repo.language }}</span>
        <template v-if="repo.archived">
          <span class="Dot" aria-hidden="true">·</span>
          <span class="Flag">archived</span>
        </template>
        <template v-if="repo.stars !== null">
          <span class="Dot" aria-hidden="true">·</span>
          <span class="Stars">★ {{ repo.stars }}</span>
        </template>
      </p>
      <p class="Description">{{ repo.description }}</p>
      <dl class="Links">
        <dt>source</dt>
        <dd>{{ bare(repo.url) }}</dd>
        <template v-if="repo.homepage">
          <dt>site</dt>
          <dd>{{ bare(repo.homepage) }}</dd>
        </template>
      </dl>
      <div class="Choices">
        <button
          ref="primary"
          type="button"
          class="Choice Primary"
          @click="open(repo.url)">
          <span class="Key" aria-hidden="true">o</span>
          Open on GitHub
        </button>
        <button
          v-if="repo.homepage"
          type="button"
          class="Choice"
          @click="open(repo.homepage)">
          <span class="Key" aria-hidden="true">s</span>
          Visit the site
        </button>
        <button type="button" class="Choice" @click="shell.dialog = null">
          <span class="Key" aria-hidden="true">esc</span>
          Close
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.Card {
  width: min(44rem, 100%);
}

.Mark {
  margin-right: 0.3em;
}

.Name {
  font-size: var(--typography_fluid-display-font-size-display-s);
  line-height: 1.12;
  overflow-wrap: anywhere;
}

.Meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-s);
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.Flag {
  color: var(--tertiary);
}

.Stars {
  color: var(--accent);
}

.Description {
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-l);
  line-height: 1.45;
  text-wrap: pretty;
}

.Links {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.15rem var(--spacing_fluid-tight-space-tight-m);
  margin: 0;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
}

.Links dt {
  color: var(--faint);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.Links dd {
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
