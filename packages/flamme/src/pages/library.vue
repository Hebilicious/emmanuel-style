<script setup lang="ts">
/**
 * The Library: repositories grouped by shelf.
 *
 * A shelf heading opens a page, so the paginator always starts a shelf on a left
 * page rather than letting it begin at the foot of a right one.
 */
import { computed } from "vue"
import { usePageQuery } from "$flamme/records/library"

// union is not visible to this program.
const { data } = usePageQuery()

const shelves = computed(() => data.value?.shelves ?? [])
</script>

<template>
  <div class="Library">
    <section v-for="shelf in shelves" :key="shelf.slug" class="Shelf">
      <h2 class="ShelfTitle label">
        <span class="Mark" aria-hidden="true">#</span>
        {{ shelf.label }}
      </h2>
      <ul class="Entries">
        <li v-for="repo in shelf.repositories" :key="repo.name ?? repo.url" class="Entry">
          <a class="Link" :href="repo.url" target="_blank" rel="noopener noreferrer">
            <span class="Head">
              <span class="Repo">{{ repo.name ?? "untitled" }}</span>
              <span v-if="repo.language" class="Lang">{{ repo.language }}</span>
              <span v-if="repo.archived" class="Flag">archived</span>
              <span v-if="repo.stars !== null" class="Stars">★ {{ repo.stars }}</span>
            </span>
            <span class="Body">
              <span v-if="repo.description" class="Description">{{ repo.description }}</span>
              <span v-if="repo.homepage" class="Home">site</span>
            </span>
          </a>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.Library {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 var(--spacing_fluid-column-space-column-s);
  align-content: start;
  flex: 1 1 auto;
  min-height: 0;
}

.ShelfTitle {
  color: var(--accent);
}

.Mark {
  margin-right: 0.35em;
}

.Entries {
  margin: 0 0 var(--spacing_fluid-flow-space-s);
  padding: 0;
  list-style: none;
}

.Link {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  padding-block: var(--spacing_fluid-tight-space-tight-m);
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
  color: inherit;
  text-decoration: none;
}

.Head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-s);
}

.Repo {
  font-weight: var(--typography-weight-body-bold, 600);
}

.Lang,
.Flag,
.Stars {
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.Stars {
  margin-left: auto;
  color: var(--accent);
}

.Body {
  display: flex;
  gap: var(--spacing_fluid-tight-space-tight-m);
  color: var(--muted);
}

.Home {
  margin-left: auto;
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  text-transform: uppercase;
}

@media (max-width: 60rem) {
  .Library {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
