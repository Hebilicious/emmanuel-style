<script setup lang="ts">
/**
 * Skills: what can be asked for, written as agent skills.
 *
 * An agent skill is a `SKILL.md`: front matter with a name, a description that says
 * when to load it and the tools it may use, then the body. Each skill here is set
 * as that file, open on its own page, but it is written for a person deciding whom
 * to hire: what he does, in the first person; his record with it; how he works;
 * and the evidence, the projects in the Library that prove it, each opening over
 * the page like a card in the Library does. The prompt has them too:
 * `cat skills/<name>.md`.
 *
 * The first spread is the section's landing: what this is, the way in, and the
 * listing of `skills/` beside it, with where to get in touch.
 */
import { computed, ref } from "vue"
import { RouterLink, useRouter } from "vue-router"
import { usePageQuery } from "$flamme/records/skills"
import Inline from "../components/Inline.vue"
import Pager from "../components/Pager.vue"
import SectionLanding from "../components/SectionLanding.vue"
import SkillListing from "../components/SkillListing.vue"
import type { PagerHandle, PagerItem } from "../components/pager.js"
import { openProject, projectHref } from "../shell/project.js"
import { useSiteIndex } from "../shell/site-index.js"
import { useWide } from "../shell/wide.js"

const { data } = usePageQuery()
const wide = useWide()
const router = useRouter()
const index = useSiteIndex()
const pager = ref<PagerHandle | null>(null)

const skills = computed(() => data.value?.skills ?? [])
type Skill = (typeof skills.value)[number]

const titles = computed(
	() =>
		new Map(
			index.value.projects.map((project) => [project.name, project.title])
		)
)

type SkillsItem =
	| (PagerItem & { readonly kind: "landing" })
	| (PagerItem & { readonly kind: "listing" })
	| (PagerItem & {
			/** The first page of a skill's file, and the page it continues on. */
			readonly kind: "skill" | "record"
			readonly skill: Skill
			readonly number: number
	  })

const items = computed<SkillsItem[]>(() =>
	skills.value.length === 0
		? []
		: [
				{ id: "landing", kind: "landing", screen: wide.value, fit: true },
				// On a phone the listing is a page of its own, after the landing.
				...(wide.value
					? []
					: [{ id: "listing", kind: "listing" as const, fit: true }]),
				/*
				 * Each skill is a file of two pages, and each page opens one, fills it and is
				 * shown whole. The first is what the skill is and the proof: the front matter,
				 * the heading, what I do, and where I did it. The second is the record and how
				 * I work. After the landing, which takes a spread, a skill is a spread of its
				 * own; on a phone it is two pages.
				 */
				...skills.value.flatMap((skill, at): SkillsItem[] => [
					{
						id: `skill-${skill.name}`,
						kind: "skill",
						skill,
						number: at + 1,
						opens: true,
						fit: true,
						grow: true
					},
					{
						id: `record-${skill.name}`,
						kind: "record",
						skill,
						number: at + 1,
						opens: true,
						fit: true,
						grow: true
					}
				])
			]
)

/** The page a block is on, counted from one; known once the pager has laid out. */
const layout = ref(0)
const pageOfItem = (id: string): number | null => {
	void layout.value
	const screen = pager.value?.screenOf(id) ?? -1
	return screen === -1 ? null : screen + 1
}
const toPage = (page: number | null) => ({
	query: { page: page !== null && page > 1 ? page : undefined }
})

const cited = computed(
	() => new Set(skills.value.flatMap((skill) => skill.evidence)).size
)
const figures = computed(() => [
	{ label: "skills", value: String(skills.value.length) },
	{ label: "projects cited", value: String(cited.value) }
])
const cta = computed(() => {
	const first = skills.value[0]
	return {
		label: "Read the first skill",
		detail: first ? `${first.name}/SKILL.md` : "",
		to: toPage(first ? (pageOfItem(`skill-${first.name}`) ?? 2) : 2)
	}
})
const standfirst =
	"What I am good at, filed the way an agent files a skill: when to load it, what I have done with it, how I work. The format is for fun. The record is not: every line of it is in the Library."

