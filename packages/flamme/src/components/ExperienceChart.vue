<script setup lang="ts">
/**
 * The experience chart: one bar per role, on a shared year axis.
 *
 * Drawn from the roles the page already has, so no second request and no separate
 * source of truth. The bars are SVG rects on a year scale, which is what makes the
 * overlaps visible at a glance.
 */
import { computed } from "vue"

interface Role {
	readonly id: string
	readonly title: string
	readonly company: string
	readonly start: string
	readonly end: string | null
}

const props = defineProps<{ roles: readonly Role[] }>()

const width = 900
const rowHeight = 30
const paddingLeft = 150

const monthsBetween = (from: Date, to: Date) =>
	(to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth())

const bars = computed(() => {
	const now = new Date()
	const parsed = props.roles.map((role) => ({
		role,
		start: new Date(role.start),
		end: role.end ? new Date(role.end) : now
	}))
	if (parsed.length === 0) return { rows: [], minYear: now.getFullYear(), maxYear: now.getFullYear() }

	const minYear = Math.min(...parsed.map((entry) => entry.start.getFullYear()))
	const maxYear = Math.max(...parsed.map((entry) => entry.end.getFullYear()))

	return { rows: parsed, minYear, maxYear }
})

const totalMonths = computed(() => {
	const { minYear, maxYear } = bars.value
	return Math.max(1, (maxYear - minYear + 1) * 12)
})

const years = computed(() => {
	const { minYear, maxYear } = bars.value
	return Array.from({ length: maxYear - minYear + 1 }, (_, index) => minYear + index)
})

const x = (date: Date) => {
	const { minYear } = bars.value
	const offset = date.getFullYear() - minYear
	const month = date.getMonth()
	return ((offset * 12 + month) / totalMonths.value) * (width - paddingLeft)
}

const label = (start: Date, end: Date) => {
	const count = monthsBetween(start, end)
	return count >= 12 ? `${Math.floor(count / 12)} yrs ${count % 12} mos` : `${count} mos`
}

const height = computed(() => bars.value.rows.length * rowHeight + 52)
</script>

<template>
  <figure class="Chart">
    <figcaption class="Caption label">
      <span class="Dot" aria-hidden="true" />
      experience over time
    </figcaption>

    <svg :viewBox="`0 0 ${width} ${height}`" role="img" aria-label="Roles over time">
      <!-- The year axis. -->
      <g class="Axis">
        <text
          v-for="year in years"
          :key="year"
          :x="paddingLeft + ((year - bars.minYear) * 12 * (width - paddingLeft)) / totalMonths"
          y="14"
        >
          {{ year }}
        </text>
        <line
          v-for="year in years"
          :key="`line-${year}`"
          :x1="paddingLeft + ((year - bars.minYear) * 12 * (width - paddingLeft)) / totalMonths"
          :x2="paddingLeft + ((year - bars.minYear) * 12 * (width - paddingLeft)) / totalMonths"
          :y1="24"
          :y2="height - 14"
        />
      </g>

      <g v-for="(entry, index) in bars.rows" :key="entry.role.id" :transform="`translate(0 ${28 + index * rowHeight})`">
        <text class="Role" x="0" :y="rowHeight / 2 + 4">{{ entry.role.company }}</text>
        <rect
          class="Bar"
          :class="{ Current: entry.role.end === null }"
          :x="paddingLeft + x(entry.start)"
          y="4"
          :width="Math.max(6, x(entry.end) - x(entry.start))"
          :height="rowHeight - 12"
        />
        <text class="Span" :x="paddingLeft + x(entry.end) + 8" :y="rowHeight / 2 + 4">
          {{ label(entry.start, entry.end) }}
        </text>
      </g>
    </svg>

    <p class="Legend">
      <span class="Swatch" aria-hidden="true" />
      current role
    </p>
  </figure>
</template>

<style scoped>
.Chart {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  margin: 0;
  padding: var(--spacing_fluid-tight-space-tight-m);
  border: var(--spacing-size-hairline) solid var(--rule);
}

.Caption {
  display: flex;
  align-items: center;
  gap: var(--spacing_fluid-tight-space-tight-s);
  color: var(--muted);
}

.Dot {
  width: 0.5rem;
  height: 0.5rem;
  background: var(--accent);
}

svg {
  display: block;
  width: 100%;
  max-height: 100%;
  height: auto;
}

.Axis line {
  stroke: var(--rule);
  stroke-width: 1;
}

.Axis text {
  fill: var(--faint);
  font-size: 13px;
  text-anchor: middle;
}

.Role {
  fill: var(--ink);
  font-size: 14px;
}

.Span {
  fill: var(--faint);
  font-size: 12px;
}

.Bar {
  fill: var(--muted);
  opacity: 0.45;
}

.Bar.Current {
  fill: var(--accent);
  opacity: 1;
}

.Legend {
  display: flex;
  align-items: center;
  gap: var(--spacing_fluid-tight-space-tight-s);
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.Swatch {
  width: 0.5rem;
  height: 0.5rem;
  background: var(--accent);
}
</style>
