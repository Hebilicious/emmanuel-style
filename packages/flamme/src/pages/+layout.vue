<script setup lang="ts">
/**
 * The shell, as the root layout.
 *
 * One fixed screen: the bar at the top, the reading pane in the middle, the dock
 * at the bottom. Nothing scrolls. A route renders into the pane, and a route with
 * more than a screen of content renders a pager that turns with `n` and `p`.
 *
 * The layout owns what every route shares: the shell's state (provided to every
 * component under it), the keyboard layer, the mouse gate, the dialogs, and the
 * WebMCP tools. The theme class is applied by the inline script in `index.html`
 * before the first paint, so this only reacts to a later change.
 */
import { onBeforeUnmount, onMounted, provide, ref, watch } from "vue"
import { RouterView, useRoute, useRouter } from "vue-router"
import Bar from "../components/Bar.vue"
import Dock from "../components/Dock.vue"
import MouseGate from "../components/MouseGate.vue"
import RepoCard from "../components/RepoCard.vue"
import Zoom from "../components/Zoom.vue"
import { useFootnotes } from "../shell/footnotes.js"
import { useKeyboard } from "../shell/keyboard.js"
import { usePointer } from "../shell/pointer.js"
import { sectionOf } from "../shell/sections.js"
import { createShell, SHELL } from "../shell/shell.js"
import { useSiteIndex } from "../shell/site-index.js"
import { registerWebMcp } from "../shell/webmcp.js"

const shell = createShell()
provide(SHELL, shell)

const route = useRoute()
const router = useRouter()
const dock = ref<InstanceType<typeof Dock> | null>(null)

const keyboard = useKeyboard(shell, router, {
	open: (command) => dock.value?.open(command),
	close: () => dock.value?.close()
})
usePointer(shell, router, useFootnotes(shell))

const index = useSiteIndex()

const onNetwork = () => {
	shell.online = navigator.onLine
}

onMounted(() => {
	window.addEventListener("online", onNetwork)
	window.addEventListener("offline", onNetwork)
	registerWebMcp(shell, router, () => index.value)
	keyboard.home()
})

onBeforeUnmount(() => {
	window.removeEventListener("online", onNetwork)
	window.removeEventListener("offline", onNetwork)
})

/*
 * A new route starts clean: its own title, no dialog left open over it, and the
 * keys back on pages until the route says otherwise. An article sets its own title
 * once its data is there.
 */
watch(
	() => route.path,
	(path) => {
		document.title = sectionOf(path).title
		shell.dialog = null
		shell.turnLabel = "pages"
	},
	{ immediate: true }
)

// The cursor goes to the first row of whatever screen is now showing.
watch(
	() => [route.fullPath, shell.position?.current, shell.position?.total],
	() => keyboard.home()
)
</script>

<template>
  <div class="Terminal">
    <a class="Skip" href="#main">Skip to content</a>
    <Bar />
    <div class="Edge" aria-hidden="true"></div>

    <main id="main" class="Page" tabindex="-1">
      <RouterView />
    </main>

    <Dock ref="dock" />

    <MouseGate />
    <RepoCard />
    <Zoom />
  </div>
</template>
