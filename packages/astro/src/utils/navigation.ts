/**
 * Navigation shared by the terminal and the WebMCP tools.
 *
 * `ClientRouter` owns same-origin navigation, but the `navigate` helper is not
 * exported from `astro:transitions` in this version, and assigning to
 * `location` would reload the document and discard the terminal's state.
 *
 * So navigation is driven the way the router itself expects: a real anchor
 * click. The anchor is marked `data-synthetic` so the mouse gate, which exists
 * to stop *pointer* navigation, lets it through.
 */
export const go = (href: string) => {
	const anchor = document.createElement("a")
	anchor.href = href
	anchor.dataset.synthetic = "true"
	anchor.style.display = "none"
	document.body.append(anchor)
	anchor.click()
	anchor.remove()
}
