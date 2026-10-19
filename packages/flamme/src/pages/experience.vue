<script setup lang="ts">
/**
 * Experience: the ledger.
 *
 * The chart has a screen of its own, with the totals under it. Each role then
 * takes a whole screen, set as a feature: the title in the display face, the
 * dates and the length of the role beside it, the summary, the highlights and the
 * stack. Education and the source of the ledger follow in the columns.
 *
 * A screen block is laid out at least as tall as the page, so it fills it; on a
 * phone, where a role can be taller than the screen, the pager splits it between
 * two lines like any other block.
 */
import { computed } from "vue"
import { usePageQuery } from "$flamme/records/experience"
import ExperienceChart from "../components/ExperienceChart.vue"
import Pager from "../components/Pager.vue"
import type { PagerItem } from "../components/pager.js"
import { formatDuration, formatMonth, monthsBetween } from "../utils/format.js"

const { data } = usePageQuery()

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

const items = computed<LedgerItem[]>(() => [
	{ id: "chart", kind: "chart", screen: true },
	...roles.value.map((role, index) => ({
		id: `role-${role.id}`,
		kind: "role" as const,
		role,
		number: index + 1,
		screen: true
	})),
	{ id: "record", kind: "record", screen: true }
])

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
  <Pager :items label="Experience">
    <template #item="{ item }">
      <section v-if='item.kind === "chart"' class="Overview">
        <ExperienceChart :roles />
        <dl class="Totals">
          <div class="Total">
            <dt>roles</dt>
            <dd class="display">{{ roles.length }}</dd>
          </div>
          <div class="Total Trade">
            <dt>in the trade</dt>
            <dd class="display">{{ formatDuration(totalMonths) }}</dd>
          </div>
          <div class="Total">
            <dt>since</dt>
            <dd class="display">{{ since.slice(0, 4) }}</dd>
          </div>
          <div class="Total Wide">
            <dt>stack</dt>
            <dd class="Stack">
              <span
                v-for="tech of stack"
                :key="tech"
                class="Tech"
                data-atomic>{{ tech }}</span>
            </dd>
          </div>
        </dl>
      </section>

      <article
        v-else-if='item.kind === "role"'
        class="Role"
        :data-label="item.role.company">
        <header class="Folio">
          <span class="Accent">role {{
              String(item.number).padStart(2, "0")
            }}</span>
          <span class="Faint">/ {{
              String(roles.length).padStart(2, "0")
            }}</span>
          <span class="Rule" aria-hidden="true"></span>
          <span>
            <time :datetime="item.role.start">{{
              formatMonth(item.role.start)
            }}</time>
            →
            <time v-if="item.role.end" :datetime="item.role.end">{{
              formatMonth(item.role.end)
            }}</time>
            <span v-else class="Accent">present</span>
          </span>
        </header>

        <div class="Main">
          <div class="Heading">
            <h2 class="Title display">{{ item.role.title }}</h2>
            <p class="Company">
              <span class="Name">{{ item.role.company }}</span>
              <span class="Dot" aria-hidden="true">·</span>
              <span>{{ item.role.location }}</span>
            </p>
          </div>
          <p class="Summary">{{ item.role.summary }}</p>
          <ul class="Highlights">
            <li v-for="highlight of item.role.highlights" :key="highlight">
              {{ highlight }}
            </li>
          </ul>
        </div>

        <aside class="Side">
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
          <ul class="Stack" aria-label="Stack">
            <li
              v-for="tech of item.role.stack"
              :key="tech"
              class="Tech"
              data-atomic>
              {{ tech }}
            </li>
          </ul>
          <figure
            class="Career"
            :aria-label="`${item.role.company} on the whole career`">
            <span class="Track" data-atomic>
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
        </aside>
      </article>

      <section v-else class="Record">
        <header class="Folio">
          <span class="Accent">the record</span>
          <span class="Rule" aria-hidden="true"></span>
          <span>{{ roles.length }} roles · {{
              formatDuration(totalMonths)
            }}</span>
        </header>

        <div class="Education">
          <h2 class="Section">
            <span class="Accent" aria-hidden="true">#</span>
            education
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
            <p class="Summary">{{ school.summary }}</p>
          </article>
        </div>

        <aside class="Elsewhere">
          <h2 class="Section">
            <span class="Accent" aria-hidden="true">#</span>
            the full record
          </h2>
          <p class="Note">
            This ledger is the short form. The long one, with every role,
            reference and recommendation, is kept on LinkedIn; the work itself
            is on GitHub.
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
        </aside>

        <footer class="Colophon">
          <p class="Imprint">
            <span class="Plate display">The Emmanuel Style</span>
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
      </section>
    </template>
  </Pager>
</template>

<style scoped>
/* The chart's screen: the chart takes what the totals leave. */
.Overview {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-l);
  min-height: var(--page-height);
}

.Overview :deep(.Chart) {
  flex: 1 1 auto;
}

.Totals {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(0, 2fr);
  margin: 0;
  border-block: var(--spacing-size-hairline) solid var(--rule);
}

.Total {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: var(--spacing_fluid-tight-space-tight-m)
    var(--spacing_fluid-tight-space-tight-l);
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
  font-size: clamp(
    1.2rem,
    2.2vw,
    var(--typography_fluid-display-font-size-display-s)
  );
  line-height: 1.1;
  white-space: nowrap;
}

