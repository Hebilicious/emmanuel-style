<script setup lang="ts">
/**
 * The mouse gate's question.
 *
 * Asked once two clicks arrive in a row (`shell/pointer.ts`), in the middle of
 * the screen, because a click is the one thing the site does not expect and the
 * question has to be impossible to miss. `y` and `n` answer it, as do the buttons.
 */
import { nextTick, ref, watch } from "vue"
import { setMouse, useShell } from "../shell/shell.js"

const shell = useShell()
const yes = ref<HTMLButtonElement | null>(null)

const answer = (enabled: boolean) => {
	setMouse(shell, enabled)
	shell.dialog = null
}

watch(
	() => shell.dialog?.kind === "gate",
	(open) => {
		if (open) void nextTick(() => yes.value?.focus())
	}
)
</script>

<template>
  <div
    v-if='shell.dialog?.kind === "gate"'
    class="Overlay"
    @click.self="shell.dialog = null">
    <div
      class="Sheet Gate"
      role="dialog"
      aria-modal="true"
      aria-labelledby="gate-ask"
      aria-describedby="gate-aside">
      <p class="Overline label">mouse</p>
      <p id="gate-ask" class="Ask">Enable mouse navigation?</p>
      <p id="gate-aside" class="Aside">
        This site is read with the keyboard. The mouse can come back for this
        visit.
      </p>
      <div class="Choices">
        <button
          ref="yes"
          type="button"
          class="Choice Primary"
          @click="answer(true)">
          <span class="Key" aria-hidden="true">y</span>
          Yes, I need a mouse
        </button>
        <button type="button" class="Choice" @click="answer(false)">
          <span class="Key" aria-hidden="true">n</span>
          No, I use vim btw
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.Gate {
  width: min(34rem, 100%);
}

.Ask {
  color: var(--ink);
  font-size: var(--typography_fluid-content-font-size-l);
  line-height: 1.25;
}

.Aside {
  color: var(--muted);
  font-size: var(--typography_fluid-content-font-size-s);
}
</style>
