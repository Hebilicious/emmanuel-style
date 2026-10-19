<script setup lang="ts">
/**
 * Experience: the ledger.
 *
 * Every screen is composed for the spread it is printed on, so nothing a reader
 * needs runs across the fold or off the foot of a page. The first spread is the
 * overview: the chart on the left-hand page; the totals, the stack and an index of
 * the roles on the right, each row a link to the role's page. Each role then has a
 * spread of its own: its headline, its length, its place on the whole career and
 * its stack on the left; what was done, in full, on the right. The record closes
 * the ledger: education on the left, where the rest lives and the imprint on the
 * right.
 *
 * Each of those is shown whole (`fit`): when one is taller than the page it is set
 * smaller until it fits, never cut. On a phone the same blocks are stacked on one
 * page each.
 */
import { computed, ref } from "vue"
import { RouterLink } from "vue-router"
import { usePageQuery } from "$flamme/records/experience"
import ExperienceChart from "../components/ExperienceChart.vue"
import Pager from "../components/Pager.vue"
import type { PagerHandle, PagerItem } from "../components/pager.js"
import { useWide } from "../shell/wide.js"
import { formatDuration, formatMonth, monthsBetween } from "../utils/format.js"

const { data } = usePageQuery()
const wide = useWide()
const pager = ref<PagerHandle | null>(null)

const roles = computed(() =>
	[...(data.value?.roles ?? [])].sort((a, b) => b.start.localeCompare(a.start))
)
const schools = computed(() => data.value?.schools ?? [])

type Role = (typeof roles.value)[number]

const PROFILE = "https://www.linkedin.com/in/emmanuel-donnet"

const today = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "long",
	year: "numeric"
}).format(new Date())

const totalMonths = computed(() =>
	roles.value.reduce(
		(sum, role) => sum + monthsBetween(role.start, role.end),
		0
	)
)
const since = computed(() =>
	roles.value.reduce(
		(first, role) => (role.start < first ? role.start : first),
		"9999"
	)
)
const stack = computed(() => [
	...new Set(roles.value.flatMap((role) => role.stack))
])

type LedgerItem =
	| (PagerItem & { readonly kind: "chart" })
	| (PagerItem & {
			readonly kind: "role"
			readonly role: Role
			readonly number: number
	  })
	| (PagerItem & { readonly kind: "record" })

/* Every screen is one block, shown whole: across the spread on a wide screen. */
const items = computed<LedgerItem[]>(() => [
	{ id: "chart", kind: "chart", screen: wide.value, fit: true },
	...roles.value.map((role, index) => ({
		id: `role-${role.id}`,
		kind: "role" as const,
		role,
		number: index + 1,
		screen: wide.value,
		fit: true
	})),
	{ id: "record", kind: "record", screen: wide.value, fit: true }
])

/** The page a role is on, for the index; known once the pager has laid out. */
const layout = ref(0)
const pageOf = (role: Role): number | null => {
	void layout.value
	const screen = pager.value?.screenOf(`role-${role.id}`) ?? -1
	return screen === -1 ? null : screen + 1
}

/** Where a role sits on the whole career, as percentages of the span from the first role to now. */
const month = (value: string) => {
	const [year = 0, m = 1] = value.split("-").map(Number)
	return year * 12 + (m - 1)
}
const career = computed(() => {
	const now = new Date()
	const end = now.getFullYear() * 12 + now.getMonth() + 1
	const start = Math.min(
		end - 1,
		...roles.value.map((role) => month(role.start))
	)
	return { start, end, span: Math.max(1, end - start) }
})
const placement = (role: Role) => {
	const { start, span } = career.value
	const from = month(role.start)
	const to = role.end === null ? career.value.end : month(role.end) + 1
	return {
		left: `${((from - start) / span) * 100}%`,
		width: `${Math.max(1.5, ((to - from) / span) * 100)}%`
	}
}
</script>

