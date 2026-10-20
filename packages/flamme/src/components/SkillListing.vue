<script setup lang="ts">
/**
 * The listing of `skills/`, as the prompt prints it, and where to get in touch.
 *
 * The Skills landing's right-hand page on a spread, a page of its own on a phone.
 * Each file is a link to the skill's page.
 */
import { RouterLink, type RouteLocationRaw } from "vue-router"

defineProps<{
	skills: readonly { name: string; description: string }[]
	/** Where a skill's page is. */
	to: (name: string) => RouteLocationRaw
}>()

const PROFILE = "https://www.linkedin.com/in/emmanuel-donnet"
</script>

<template>
  <div class="Aside">
    <nav class="Listing" aria-label="The skills">
      <p class="Prompt">
        <span class="Sigil" aria-hidden="true">$</span> ls skills/
      </p>
      <RouterLink
        v-for="skill of skills"
        :key="skill.name"
        class="File"
        :to="to(skill.name)"
        data-row
        :data-label="skill.name">
        <span class="FileName">{{ skill.name }}/</span>
        <span class="FileLine">{{ skill.description }}</span>
      </RouterLink>
    </nav>
    <section class="Hire" aria-label="Get in touch">
      <p class="HireTitle">
        <span class="Sigil" aria-hidden="true">#</span> to load one
      </p>
      <p class="HireText">
        Every skill here has been used for someone. To have one used for you,
        the long record and the way to get in touch are on LinkedIn.
      </p>
      <a
        class="HireLink"
        :href="PROFILE"
        target="_blank"
        rel="noopener noreferrer"
        data-row
        data-label="get in touch on linkedin">linkedin · in/emmanuel-donnet
        ↗</a>
    </section>
  </div>
</template>

<style scoped>
/* The listing of skills/, and where to get in touch. */
.Aside {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-l);
}

.Listing {
  display: flex;
  flex-direction: column;
  padding: var(--spacing_fluid-tight-space-tight-m);
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background: var(--sunk);
}

.Prompt {
  padding-bottom: var(--spacing_fluid-tight-space-tight-xs);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
}

.Sigil {
  color: var(--accent);
}

.File {
  display: grid;
  grid-template-columns: minmax(0, 14em) minmax(0, 1fr);
  gap: var(--spacing_fluid-tight-space-tight-m);
  padding: 0.3rem 0.4rem;
  margin-inline: -0.4rem;
  color: var(--ink);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  text-decoration: none;
}

.FileName {
  overflow: hidden;
  color: var(--accent);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.FileLine {
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.Hire {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-s);
  margin-top: auto;
  padding-top: var(--spacing_fluid-tight-space-tight-m);
  border-top: var(--spacing-size-rule) double var(--rule-strong);
}

.HireTitle {
  color: var(--ink);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  font-weight: var(--typography-weight-body-bold);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.HireText {
  color: var(--muted);
  line-height: 1.55;
}

.HireLink {
  align-self: flex-start;
  padding: 0.35rem 0.5rem;
  margin-inline: -0.5rem;
  color: var(--link);
  letter-spacing: 0.06em;
}

@media (max-width: 60rem) {
  .File {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }

  .Hire {
    margin-top: 0;
  }
}
</style>
