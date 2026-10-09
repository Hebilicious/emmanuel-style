<script setup lang="ts">
/**
 * Experience: the chart, the roles, and the education.
 *
 * The chart and each role take a screen of their own, which is what the paginator's
 * `wide` marking is for: they cannot share a page with anything and still be read,
 * and the badges inside a role then sit on one row instead of being split across two
 * columns.
 */
import { computed } from "vue"
import { usePageQuery } from "$flamme/records/experience"

// union is not visible to this program.
const { data } = usePageQuery()
import ExperienceChart from "../components/ExperienceChart.vue"

const roles = computed(() => data.value?.roles ?? [])
const schools = computed(() => data.value?.schools ?? [])

const formatMonth = (value: string) =>
	new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" }).format(new Date(value))

const months = (start: string, end: string | null) => {
	const from = new Date(start)
	const to = end ? new Date(end) : new Date()
	return Math.max(
		1,
		(to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())
	)
}

const duration = (count: number) =>
	count >= 12 ? `${Math.floor(count / 12)} yrs ${count % 12} mos` : `${count} mos`
</script>

<template>
  <div class="Ledger">
    <ExperienceChart :roles="roles" />

    <section class="Roles" aria-label="Roles">
      <article v-for="(role, index) in roles" :key="role.id ?? `role-${index}`" class="Role">
        <header class="RoleHead">
          <h2 class="RoleTitle display">{{ role.title }}</h2>
          <p class="Company">
            <span>{{ role.company }}</span>
            <span aria-hidden="true">·</span>
            <span>{{ role.location }}</span>
          </p>
          <p class="Span">
            <time v-if="role.start" :datetime="role.start">{{ formatMonth(role.start) }}</time>
            <span aria-hidden="true"> → </span>
            <time v-if="role.end" :datetime="role.end">{{ formatMonth(role.end) }}</time>
            <span v-else>Present</span>
            <span aria-hidden="true">·</span>
            <span v-if="role.start">{{ duration(months(role.start, role.end)) }}</span>
          </p>
        </header>

        <div class="RoleBody">
          <p class="Summary">{{ role.summary }}</p>
          <ul class="Highlights">
            <li v-for="item in role.highlights" :key="item">{{ item }}</li>
          </ul>
          <ul class="Stack">
            <li v-for="item in role.stack" :key="item" class="Tech">{{ item }}</li>
          </ul>
        </div>
      </article>
    </section>

    <section class="Education" aria-label="Education">
      <h2 class="SectionTitle label">
        <span class="Mark" aria-hidden="true">#</span>
        education
      </h2>
      <article v-for="(school, index) in schools" :key="school.id ?? `school-${index}`" class="School">
        <h3 class="Qualification">{{ school.qualification }}</h3>
        <p class="Company">
          <span>{{ school.school }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ school.location }}</span>
          <span aria-hidden="true">·</span>
          <time v-if="school.start" :datetime="school.start">{{ formatMonth(school.start) }}</time>
          <span aria-hidden="true"> → </span>
          <time v-if="school.end" :datetime="school.end">{{ formatMonth(school.end) }}</time>
          <span v-else>Present</span>
        </p>
        <p class="Summary">{{ school.summary }}</p>
      </article>
    </section>
  </div>
</template>

<style scoped>
.Ledger {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-flow-space-s);
  flex: 1 1 auto;
  min-height: 0;
}

.Roles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--spacing_fluid-flow-space-s) var(--spacing_fluid-column-space-column-s);
}

/*
 * A role is a card that fits a screen on its own. Two columns inside it (heading
 * rail and body) is what makes the badges wrap to two columns when the card is
 * squeezed, so the card is capped and the inner columns kept wide.
 */
.Role {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
  align-items: start;
  gap: var(--spacing_fluid-tight-space-tight-m);
  padding-block: var(--spacing_fluid-tight-space-tight-s);
  border-top: var(--spacing-size-hairline) solid var(--rule);
}

.RoleTitle {
  font-size: var(--typography_fluid-content-font-size-l);
}

.Company,
.Span {
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.RoleBody {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-s);
}

.Summary {
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-s);
}

.Highlights {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  margin: 0;
  padding-left: 1.1em;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
}

.Stack {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

.Tech {
  padding: 0 0.4em;
  border: var(--spacing-size-hairline) solid var(--rule);
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.Education {
  padding-top: var(--spacing_fluid-flow-space-s);
  border-top: var(--spacing-size-rule) double var(--rule-strong);
}

.SectionTitle {
  color: var(--accent);
}

.Mark {
  margin-right: 0.35em;
}

.School {
  padding-block: var(--spacing_fluid-tight-space-tight-s);
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
}

.Qualification {
  font-size: var(--typography_fluid-content-font-size-m);
}

@media (max-width: 60rem) {
  .Roles {
    grid-template-columns: minmax(0, 1fr);
  }

  .Role {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