<template>
  <Pager
    ref="pager"
    :items
    label="Experience"
    @layout="layout += 1">
    <template #item="{ item }">
      <!-- The overview: the chart on the left page, the totals and the index on the right. -->
      <section
        v-if='item.kind === "chart"'
        class="Ledger Overview"
        :class="{ Spread: wide }">
        <div class="LeftPage ChartPage">
          <ExperienceChart :roles />
        </div>
        <div class="RightPage">
          <dl class="Totals">
            <div class="Total">
              <dt>roles</dt>
              <dd class="display">{{ roles.length }}</dd>
            </div>
            <div class="Total">
              <dt>in the trade</dt>
              <dd class="display">{{ formatDuration(totalMonths) }}</dd>
            </div>
            <div class="Total">
              <dt>since</dt>
              <dd class="display">{{ since.slice(0, 4) }}</dd>
            </div>
          </dl>
          <nav class="RoleIndex" aria-label="The roles">
            <h2 class="Section">
              <span class="Accent" aria-hidden="true">#</span> the roles
            </h2>
            <ol>
              <li v-for="(role, index) of roles" :key="role.id">
                <RouterLink
                  class="IndexRow"
                  :to="{ query: { page: pageOf(role) ?? undefined } }"
                  data-row
                  :data-label="`${role.title}, ${role.company}`">
                  <span class="IndexNumber">{{
                    String(index + 1).padStart(2, "0")
                  }}</span>
                  <span class="IndexRole">
                    <span class="IndexTitle">{{ role.title }}</span>
                    <span class="IndexCompany">{{ role.company }} · {{
                        formatMonth(role.start)
                      }} → {{
                        role.end ? formatMonth(role.end) : "present"
                      }}</span>
                  </span>
                  <span class="IndexAt">{{
                    pageOf(role) ? `p. ${pageOf(role)}` : ""
                  }}</span>
                </RouterLink>
              </li>
            </ol>
          </nav>
          <div class="AllStack">
            <h2 class="Section">
              <span class="Accent" aria-hidden="true">#</span> the stack
            </h2>
            <ul class="Stack">
              <li v-for="tech of stack" :key="tech" class="Tech">{{ tech }}</li>
            </ul>
          </div>
        </div>
      </section>

      <!-- A role: its headline and its facts on the left page, what was done on the right. -->
      <article
        v-else-if='item.kind === "role"'
        class="Ledger Role"
        :class="{ Spread: wide }"
        :data-label="item.role.company">
        <div class="LeftPage">
          <header class="Folio">
            <span class="Accent">role {{
                String(item.number).padStart(2, "0")
              }}</span>
            <span class="Faint">/ {{
                String(roles.length).padStart(2, "0")
              }}</span>
            <span class="Rule" aria-hidden="true"></span>
            <span class="Company Inline">
              <span class="Name">{{ item.role.company }}</span>
              <span class="Dot" aria-hidden="true">·</span>
              <span>{{ item.role.location }}</span>
            </span>
          </header>
          <h2 class="Title display">{{ item.role.title }}</h2>
          <div class="Measures">
            <p class="Numeral display-accent" aria-hidden="true">
              {{ String(item.number).padStart(2, "0") }}
            </p>
            <div class="Length">
              <p class="LengthValue display">
                {{
                  formatDuration(monthsBetween(item.role.start, item.role.end))
                }}
              </p>
              <p class="Faint Label">
                {{ item.role.end ? "in the role" : "and counting" }}
              </p>
            </div>
          </div>
          <figure
            class="Career"
            :aria-label="`${item.role.company} on the whole career`">
            <span class="Track">
              <span
                class="Span"
                :class="{ Current: !item.role.end }"
                :style="placement(item.role)"></span>
            </span>
            <figcaption class="Faint Label">
              <span>{{ since.slice(0, 4) }}</span>
              <span>now</span>
            </figcaption>
          </figure>
          <ul class="Stack" aria-label="Stack">
            <li v-for="tech of item.role.stack" :key="tech" class="Tech">
              {{ tech }}
            </li>
          </ul>
        </div>

        <div class="RightPage">
          <header class="Folio">
            <time :datetime="item.role.start">{{
              formatMonth(item.role.start)
            }}</time>
            <span aria-hidden="true">→</span>
            <time v-if="item.role.end" :datetime="item.role.end">{{
              formatMonth(item.role.end)
            }}</time>
            <span v-else class="Accent">present</span>
            <span class="Rule" aria-hidden="true"></span>
          </header>
          <p class="Summary">{{ item.role.summary }}</p>
          <ul class="Highlights">
            <li v-for="highlight of item.role.highlights" :key="highlight">
              {{ highlight }}
            </li>
          </ul>
        </div>
      </article>

      <!-- The record: education on the left page; where the rest lives, and the imprint, on the right. -->
      <section v-else class="Ledger Record" :class="{ Spread: wide }">
        <div class="LeftPage">
          <header class="Folio">
            <span class="Accent">the record</span>
            <span class="Rule" aria-hidden="true"></span>
            <span>{{ roles.length }} roles · {{
                formatDuration(totalMonths)
              }}</span>
          </header>
          <h2 class="Section">
            <span class="Accent" aria-hidden="true">#</span> education
          </h2>
          <article v-for="school of schools" :key="school.id" class="School">
            <h3 class="Degree display">{{ school.qualification }}</h3>
            <p class="Company">
              <span class="Name">{{ school.school }}</span>
              <span class="Dot" aria-hidden="true">·</span>
              <span>{{ school.location }}</span>
              <span class="Dot" aria-hidden="true">·</span>
              <span>{{ formatMonth(school.start) }} → {{
                  school.end ? formatMonth(school.end) : "present"
                }}</span>
            </p>
            <p class="SchoolSummary">{{ school.summary }}</p>
          </article>
        </div>

        <div class="RightPage">
          <h2 class="Section">
            <span class="Accent" aria-hidden="true">#</span> the full record
          </h2>
          <p class="Note">
            This ledger is the short form. The long one, with every role,
            reference and recommendation, is kept on LinkedIn; the work itself
            is in the Library and on GitHub.
          </p>
          <ul class="Links">
            <li>
              <a
                :href="PROFILE"
                target="_blank"
                rel="noopener noreferrer"
                data-row
                data-label="linkedin">
                <span class="Where">linkedin</span>
                <span class="Faint">in/emmanuel-donnet ↗</span>
              </a>
            </li>
            <li>
              <a
                href="https://github.com/Hebilicious"
                target="_blank"
                rel="noopener noreferrer"
                data-row
                data-label="github">
                <span class="Where">github</span>
                <span class="Faint">Hebilicious ↗</span>
              </a>
            </li>
          </ul>

          <footer class="Colophon">
            <p class="Imprint">
              <span class="ImprintPlate display">The Emmanuel Style</span>
              <span class="Faint">printed on {{ today }}</span>
            </p>
            <dl class="Credits">
              <div>
                <dt>set in</dt>
                <dd>Monaspace Argon &amp; Nabla</dd>
              </div>
              <div>
                <dt>built with</dt>
                <dd>Flamme, Vize &amp; Vue</dd>
              </div>
              <div>
                <dt>served by</dt>
                <dd>a worker and a service worker</dd>
              </div>
              <div>
                <dt>read with</dt>
                <dd>the keyboard, online or not</dd>
              </div>
            </dl>
          </footer>
        </div>
      </section>
    </template>
  </Pager>
