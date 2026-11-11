<script setup lang="ts">
/**
 * A line of text with its `code` set as code.
 *
 * The data writes names of things in backticks (`readFormData`, `<server>`), the
 * way markdown does. This sets those spans in a `<code>` and leaves the rest as
 * text, with no HTML parsed, so the data stays plain strings.
 */
import { computed } from "vue"

const props = defineProps<{ text: string }>()

const parts = computed(() =>
	props.text
		.split(/(`[^`]+`)/)
		.filter((part) => part !== "")
		.map((part) =>
			part.startsWith("`") && part.endsWith("`")
				? { code: true, text: part.slice(1, -1) }
				: { code: false, text: part }
		)
)
</script>

<template>
  <span><template v-for="(part, index) of parts" :key="index"><code
        v-if="part.code"
        class="Code">{{ part.text }}</code><template v-else>{{
        part.text
      }}</template></template></span>
</template>

<style scoped>
.Code {
  padding: 0 0.3em;
  background: var(--sunk);
  color: var(--accent);
  font-family: inherit;
  font-size: 0.95em;
}
</style>
