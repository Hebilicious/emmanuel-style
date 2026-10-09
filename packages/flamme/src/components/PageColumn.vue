<script setup lang="ts">
/**
 * One screen of a spread.
 *
 * The blocks are placed by the paginator; this component renders them and, at the
 * foot of the column, the notes the blocks on THIS page cite. That is the whole
 * point of the block model: a note belongs under the page that refers to it, not at
 * the end of the article, which is what the Astro build kept doing.
 *
 * `html` is trusted because it is produced at build time by the markdown pipeline
 * in `scripts/build-content.ts`, from files in the repository. Nothing a reader
 * supplies reaches it.
 */
import { computed } from "vue"
import type { BlockShape, NoteShape } from "../content.js"

const props = defineProps<{
	blocks: readonly BlockShape[]
	/** Every note of the article; this page's own are picked out here. */
	notes: readonly NoteShape[]
}>()

/**
 * The notes this page cites, in note order.
 *
 * Derived from the blocks rather than passed in, so the notes on a page cannot
 * drift from the citations above them.
 */
const pageNotes = computed<NoteShape[]>(() => {
	const wanted = new Set(props.blocks.flatMap((block) => block.noteIds))
	return props.notes.filter((note) => wanted.has(note.id)).sort((a, b) => a.number - b.number)
})
</script>

<template>
  <div class="Column">
    <!-- eslint-disable-next-line vue/no-v-html -- build-time markdown, see above -->
    <div
      v-for="block in blocks"
      :key="block.id"
      class="Block"
      :class="`is-${block.kind}`"
      v-html="block.html"
    />

    <section v-if="pageNotes.length > 0" class="Notes" aria-label="Notes">
      <ol>
        <li v-for="note in pageNotes" :key="note.id" :value="note.number">
          <!-- eslint-disable-next-line vue/no-v-html -- build-time markdown -->
          <span v-html="note.html" />
          <a class="Back" :href="`#${note.id}`" :aria-label="`Back to note ${note.number}`">↩</a>
        </li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.Column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  /* A column is exactly the measure the blocks were measured against. */
  width: var(--column-width, 100%);
  height: 100%;
}

/*
 * Notes belong to the page that cites them, so they are pushed to the foot of the
 * column by the margin rather than following the last paragraph immediately.
 */
.Notes {
  margin-top: auto;
  padding-top: var(--spacing_fluid-tight-space-tight-s);
  border-top: var(--spacing-size-hairline) solid var(--rule);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  line-height: 1.45;
}

.Notes ol {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  margin: 0;
  padding-left: 1.4em;
}

.Notes li::marker {
  color: var(--faint);
}

.Notes :deep(p) {
  display: inline;
  margin: 0;
}

.Back {
  margin-left: 0.3em;
  color: var(--faint);
  text-decoration: none;
}

.Back:hover {
  color: var(--accent);
}

.Block :deep(figure),
.Block :deep(img) {
  max-width: 100%;
}
</style>
