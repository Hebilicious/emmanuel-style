/**
 * The pictures a project's cover can draw (`Cover.vue`), one per kind of work.
 *
 * Listed here rather than only in the component's `switch`, so the content check can
 * refuse a project whose cover names a picture that does not exist: the component
 * would fall back to a plain initial and nobody would notice.
 */
export const MOTIFS = [
	"polls",
	"market",
	"catalog",
	"surfaces",
	"paper",
	"signal",
	"box",
	"lock",
	"form",
	"block",
	"cache",
	"snapshot",
	"switch",
	"pages",
	"template",
	"palette",
	"erase",
	"sync",
	"plug",
	"tree",
	"hook",
	"list",
	"timeline"
] as const

export type Motif = (typeof MOTIFS)[number]
