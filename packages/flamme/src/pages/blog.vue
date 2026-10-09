<script setup lang="ts">
/**
 * The blog index: every article, newest first, as one block per entry.
 */
import { computed } from "vue"
import { usePageQuery } from "$flamme/records/blog"

// union is not visible to this program.
const { data } = usePageQuery()

const posts = computed(() => data.value?.posts ?? [])
</script>

<template>
  <div class="Index">
    <ul class="Entries">
      <li v-for="post in posts" :key="post.slug" class="Entry">
        <a class="Link" :href="`/blog/${post.slug}`">
          <span class="Head">
            <span class="Title display">{{ post.title }}</span>
            <time class="Date" :datetime="post.date">{{ post.date }}</time>
          </span>
          <span class="Blurb">{{ post.description }}</span>
          <span class="Tags">
            <span v-for="tag in post.tags" :key="tag">#{{ tag }}</span>
          </span>
        </a>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.Entries {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 var(--spacing_fluid-column-space-column-s);
  margin: 0;
  padding: 0;
  list-style: none;
}

.Link {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  padding-block: var(--spacing_fluid-flow-space-s);
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
  color: inherit;
  text-decoration: none;
}

.Head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Title {
  font-size: var(--typography_fluid-content-font-size-l);
}

.Date,
.Tags {
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.08em;
}

.Tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Blurb {
  color: var(--muted);
}

@media (max-width: 60rem) {
  .Entries {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
