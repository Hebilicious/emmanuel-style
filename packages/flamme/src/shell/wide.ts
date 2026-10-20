/**
 * Whether the screen holds a spread of two pages, the breakpoint the pager uses.
 *
 * A page that lays out differently on a spread and on a single page (the Library's
 * front page is one composition across two pages, or a run of cards on a phone)
 * reads it here, so it agrees with the pager about which it is.
 */
import { onBeforeUnmount, onMounted, type Ref, ref } from "vue"

export const SPREAD_QUERY = "(min-width: 60rem)"

export const useWide = (): Ref<boolean> => {
	const wide = ref(typeof window !== "undefined" && window.matchMedia(SPREAD_QUERY).matches)
	let query: MediaQueryList | null = null
	const update = () => {
		wide.value = query?.matches ?? false
	}
	onMounted(() => {
		query = window.matchMedia(SPREAD_QUERY)
		update()
		query.addEventListener("change", update)
	})
	onBeforeUnmount(() => query?.removeEventListener("change", update))
	return wide
}