.Total dd.Stack {
  font-size: inherit;
  white-space: normal;
}

/*
 * A role is a feature page: the folio across the top, the story down the left,
 * and in the margin the role's number set large, its length, its stack, and where
 * it sits on the whole career.
 */
.Role,
.Record {
  display: grid;
  grid-template-columns: minmax(0, 2.2fr) minmax(0, 1fr);
  grid-template-rows: auto 1fr;
  grid-template-areas:
    "folio folio"
    "main side";
  gap: var(--spacing_fluid-flow-space-s)
    var(--spacing_fluid-column-space-column-m);
  min-height: var(--page-height);
}

.Folio {
  grid-area: folio;
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

/* The story runs down the page: the heading at the top, the highlights at the foot. */
.Main {
  grid-area: main;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: var(--spacing_fluid-flow-space-m);
}

.Heading {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Title {
  font-size: var(--typography_fluid-display-font-size-display-xl);
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

.Name {
  color: var(--accent);
  font-weight: var(--typography-weight-body-bold);
}

.Dot,
.Faint {
  color: var(--faint);
}

.Accent {
  color: var(--accent);
}

.Summary {
  max-width: 44ch;
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-2xl);
  line-height: 1.4;
  text-wrap: pretty;
}

.Highlights {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: var(--spacing_fluid-tight-space-tight-l)
    var(--spacing_fluid-column-space-column-s);
  padding-top: var(--spacing_fluid-tight-space-tight-l);
  border-top: var(--spacing-size-hairline) solid var(--rule);
  color: var(--muted);
}

.Highlights li {
  position: relative;
  padding-left: 1.3em;
  line-height: 1.55;
}

.Highlights li::before {
  content: "›";
  position: absolute;
  left: 0.15em;
  color: var(--accent);
}

.Side {
  grid-area: side;
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xl);
  padding-left: var(--spacing_fluid-column-space-column-s);
  border-left: var(--spacing-size-hairline) solid var(--rule);
}

/* The role's number, set as large as a page number on a magazine's opener. */
.Numeral {
  font-size: clamp(4rem, 2rem + 7vw, 10rem);
  line-height: 0.9;
}

.Length {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.LengthValue {
  font-size: var(--typography_fluid-display-font-size-display-m);
  line-height: 1.05;
}

.Label {
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.Stack {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.Total .Stack {
  margin-top: 0.15rem;
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
  margin: auto 0 0;
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

/* The record: education down the left, where the rest of it lives on the right, and the imprint at the foot. */
.Record {
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    "folio folio"
    "main side"
    "colophon colophon";
}

.Colophon {
  grid-area: colophon;
  display: grid;
  grid-template-columns: minmax(0, 2.2fr) minmax(0, 1fr);
  align-items: end;
  gap: var(--spacing_fluid-tight-space-tight-l)
    var(--spacing_fluid-column-space-column-m);
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

.Imprint .Plate {
  font-size: var(--typography_fluid-display-font-size-display-l);
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

.Education {
  grid-area: main;
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-flow-space-s);
}

.Elsewhere {
  grid-area: side;
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-l);
  padding-left: var(--spacing_fluid-column-space-column-s);
  border-left: var(--spacing-size-hairline) solid var(--rule);
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

.School .Summary {
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-l);
}

.Note {
  color: var(--muted);
  line-height: 1.55;
}

.Links {
  display: flex;
  flex-direction: column;
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

@media (max-width: 60rem) {
  /* Two short totals side by side, then the long ones on rows of their own. */
  .Totals {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .Total.Trade {
    grid-row: 2;
  }

  .Total.Trade,
  .Total.Wide {
    grid-column: 1 / -1;
    border-left: 0;
    border-top: var(--spacing-size-hairline) solid var(--rule);
  }

  .Total {
    padding-inline: var(--spacing_fluid-tight-space-tight-m);
  }

  .Total dd {
    font-size: var(--typography_fluid-content-font-size-l);
    white-space: nowrap;
  }

  .Role,
  .Record {
    display: flex;
    flex-direction: column;
    gap: var(--spacing_fluid-tight-space-tight-l);
  }

  .Main {
    gap: var(--spacing_fluid-tight-space-tight-l);
    justify-content: flex-start;
  }

  .Title {
    font-size: var(--typography_fluid-display-font-size-display-m);
  }

  .Summary {
    font-size: var(--typography_fluid-content-font-size-m);
  }

  .Side,
  .Elsewhere {
    padding-left: 0;
    padding-top: var(--spacing_fluid-tight-space-tight-m);
    border-left: 0;
    border-top: var(--spacing-size-hairline) solid var(--rule);
  }

  .Side {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: end;
    gap: var(--spacing_fluid-tight-space-tight-m)
      var(--spacing_fluid-tight-space-tight-l);
  }

  .Numeral {
    font-size: 3.5rem;
  }

  .Stack,
  .Career {
    grid-column: 1 / -1;
  }

  .LengthValue,
  .Degree {
    font-size: var(--typography_fluid-display-font-size-display-s);
  }

  .Colophon {
    grid-template-columns: minmax(0, 1fr);
  }

  .Imprint .Plate {
    font-size: var(--typography_fluid-display-font-size-display-s);
  }
}
</style>
