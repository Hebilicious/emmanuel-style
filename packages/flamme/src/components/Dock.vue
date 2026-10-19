<script setup lang="ts">
/**
 * The dock: the status row, and the prompt under it.
 *
 * The status row is a terminal's mode line. It says where the reader is (the
 * page of the screen, the row the cursor is on), what the keys do, and whether
 * the network is there; it never changes height, so nothing above it moves when
 * the cursor or the page does.
 *
 * The page counter is also a control. Its arrows are buttons, so a reader with a
 * mouse or a phone can turn the page the keyboard turns with `n` and `p`.
 */
import { computed, ref } from "vue"
import { useShell } from "../shell/shell.js"
import Prompt from "./Prompt.vue"

const shell = useShell()
const prompt = ref<InstanceType<typeof Prompt> | null>(null)
const year = new Date().getFullYear()

const pages = computed(() => shell.position)
const many = computed(() => (pages.value?.total ?? 1) > 1)

defineExpose({
	open: (command?: string) => prompt.value?.open(command),
	close: () => prompt.value?.close()
})
</script>

<template>
  <div class="Dock">
    <div class="Status">
      <span class="Cell Brand">
        <span>emmanuel.style</span>
        <span class="Dot" aria-hidden="true">·</span>
        <span>{{ year }}</span>
      </span>

      <!-- The sections' keys are not repeated here: the bar marks them beside each name. -->
      <span class="Cell Hint" aria-hidden="true">
        <span class="Key">←</span><span class="Key">↓</span><span
          class="Key">↑</span><span class="Key">→</span><span class="Word">
          move</span>
        <span class="Dot">·</span>
        <span class="Key">n</span><span class="Key">p</span><span class="Word">
          {{ shell.turnLabel }}</span>
        <span class="Dot">·</span>
        <span class="Key">↵</span><span class="Word"> open</span>
        <span class="Dot">·</span>
        <span class="Key">/</span><span class="Word"> prompt</span>
      </span>

      <span class="Cell End">
        <span class="Focus" aria-live="polite">
          <template v-if="shell.focus"><span class="Faint">focus</span> {{
              shell.focus
            }}</template>
        </span>

        <span v-if="many" class="Pages" role="group" aria-label="Pages">
          <button
            type="button"
            class="Turn"
            :disabled="pages!.current <= 1"
            aria-label="Previous page"
            aria-keyshortcuts="p"
            @click="shell.turner?.turn(-1)">
            ‹
          </button>
          <span class="Count">
            <span class="Faint Word">page</span>
            {{ pages!.current }}<span class="Faint">/</span>{{ pages!.total }}
          </span>
          <button
            type="button"
            class="Turn"
            :disabled="pages!.current >= pages!.total"
            aria-label="Next page"
            aria-keyshortcuts="n"
            @click="shell.turner?.turn(1)">
            ›
          </button>
        </span>

        <span class="Net" :class="{ Offline: !shell.online }">
          <span class="Lamp" aria-hidden="true"></span>
          {{ shell.online ? "online" : "offline" }}
        </span>
      </span>
    </div>

    <Prompt ref="prompt" />
  </div>
</template>

<style scoped>
.Dock {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: var(--spacing_fluid-tight-space-tight-xs);
  margin-inline: calc(var(--shell-gutter) * -1);
  padding: var(--spacing_fluid-tight-space-tight-xs) var(--shell-gutter)
    max(var(--spacing_fluid-tight-space-tight-xs), env(safe-area-inset-bottom));
  border-top: var(--spacing-size-rule) double var(--rule-strong);
  background: var(--surface);
}

.Status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing_fluid-tight-space-tight-l);
  min-height: 1.75rem;
  color: var(--muted);
  font-size: var(--typography_fluid-micro-font-size-micro-s);
  letter-spacing: 0.12em;
  text-transform: uppercase;
  white-space: nowrap;
}

.Cell {
  display: flex;
  align-items: center;
  gap: var(--spacing_fluid-tight-space-tight-xs);
}

.Hint {
  flex: 1 1 auto;
  justify-content: center;
  min-width: 0;
  overflow: hidden;
  color: var(--faint);
}

.Key {
  display: inline-block;
  min-width: 1.5em;
  padding: 0 0.3em;
  border: var(--spacing-size-hairline) solid var(--rule);
  border-bottom-width: 2px;
  color: var(--muted);
  text-align: center;
  line-height: 1.5;
}

.Key + .Key {
  margin-left: -1px;
}

.Dot,
.Faint {
  color: var(--faint);
}

.End {
  gap: var(--spacing_fluid-tight-space-tight-m);
}

/* What Enter would follow. A fixed width keeps the row from shifting as it changes. */
.Focus {
  display: inline-block;
  width: 26ch;
  overflow: hidden;
  color: var(--ink);
  text-overflow: ellipsis;
  text-align: right;
}

.Pages {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.Count {
  min-width: 9ch;
  text-align: center;
}

.Turn {
  display: grid;
  place-items: center;
  width: 1.6rem;
  height: 1.4rem;
  border: var(--spacing-size-hairline) solid var(--rule);
  color: var(--accent);
  font-size: 1rem;
  line-height: 1;
}

.Turn:disabled {
  color: var(--rule);
  cursor: default;
}

:global(.mouse-enabled) .Turn:not(:disabled):hover {
  border-color: var(--accent);
}

.Net {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  color: var(--accent);
}

.Lamp {
  width: 0.45rem;
  height: 0.45rem;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0.5rem currentColor;
}

.Net.Offline {
  color: var(--tertiary);
}

/*
 * The legend shortens as the row narrows rather than being cut: first the words go,
 * leaving the keys. Below that it is for a keyboard, and a phone has none.
 */
@media (max-width: 110rem) {
  .Focus {
    width: 20ch;
  }
}

@media (max-width: 86rem) {
  .Word {
    display: none;
  }
}

@media (max-width: 72rem) {
  .Hint {
    visibility: hidden;
  }
}

@media (max-width: 60rem) {
  .Hint,
  .Focus,
  .Word {
    display: none;
  }

  .Turn {
    width: 2.25rem;
    height: 1.9rem;
    font-size: 1.15rem;
  }
}
</style>