</template>

<style scoped>
/*
 * A ledger sheet is one screen of the ledger (not `.Sheet`: that is the dialogs'
 * global class). On a spread it is two pages with the pager's own gutter between
 * them, so the fold falls in the gutter and never through a line; it is at least a
 * page tall, and the pager sets it smaller when it is taller. On a phone the two
 * pages stack.
 */
.Ledger {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-flow-space-s);
}

.Ledger.Spread {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: minmax(0, 1fr);
  column-gap: var(--spacing_fluid-column-space-column-s);
  min-height: var(--page-height);
}

.LeftPage,
.RightPage {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-l);
  min-width: 0;
}

/* The chart takes the whole left page. */
.ChartPage :deep(.Chart) {
  flex: 1 1 auto;
}

.Folio {
  display: flex;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-s);
  padding-bottom: var(--spacing_fluid-tight-space-tight-s);
  border-bottom: var(--spacing-size-rule) double var(--rule-strong);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.Folio .Rule {
  flex: 1;
}

.Section {
  display: flex;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-s);
  padding-bottom: var(--spacing_fluid-tight-space-tight-xs);
  border-bottom: var(--spacing-size-hairline) solid var(--rule-strong);
  color: var(--ink);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  font-weight: var(--typography-weight-body-bold);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.Dot,
.Faint {
  color: var(--faint);
}

.Accent {
  color: var(--accent);
}

