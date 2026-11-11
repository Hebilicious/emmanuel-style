/**
 * The deck, when the browser can draw HTML into a canvas.
 *
 * The front page's deck of plates is ordinary HTML: each plate is an SVG the page
 * drew, set in perspective with CSS. Where the browser has HTML-in-canvas (an
 * element laid out inside a canvas can be drawn into it), the same live plates
 * become the textures of a scene on the GPU instead: sheets standing on a floor
 * that reflects them, lit from where the pointer is. They are the page's own
 * elements, not pictures of them, so a plate that redraws its lines redraws them
 * in the scene.
 *
 * `CoverDeck.vue` lays its plates out a second time inside a capture canvas and
 * draws them into one strip (the atlas), again whenever one repaints. It leaves
 * the strip here, keyed by its stage, and the press picks it up for the stage that
 * is on show. The HTML deck stays where it is, and is what shows until the press
 * says it has drawn the scene, and wherever the feature is missing.
 */

/** The size of one plate in the atlas, in canvas pixels. */
export const TILE = { width: 512, height: 288 } as const

export interface DeckSource {
	/** The strip of plates, one tile each, left to right. */
	readonly atlas: HTMLCanvasElement
	readonly tiles: number
	/** Goes up every time the strip is redrawn, so the texture is uploaded again. */
	version: number
}

type ElementContext = CanvasRenderingContext2D & {
	drawElementImage(element: Element, x: number, y: number): unknown
}

/** Whether an element laid out inside a canvas can be drawn into it. */
export const canDrawElements = (): boolean =>
	typeof CanvasRenderingContext2D !== "undefined" &&
	"drawElementImage" in CanvasRenderingContext2D.prototype &&
	typeof HTMLCanvasElement !== "undefined" &&
	"layoutSubtree" in HTMLCanvasElement.prototype

const sources = new WeakMap<Element, DeckSource>()

export const deckOf = (stage: Element): DeckSource | undefined => sources.get(stage)

/**
 * Keep a stage's atlas drawn from the plates laid out in its capture canvas.
 * Returns the function that stops it.
 */
export const captureDeck = (stage: Element, canvas: HTMLCanvasElement): (() => void) => {
	const context = canvas.getContext("2d") as ElementContext | null
	if (context === null) return () => undefined
	const source: DeckSource = { atlas: canvas, tiles: canvas.children.length, version: 0 }

	const draw = () => {
		try {
			context.clearRect(0, 0, canvas.width, canvas.height)
			Array.from(canvas.children).forEach((plate, index) => {
				context.drawElementImage(plate, index * TILE.width, 0)
			})
			source.version += 1
			sources.set(stage, source)
		} catch {
			// A plate with no paint record yet: the next paint draws it.
		}
	}

	// The canvas says when one of its children has been painted again.
	canvas.addEventListener("paint", draw)
	const first = requestAnimationFrame(() => requestAnimationFrame(draw))
	return () => {
		cancelAnimationFrame(first)
		canvas.removeEventListener("paint", draw)
		sources.delete(stage)
	}
}