const open = (name: string) => void openProject(router, name)

/** The page of the ledger a company's role is on: the ledger resolves the role's id to its page. */
const roleLink = (company: string) => {
	const role = index.value.roles.find((entry) => entry.company === company)
	return { path: "/experience", query: role ? { role: role.id } : {} }
}
</script>

<template>
  <Pager ref="pager" :items label="Skills" @layout="layout += 1">
    <template #item="{ item }">
      <SectionLanding
        v-if='item.kind === "landing"'
        kicker="for hire"
        title="Skills"
        :standfirst
        :figures
        :cta
        emblem="/images/emblems/skills.png"
        :wide
        :aside="wide">
        <SkillListing
          :skills
          :to="(name) => toPage(pageOfItem(`skill-${name}`))"
        />
      </SectionLanding>

      <div v-else-if='item.kind === "listing"' class="Aside">
        <SkillListing
          :skills
          :to="(name) => toPage(pageOfItem(`skill-${name}`))"
        />
      </div>

      <article
        v-else-if='item.kind === "skill"'
        class="Skill"
        :aria-label="item.skill.title">
        <header class="Tab">
          <span class="Path">skills/{{ item.skill.name }}/<b>SKILL.md</b></span>
          <span class="Count">{{ String(item.number).padStart(2, "0") }} / {{
              String(skills.length).padStart(2, "0")
            }}</span>
        </header>

        <div class="Front">
          <span class="Fence">---</span>
          <span><span class="Key">name:</span> {{ item.skill.name }}</span>
          <span><span class="Key">description:</span> {{
              item.skill.description
            }}</span>
          <span class="Allowed"><span class="Key">allowed-tools:</span>
            <span v-for="tool of item.skill.tools" :key="tool" class="Tool">{{
              tool
            }}</span></span>
          <span class="Fence">---</span>
        </div>

        <h2 class="Title">
          <span class="Hash" aria-hidden="true">#</span> <span
            class="display">{{ item.skill.title }}</span>
        </h2>

        <p class="Summary">{{ item.skill.summary }}</p>

        <section class="Part Proof">
          <h3 class="Heading">
            <span class="Hash" aria-hidden="true">##</span> Evidence
          </h3>
          <p class="Evidence">
            <span class="EvidenceLabel">on the job</span>
            <RouterLink
              v-for="company of item.skill.roles"
              :key="company"
              class="Chip Job"
              :to="roleLink(company)"
              data-row
              :data-label="company">{{ company }}</RouterLink>
          </p>
          <p class="Evidence">
            <span class="EvidenceLabel">in the Library</span>
            <a
              v-for="name of item.skill.evidence"
              :key="name"
              class="Chip"
              :href="projectHref(router, name)"
              data-row
              :data-label="titles.get(name) ?? name"
              :data-project="name"
              @click.exact.prevent="open(name)">{{
              titles.get(name) ?? name
            }}</a>
          </p>
        </section>
      </article>

      <article
        v-else-if='item.kind === "record"'
        class="Skill"
        :aria-label="`${item.skill.title}, continued`">
        <header class="Tab">
          <span class="Path">skills/{{ item.skill.name }}/<b>SKILL.md</b>
            <span class="Continued">continued</span></span>
          <span class="Count">{{ String(item.number).padStart(2, "0") }} / {{
              String(skills.length).padStart(2, "0")
            }}</span>
        </header>

        <section class="Part">
          <h3 class="Heading">
            <span class="Hash" aria-hidden="true">##</span> Track record
          </h3>
          <ul class="Bullets">
            <li v-for="line of item.skill.record" :key="line">
              <Inline :text="line" />
            </li>
          </ul>
        </section>

        <section class="Part">
          <h3 class="Heading">
            <span class="Hash" aria-hidden="true">##</span> How I work
          </h3>
          <ul class="Bullets Plain">
            <li v-for="line of item.skill.practice" :key="line">
              <Inline :text="line" />
            </li>
          </ul>
        </section>
      </article>
    </template>
  </Pager>
