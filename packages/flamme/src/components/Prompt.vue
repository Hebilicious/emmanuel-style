<script setup lang="ts">
/**
 * The prompt: a command line over the site.
 *
 * It sits in the dock under the status row and is part of the shell's column, so
 * opening it takes height from the reading pane rather than covering it, and the
 * pager re-lays the screen into what is left. The output grows upward from the
 * prompt line, so the line being typed never moves.
 *
 * The commands are `shell/terminal.ts`; this component reads the index they run
 * over through Flamme, keeps the history, and carries out what a command asks.
 */
import { nextTick, ref, watch } from "vue"
import { useRouter } from "vue-router"
import { applyTheme, setMouse, toggleTheme, useShell } from "../shell/shell.js"
import { useSiteIndex } from "../shell/site-index.js"
import { complete, run } from "../shell/terminal.js"

const shell = useShell()
const router = useRouter()
const index = useSiteIndex()

const input = ref<HTMLInputElement | null>(null)
const line = ref("")
const output = ref("")
const cwd = ref("/")
const matches = ref<string[]>([])
const active = ref(0)

const history: string[] = []
let cursor = -1
let draft = ""

const execute = (raw: string) => {
	const text = raw.trim()
	if (text === "") return
	history.unshift(text)
	if (history.length > 100) history.pop()
	cursor = -1

	const result = run(text, cwd.value, index.value)
	cwd.value = result.cwd
	output.value = result.output === "" ? "" : `❯ ${text}\n${result.output}`

	const action = result.action
	if (action === undefined) return
	switch (action.kind) {
		case "go":
			void router.push(action.href)
			break
		case "open":
			window.open(action.url, "_blank", "noopener,noreferrer")
			break
		case "theme":
			if (action.theme === "toggle") toggleTheme(shell)
			else applyTheme(shell, action.theme)
			break
		case "mouse":
			setMouse(shell, action.on)
			break
		case "clear":
			output.value = ""
			break
		case "exit":
			close()
			break
		default:
	}
}

const onSubmit = () => {
	execute(line.value)
	line.value = ""
	matches.value = []
}

const onInput = () => {
	matches.value =
		line.value.trim() === "" ? [] : complete(line.value, cwd.value, index.value)
	active.value = 0
}

/** Complete the word being typed with the highlighted candidate. */
const accept = () => {
	const choice = matches.value[active.value]
	if (choice === undefined) return
	const words = line.value.split(/\s+/)
	words[words.length - 1] = choice
	// A directory stays open for the next segment; anything else is a finished word.
	line.value = words.join(" ") + (choice.endsWith("/") ? "" : " ")
	onInput()
}

/** Up and Down walk the history, as in any shell; Down past the newest returns to the draft. */
const recall = (delta: number) => {
	if (history.length === 0) return
	if (cursor === -1) draft = line.value
	const next = cursor + delta
	if (next < -1 || next >= history.length) return
	cursor = next
	line.value = cursor === -1 ? draft : (history[cursor] ?? "")
	matches.value = []
	void nextTick(() =>
		input.value?.setSelectionRange(line.value.length, line.value.length)
	)
}

const onKeydown = (event: KeyboardEvent) => {
	if (event.key === "Tab") {
		event.preventDefault()
		if (matches.value.length === 0) onInput()
		else if (event.shiftKey)
			active.value =
				(active.value - 1 + matches.value.length) % matches.value.length
		else accept()
		return
	}
	if (event.key === "ArrowUp") {
		event.preventDefault()
		recall(1)
		return
	}
	if (event.key === "ArrowDown") {
		event.preventDefault()
		recall(-1)
		return
	}
	if (
		event.ctrlKey &&
		(event.key === "n" || event.key === "p") &&
		matches.value.length > 0
	) {
		event.preventDefault()
		const step = event.key === "n" ? 1 : -1
		active.value =
			(active.value + step + matches.value.length) % matches.value.length
		return
	}
	if (event.ctrlKey && event.key === "l") {
		event.preventDefault()
		output.value = ""
		return
	}
	if (event.key === "Escape") {
		event.preventDefault()
		close()
	}
}

const open = (command?: string) => {
	shell.prompt = true
	if (command !== undefined) execute(command)
	void nextTick(() => input.value?.focus())
}

const close = () => {
	shell.prompt = false
	matches.value = []
	;(document.activeElement as HTMLElement | null)?.blur?.()
}

// The prompt survives a navigation, and keeps the focus through it.
watch(
	() => router.currentRoute.value.fullPath,
	() => {
		if (shell.prompt) void nextTick(() => input.value?.focus())
	}
)

defineExpose({ open, close })
</script>

<template>
  <div v-show="shell.prompt" class="Console" data-prompt>
    <pre
      v-if="output"
      class="Out"
      role="status"
      aria-live="polite">{{ output }}</pre>
    <ul v-if="matches.length > 0" class="Matches" aria-label="Completions">
      <li
        v-for="(match, i) of matches"
        :key="match"
        class="Match"
        :data-active="i === active">
        {{ match }}
      </li>
    </ul>
    <form class="Line" @submit.prevent="onSubmit">
      <label class="visually-hidden" for="prompt-input">Command</label>
      <span class="Where" aria-hidden="true">{{ cwd }}</span>
      <span class="Sign" aria-hidden="true">❯</span>
      <input
        id="prompt-input"
        ref="input"
        v-model="line"
        class="Input"
        type="text"
        name="command"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        enterkeyhint="go"
        placeholder="help · ls · cd blog · cat cssforge · grep plato"
        @input="onInput"
        @keydown="onKeydown"
      />
      <kbd class="Esc">esc</kbd>
    </form>
  </div>
</template>

<style scoped>
.Console {
  display: flex;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  padding-top: var(--spacing_fluid-tight-space-tight-xs);
  border-top: var(--spacing-size-hairline) solid var(--rule);
  font-size: var(--typography_fluid-micro-font-size-micro-m);
  text-transform: none;
  letter-spacing: 0;
}

.Out {
  margin: 0;
  max-width: 110ch;
  color: var(--muted);
  font: inherit;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.Matches {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing_fluid-tight-space-tight-xs)
    var(--spacing_fluid-tight-space-tight-m);
  color: var(--faint);
}

.Match {
  padding: 0 0.35em;
}

.Match[data-active="true"] {
  background: var(--sunk);
  box-shadow: inset var(--spacing-size-rule) 0 0 0 var(--accent);
  color: var(--ink);
}

.Line {
  display: flex;
  align-items: center;
  gap: var(--spacing_fluid-tight-space-tight-s);
  max-width: 110ch;
  padding: 0.3rem var(--spacing_fluid-tight-space-tight-s);
  border: var(--spacing-size-hairline) solid var(--rule-strong);
  background: var(--paper);
}

.Where {
  color: var(--faint);
}

.Sign {
  color: var(--accent);
}

.Input {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  outline: none;
  caret-color: var(--accent);
}

.Input::placeholder {
  color: var(--faint);
}

.Esc {
  padding: 0 0.3em;
  border: var(--spacing-size-hairline) solid var(--rule);
  color: var(--faint);
  font: inherit;
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  text-transform: uppercase;
}
</style>