.Label {
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

/* ------------------------------------------------------------- the overview */

/* The length of the career is the longest figure, so it has the widest cell. */
.Totals {
  display: grid;
  grid-template-columns: minmax(0, 0.7fr) minmax(0, 1.8fr) minmax(0, 1fr);
  margin: 0;
  border-block: var(--spacing-size-hairline) solid var(--rule);
}

.Total {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: var(--spacing_fluid-tight-space-tight-m)
    var(--spacing_fluid-tight-space-tight-m);
}

.Total + .Total {
  border-left: var(--spacing-size-hairline) solid var(--rule);
}

.Total dt {
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.Total dd {
  margin: 0;
  font-size: var(--typography_fluid-display-font-size-display-s);
  line-height: 1.1;
  white-space: nowrap;
}

.RoleIndex ol {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.IndexRow {
  display: grid;
  grid-template-columns: 2.4em minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-s);
  padding-block: 0.45rem;
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
  color: var(--ink);
  text-decoration: none;
}

.IndexNumber,
.IndexAt {
  color: var(--accent);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.IndexRole {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.IndexTitle {
  font-weight: var(--typography-weight-body-bold);
}

.IndexCompany {
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.IndexRow[data-cursor="true"] {
  box-shadow:
    inset var(--spacing-size-rule) 0 0 0 var(--accent),
    0 0 0 0.25rem var(--sunk);
}

.AllStack {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-s);
  margin-top: auto;
}

/* ------------------------------------------------------------------ a role */

.Title {
  font-size: var(--typography_fluid-display-font-size-display-l);
  line-height: 1.02;
  text-wrap: balance;
}

.Company {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-s);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.Company.Inline {
  font-size: inherit;
}

.Name {
  color: var(--accent);
  font-weight: var(--typography-weight-body-bold);
}

/* The role's number set as large as a magazine opener's, its length beside it. */
.Measures {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing_fluid-tight-space-tight-xl);
  margin-top: auto;
}

.Numeral {
  font-size: clamp(4rem, 2rem + 6vw, 9rem);
  line-height: 0.9;
}

.Length {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding-bottom: 0.4rem;
}

.LengthValue {
  font-size: var(--typography_fluid-display-font-size-display-m);
  line-height: 1.05;
}

.Stack {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.Tech {
  padding: 0.05rem 0.5rem;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

/* The whole career as one track, with this role marked on it. */
.Career {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin: 0;
}

.Career .Track {
  position: relative;
  display: block;
  height: 0.8rem;
  border: var(--spacing-size-hairline) solid var(--rule);
  background: repeating-linear-gradient(
    90deg,
    transparent 0 calc(10% - 1px),
    var(--rule) calc(10% - 1px) 10%
  );
}

.Career .Span {
  position: absolute;
  inset-block: 0;
  background: var(--muted);
}

.Career .Span.Current {
  background: var(--accent);
  box-shadow: 0 0 0.8rem color-mix(in oklab, var(--accent) 40%, transparent);
}

.Career figcaption {
  display: flex;
  justify-content: space-between;
}

.Summary {
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-xl);
  line-height: 1.45;
  text-wrap: pretty;
}

.Highlights {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
  margin: 0;
  padding: var(--spacing_fluid-tight-space-tight-l) 0 0;
  border-top: var(--spacing-size-hairline) solid var(--rule);
  color: var(--muted);
  list-style: none;
}

.Highlights li {
  position: relative;
  padding-left: 1.3em;
  font-size: var(--typography_fluid-content-font-size-m);
  line-height: 1.55;
}

.Highlights li::before {
  content: "›";
  position: absolute;
  left: 0.15em;
  color: var(--accent);
}

/* -------------------------------------------------------------- the record */

.School {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Degree {
  font-size: var(--typography_fluid-display-font-size-display-m);
  line-height: 1.08;
  text-wrap: balance;
}

.SchoolSummary {
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-l);
  line-height: 1.5;
}

.Note {
  color: var(--muted);
  line-height: 1.55;
}

.Links {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.Links a {
  display: flex;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-m);
  padding: var(--spacing_fluid-tight-space-tight-m) 0.5rem;
  border-bottom: var(--spacing-size-hairline) solid var(--rule);
}

.Where {
  color: var(--link);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.Colophon {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-l);
  margin-top: auto;
  padding-top: var(--spacing_fluid-tight-space-tight-l);
  border-top: var(--spacing-size-rule) double var(--rule-strong);
}

.Imprint {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-s);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.ImprintPlate {
  font-size: var(--typography_fluid-display-font-size-display-m);
  letter-spacing: 0.01em;
}

.Credits {
  display: grid;
  gap: 0.35rem;
  margin: 0;
  font-size: var(--typography_fluid-micro-font-size-micro-m);
}

.Credits div {
  display: grid;
  grid-template-columns: 13ch minmax(0, 1fr);
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Credits dt {
  color: var(--faint);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.Credits dd {
  margin: 0;
  color: var(--muted);
}

/* ---------------------------------------------------------------- a phone */

@media (max-width: 60rem) {
  .Ledger {
    gap: var(--spacing_fluid-tight-space-tight-l);
  }

  .Total {
    padding-inline: var(--spacing_fluid-tight-space-tight-s);
  }

  .Total dd {
    font-size: var(--typography_fluid-content-font-size-l);
    white-space: nowrap;
  }

  .Title {
    font-size: var(--typography_fluid-display-font-size-display-m);
  }

  .Measures {
    margin-top: 0;
  }

  .Numeral {
    font-size: 3.5rem;
  }

  .LengthValue,
  .Degree,
  .ImprintPlate {
    font-size: var(--typography_fluid-display-font-size-display-s);
  }

  .Summary {
    font-size: var(--typography_fluid-content-font-size-m);
  }

  .Highlights li {
    font-size: var(--typography_fluid-content-font-size-s);
  }

  .AllStack,
  .Colophon {
    margin-top: 0;
  }
}
</style>