</template>

<style scoped>
/*
 * A skill, set as the file it is: the path in a tab, the front matter in the
 * colours an editor gives it, then the markdown, its headings keeping their #.
 */
.Skill {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-l);
  padding: 0 var(--spacing_fluid-tight-space-tight-m)
    var(--spacing_fluid-tight-space-tight-m);
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background: var(--surface);
}

.Tab {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-m);
  margin-inline: calc(var(--spacing_fluid-tight-space-tight-m) * -1);
  padding: 0.45rem var(--spacing_fluid-tight-space-tight-m);
  border-bottom: var(--spacing-size-hairline) solid var(--rule-strong);
  background: var(--sunk);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.04em;
}

.Path b {
  color: var(--ink);
  font-weight: var(--typography-weight-body-bold);
}

.Count {
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.Front {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-s);
  line-height: 1.5;
}

.Fence {
  color: var(--faint);
}

.Key {
  color: var(--accent);
}

.Title {
  display: flex;
  align-items: baseline;
  gap: 0.4em;
  margin: 0;
  font-size: var(--typography_fluid-display-font-size-display-m);
  line-height: 1.05;
}

.Title .display {
  text-wrap: balance;
}

.Hash {
  color: var(--faint);
  font-family: var(--font-monaspace);
  font-size: 0.5em;
  font-weight: normal;
}

/* What he does: the one paragraph a person reads, set as the lede. */
.Continued {
  margin-left: 0.8em;
  color: var(--faint);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.Summary {
  max-width: 62ch;
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-l);
  line-height: 1.5;
  text-wrap: pretty;
}

.Allowed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem 0.4rem;
}

.Aside {
  color: var(--faint);
  font-weight: var(--typography-weight-body-regular);
  letter-spacing: 0.08em;
}

/* The evidence sits at the foot of the file. */
.Proof {
  margin-top: auto;
  padding-top: var(--spacing_fluid-tight-space-tight-m);
  border-top: var(--spacing-size-hairline) solid var(--rule);
}

.Bullets.Plain li::before {
  content: "·";
}

.Part {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-s);
}

.Heading {
  display: flex;
  align-items: baseline;
  gap: 0.5em;
  color: var(--ink);
  font-size: var(--typography_fluid-micro-font-size-micro-l);
  font-weight: var(--typography-weight-body-bold);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.Heading .Hash {
  font-size: 1em;
  letter-spacing: 0;
}

.Bullets,
.Steps {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-m);
  line-height: 1.5;
  counter-reset: step;
}

.Bullets li,
.Steps li {
  display: grid;
  grid-template-columns: 1.8em minmax(0, 1fr);
}

.Bullets li::before {
  content: "-";
  color: var(--accent);
}

.Steps li {
  counter-increment: step;
}

.Steps li::before {
  content: counter(step) ".";
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.Tools,
.Evidence {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.Tool {
  padding: 0 0.45em;
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.08em;
  line-height: 1.8;
  text-transform: uppercase;
}

/* Evidence is the Library: each chip opens its project over this page. */
.Chip {
  padding: 0.1rem 0.6em;
  border: var(--spacing-size-hairline) solid var(--accent);
  color: var(--accent);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  letter-spacing: 0.04em;
  text-decoration: none;
}

.Chip[data-cursor="true"] {
  background: var(--accent);
  box-shadow: none;
  color: var(--accent-ink);
}

/* A role in the ledger: set in ink, where a project is set in the accent. */
.Chip.Job {
  border-color: var(--rule-strong);
  color: var(--ink);
}

.EvidenceLabel {
  min-width: 7.5em;
  align-self: center;
  color: var(--faint);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

/* A phone has no cursor to draw (see `global.css`). */
@media (hover: none) and (pointer: coarse) {
  .Chip[data-cursor="true"] {
    background: none;
    color: var(--accent);
  }
}

@media (max-width: 60rem) {
  .Title {
    font-size: var(--typography_fluid-display-font-size-display-s);
  }
}
</style>
