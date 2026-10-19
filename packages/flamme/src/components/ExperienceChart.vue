<script setup lang="ts">
/**
 * Experience over time: one bar per role, on a shared axis of years.
 *
 * Drawn in HTML rather than SVG. An SVG scales its text with its width, so on a
 * phone the labels came out at five pixels; here the labels are text in the
 * page's own face and only the bars are positioned, as percentages of the axis,
 * so the chart reads at any width. On a wide screen the company sits to the left
 * of its bar; on a phone it sits above it.
 *
 * Drawn from the roles the page already has, so there is no second request and no
 * second source of truth.
 */
import { computed } from "vue"
import { formatDuration, formatMonth, monthsBetween } from "../utils/format.js"

interface Role {
	readonly id: string
	readonly title: string
	readonly company: string
	readonly start: string
	readonly end: string | null
}

const props = defineProps<{ roles: readonly Role[] }>()

const monthIndex = (value: string) => {
	const [year = 0, month = 1] = value.split("-").map(Number)
	return year * 12 + (month - 1)
}

const now = new Date()
const thisMonth = now.getFullYear() * 12 + now.getMonth()

const axis = computed(() => {
	const starts = props.roles.map((role) => monthIndex(role.start))
	const first = starts.length > 0 ? Math.min(...starts) : thisMonth
	// Rounded out to whole years, so the axis lands on January at both ends.
	const from = Math.floor(first / 12) * 12
	const to = Math.ceil((thisMonth + 1) / 12) * 12
	return { from, to, span: Math.max(12, to - from) }
})

const at = (month: number) =>
	((month - axis.value.from) / axis.value.span) * 100

/**
 * One tick per January. The last one closes the axis and carries no label: the
 * year it would name has nothing in it yet.
 */
const years = computed(() => {
	const out: { label: string; left: number }[] = []
	for (let month = axis.value.from; month <= axis.value.to; month += 12) {
		out.push({
			label: month === axis.value.to ? "" : String(month / 12),
			left: at(month)
		})
	}
	return out
})

const rows = computed(() =>
	[...props.roles]
		.sort((a, b) => b.start.localeCompare(a.start))
		.map((role) => {
			const start = monthIndex(role.start)
			const end = role.end === null ? thisMonth + 1 : monthIndex(role.end) + 1
			const left = at(start)
			const width = Math.max(0.8, at(end) - left)
			return {
				role,
				left,
				width,
				current: role.end === null,
				duration: formatDuration(monthsBetween(role.start, role.end)),
				// The duration sits after the bar when there is room, and before it otherwise.
				after: left + width < 82
			}
		})
)
</script>

<template>
  <figure class="Chart">
    <figcaption class="Caption">
      <span class="Title label">
        <span class="Mark" aria-hidden="true">▚</span>
        experience over time
      </span>
      <span class="Legend label">
        <span class="Swatch" aria-hidden="true"></span>
        current role
      </span>
    </figcaption>

    <div
      class="Plot"
      role="img"
      :aria-label="`Timeline of ${roles.length} roles, newest first`">
      <div class="Axis" aria-hidden="true">
        <span
          v-for="(year, index) of years"
          :key="year.left"
          class="Year"
          :class="{ Odd: index % 2 === 1 }"
          :style="{ left: `${year.left}%` }">
          <span class="Full">{{ year.label }}</span>
          <span class="Abbr">{{
            year.label ? `’${year.label.slice(2)}` : ""
          }}</span>
        </span>
      </div>

      <div class="Rows">
        <div v-for="row of rows" :key="row.role.id" class="Row">
          <p class="Who">
            <span class="Company">{{ row.role.company }}</span>
            <span class="Role">{{ row.role.title }}</span>
            <span class="When">{{ formatMonth(row.role.start) }} → {{
                row.role.end ? formatMonth(row.role.end) : "now"
              }}</span>
          </p>
          <div class="Track">
            <span
              v-for="year of years"
              :key="year.left"
              class="Grid"
              :style="{ left: `${year.left}%` }"></span>
            <span
              class="Bar"
              :class="{ Current: row.current }"
              :style="{ left: `${row.left}%`, width: `${row.width}%` }"></span>
            <span
              class="Span"
              :class="{ Before: !row.after }"
              :style="row.after
              ? { left: `calc(${row.left + row.width}% + 0.6rem)` }
              : { right: `calc(${100 - row.left}% + 0.6rem)` }">
              {{ row.duration }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </figure>
</template>

<style scoped>
.Chart {
  --label-width: clamp(9rem, 16vw, 15rem);
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-l);
  margin: 0;
  padding: var(--spacing_fluid-tight-space-tight-l)
    var(--spacing_fluid-tight-space-tight-xl);
  border: var(--spacing-size-hairline) solid var(--rule);
  border-left: var(--spacing-size-rule) solid var(--accent);
  background: var(--surface);
}

.Caption {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-m);
  color: var(--muted);
}

.Title {
  display: flex;
  align-items: baseline;
  gap: var(--spacing_fluid-tight-space-tight-s);
}

.Mark {
  color: var(--accent);
}

.Legend {
  display: flex;
  align-items: center;
  gap: var(--spacing_fluid-tight-space-tight-s);
  color: var(--faint);
}

.Swatch {
  width: 1.1em;
  height: 0.55em;
  background: var(--accent);
}

.Plot {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 0.4rem;
}

.Axis {
  position: relative;
  height: 1.4rem;
  margin-left: var(--label-width);
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
}

.Year {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
}

.Year .Abbr {
  display: none;
}

.Rows {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  justify-content: space-around;
  gap: var(--spacing_fluid-tight-space-tight-m);
}

.Row {
  display: grid;
  grid-template-columns: var(--label-width) minmax(0, 1fr);
  align-items: center;
}

.Who {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding-right: var(--spacing_fluid-tight-space-tight-m);
  line-height: 1.3;
}

.Company {
  color: var(--ink);
  font-weight: var(--typography-weight-body-bold);
}

.Role,
.When {
  overflow: hidden;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.When {
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.Track {
  position: relative;
  height: 3.2rem;
}

.Grid {
  position: absolute;
  inset-block: -0.6rem;
  border-left: var(--spacing-size-hairline) dashed var(--rule);
}

.Bar {
  position: absolute;
  top: 50%;
  height: 1.6rem;
  transform: translateY(-50%);
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background: repeating-linear-gradient(
    -45deg,
    var(--sunk) 0 0.3rem,
    color-mix(in oklab, var(--sunk) 55%, var(--surface)) 0.3rem 0.6rem
  );
}

.Bar.Current {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: 0 0 1.25rem color-mix(in oklab, var(--accent) 35%, transparent);
}

.Span {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@media (max-width: 40rem) {
  .Chart {
    --label-width: 0px;
    padding: var(--spacing_fluid-tight-space-tight-m);
  }

  /* A phone has room for a label every other year, in two digits. */
  .Year .Full,
  .Year.Odd {
    display: none;
  }

  .Year .Abbr {
    display: inline;
  }

  .Row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.25rem;
  }

  .Who {
    flex-direction: row;
    align-items: baseline;
    gap: 0.6em;
  }

  .Who .When {
    margin-left: auto;
  }

  .Who .Role {
    display: none;
  }

  .Track {
    height: 1.8rem;
  }

  .Bar {
    height: 1rem;
  }
}
</style>
