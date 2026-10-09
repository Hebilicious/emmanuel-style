/**
 * Drop a front matter block from a markdown tree.
 *
 * The pipeline splits the front matter off the source before parsing, so it never
 * reaches this plugin; the plugin exists so that a body that still carries one
 * renders as markdown instead of as a thematic break followed by a heading. It
 * removes the YAML node and leaves the parsing of it to `yaml`, which is the
 * parser the pipeline already uses.
 */

import type { Root } from "mdast"
import type { Plugin } from "unified"
import { visit } from "unist-util-visit"

const remarkFrontMatter: Plugin<[], Root> = () => (tree) => {
	visit(tree, "yaml", (_node, index, parent) => {
		if (!parent || typeof index !== "number") return
		parent.children.splice(index, 1)
		return index
	})
}

export default remarkFrontMatter
