declare module "@microflash/rehype-figure" {
	import type { Plugin } from "unified"

	interface RehypeFigureOptions {
		/**
		 * The class name to apply to the figure element.
		 */
		className?: string
		/**
		 * If true, wraps the image in a figure element even if it doesn't have an alt attribute.
		 */
		dank?: boolean
	}

	const rehypeFigure: Plugin<[RehypeFigureOptions?], any>
	export default rehypeFigure
}
