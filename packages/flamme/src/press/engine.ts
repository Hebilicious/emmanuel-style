/**
 * The press: the paper's living surface, drawn on the GPU.
 *
 * A newspaper of the next century is not printed once. The sheet is alive: ink
 * drifts in it, the row being read is lit, a print head sweeps the spread when a
 * page turns, and the picture on the front page is not flat. This module draws all
 * of that on one transparent canvas laid over the whole screen. It never takes a
 * click, and the page under it is ordinary HTML, so everything still works without
 * it (no WebGL, reduced motion): the paper is only stiller.
 *
 * Two scenes, drawn in order:
 *
 *   the sheet   in screen pixels: the motes of ink, the lamp on the row under the
 *               cursor, the light of the pointer, the print head's sweep, the grain
 *   the relief  in a camera of its own, inside the frame of the plate: the portrait
 *               as a field of halftone dots raised by how light each one is, so it
 *               turns like a thing rather than a picture
 *
 * The engine knows nothing of Vue or the DOM. `components/Press.vue` measures the
 * page and hands it a `PressFrame` every frame.
 */
import {
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	DoubleSide,
	Group,
	LinearFilter,
	Mesh,
	NoColorSpace,
	OrthographicCamera,
	PerspectiveCamera,
	PlaneGeometry,
	Points,
	Scene,
	ShaderMaterial,
	type Texture,
	TextureLoader,
	Vector2,
	Vector3,
	Vector4,
	WebGLRenderer
} from "three"
import {
	DECK_FRAGMENT,
	DECK_VERTEX,
	MOTES_FRAGMENT,
	MOTES_VERTEX,
	RELIEF_FRAGMENT,
	RELIEF_VERTEX,
	SHEET_FRAGMENT,
	SHEET_VERTEX
} from "./shaders.js"

export type Rgb = readonly [number, number, number]

export interface Box {
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
}

/** What the page looks like this frame, in CSS pixels from the top left of the screen. */
export interface PressFrame {
	readonly width: number
	readonly height: number
	readonly dark: boolean
	readonly ink: Rgb
	readonly accent: Rgb
	readonly paper: Rgb
	/** The pointer, when a mouse is over the page. */
	readonly pointer: { readonly x: number; readonly y: number } | null
	/** The row under the reading cursor. */
	readonly lamp: Box | null
	/** The reading pane, which the print head sweeps. */
	readonly pane: Box | null
	/**
	 * The plate the relief is drawn in, and the picture it is made from: a photograph,
	 * raised by how light it is, or a `model`, a render whose alpha is how near each
	 * pixel is, raised by that.
	 */
	readonly relief: (Box & { readonly src: string; readonly model: boolean }) | null
	/**
	 * The deck of plates, where the page could draw its HTML into a canvas: the stage
	 * it stands in, the strip of plates, and each plate's place round the front one.
	 */
	readonly deck: {
		readonly box: Box
		readonly atlas: HTMLCanvasElement
		readonly tiles: number
		readonly version: number
		readonly places: readonly number[]
	} | null
	/** A page turn in progress: which way it goes and how far along it is, 0 to 1. */
	readonly turn: {
		readonly forward: boolean
		readonly progress: number
		/**
		 * The turning leaf: where its hinge is across the screen, where its
		 * free edge is seen, and how far the leaf stands off the page (0 flat, 1 upright).
		 */
		readonly fold: { readonly x: number; readonly edge: number; readonly lift: number } | null
	} | null
}

export interface Press {
	/** Draw one frame. `time` is in seconds. */
	draw(frame: PressFrame, time: number): void
	/** Whether the relief has a picture and is drawn: the page hides its flat copy then. */
	readonly reliefShown: boolean
	/** Whether the deck is drawn on the GPU: the page hides its HTML deck then. */
	readonly deckShown: boolean
	/** Draw the press's own motes, or leave the ink to the WebGPU simulation. */
	setMotes(on: boolean): void
	dispose(): void
}

/** The most motes of ink that drift in the sheet, and the area of sheet to each. */
const MOTES = 900
const MOTE_AREA = 1900
/** The most dots along one side of the relief, and the width of plate to each. */
const RELIEF_SIDE = 96
const RELIEF_CELL = 3
const RELIEF_FOV = 28

/** Move `value` towards `target`, covering most of the way in about `seconds`. */
const ease = (value: number, target: number, dt: number, seconds: number): number =>
	value + (target - value) * (1 - Math.exp(-dt / Math.max(seconds, 1e-4)))

const random = (seed: number) => {
	let state = seed
	return () => {
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export const createPress = (canvas: HTMLCanvasElement): Press | null => {
	let renderer: WebGLRenderer
	try {
		renderer = new WebGLRenderer({
			canvas,
			alpha: true,
			antialias: false,
			premultipliedAlpha: true,
			powerPreference: "low-power",
			stencil: false,
			depth: false
		})
	} catch {
		return null
	}
	renderer.autoClear = false
	renderer.setClearColor(0x000000, 0)

	/* ------------------------------------------------------------- the sheet */

	const flat = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
	const sheetUniforms = {
		uSize: { value: new Vector2(1, 1) },
		uDpr: { value: 1 },
		uTime: { value: 0 },
		uDark: { value: 1 },
		uInk: { value: new Vector3(1, 1, 1) },
		uAccent: { value: new Vector3(0, 1, 1) },
		uLamp: { value: new Vector4(0, 0, 0, 0) },
		uLampOn: { value: 0 },
		uPointer: { value: new Vector3(0, 0, 0) },
		uPane: { value: new Vector4(0, 0, 1, 1) },
		uSweep: { value: 0 },
		uSweepOn: { value: 0 },
		uSweepDir: { value: 1 },
		/** The fold: its x, the leaf's free edge, how present it is, whether the back is painted. */
		uFold: { value: new Vector4(0, 0, 0, 0) },
		uPaper: { value: new Vector3(0, 0, 0) }
	}
	const sheetScene = new Scene()
	const sheet = new Mesh(
		new PlaneGeometry(2, 2),
		new ShaderMaterial({
			uniforms: sheetUniforms,
			vertexShader: SHEET_VERTEX,
			fragmentShader: SHEET_FRAGMENT,
			transparent: true,
			premultipliedAlpha: true,
			depthTest: false,
			depthWrite: false
		})
	)
	sheet.frustumCulled = false
	sheetScene.add(sheet)

	const rnd = random(20260)
	const seeds = new Float32Array(MOTES * 4)
	for (let index = 0; index < seeds.length; index += 1) seeds[index] = rnd()
	const moteGeometry = new BufferGeometry()
	moteGeometry.setAttribute("position", new BufferAttribute(new Float32Array(MOTES * 3), 3))
	moteGeometry.setAttribute("aSeed", new BufferAttribute(seeds, 4))
	const motes = new Points(
		moteGeometry,
		new ShaderMaterial({
			uniforms: sheetUniforms,
			vertexShader: MOTES_VERTEX,
			fragmentShader: MOTES_FRAGMENT,
			transparent: true,
			premultipliedAlpha: true,
			depthTest: false,
			depthWrite: false
		})
	)
	motes.frustumCulled = false
	sheetScene.add(motes)

	/* ------------------------------------------------------------ the relief */

	const camera = new PerspectiveCamera(RELIEF_FOV, 1, 0.1, 10)
	/** Far enough back that the plate, a unit square, fills the frame with a margin to turn in. */
	const distance = (0.5 / Math.tan(((RELIEF_FOV / 2) * Math.PI) / 180)) * 1.16
	camera.position.set(0, 0, distance)

	const reliefUniforms = {
		uPhoto: { value: null as Texture | null },
		uTime: { value: 0 },
		uDark: { value: 1 },
		uInk: { value: new Vector3(1, 1, 1) },
		uAccent: { value: new Vector3(0, 1, 1) },
		/** How much of the picture has been printed, 0 to 1. */
		uPrint: { value: 0 },
		/** Where the pointer presses on the plate (in its own 0..1 square), and how hard. */
		uPoke: { value: new Vector3(0.5, 0.5, 0) },
		/** Pixels per unit of the plate at the plate's own depth. */
		uScale: { value: 1 },
		/** Dots along one side of this plate, which depends on how large it is drawn. */
		uSide: { value: RELIEF_SIDE },
		/** 0 for a photograph, 1 for a model with its depth in the alpha. */
		uModel: { value: 0 },
		uDistance: { value: distance }
	}
	const count = RELIEF_SIDE * RELIEF_SIDE
	// A dot knows its number; the shader works out its place on a grid of `uSide`.
	const numbers = new Float32Array(count)
	const jitter = new Float32Array(count * 3)
	for (let index = 0; index < count; index += 1) {
		numbers[index] = index
		jitter[index * 3] = rnd()
		jitter[index * 3 + 1] = rnd()
		jitter[index * 3 + 2] = rnd()
	}
	const reliefGeometry = new BufferGeometry()
	reliefGeometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 3), 3))
	reliefGeometry.setAttribute("aIndex", new BufferAttribute(numbers, 1))
	reliefGeometry.setAttribute("aRand", new BufferAttribute(jitter, 3))
	const dots = new Points(
		reliefGeometry,
		new ShaderMaterial({
			uniforms: reliefUniforms,
			vertexShader: RELIEF_VERTEX,
			fragmentShader: RELIEF_FRAGMENT,
			transparent: true,
			premultipliedAlpha: true,
			depthTest: false,
			depthWrite: false
		})
	)
	dots.frustumCulled = false
	const plate = new Group()
	plate.add(dots)
	const reliefScene = new Scene()
	reliefScene.add(plate)

	/* -------------------------------------------------------------- the deck */

	/** The most plates the deck draws. */
	const SHEETS = 8
	const deckCamera = new PerspectiveCamera(30, 1, 1, 20000)
	const deckScene = new Scene()
	const deckTexture = new CanvasTexture(document.createElement("canvas"))
	deckTexture.colorSpace = NoColorSpace
	deckTexture.minFilter = LinearFilter
	deckTexture.generateMipmaps = false
	const sheetGeometry = new PlaneGeometry(1, 1)
	/** A plate, and its reflection in the floor under it. */
	const sheets = Array.from({ length: SHEETS }, () => {
		const make = (mirror: number) => {
			const mesh = new Mesh(
				sheetGeometry,
				new ShaderMaterial({
					uniforms: {
						uAtlas: { value: deckTexture },
						uTile: { value: 0 },
						uTiles: { value: 1 },
						uAlpha: { value: 0 },
						uFront: { value: 0 },
						uMirror: { value: mirror },
						uAccent: { value: new Vector3(0, 1, 1) },
						uLight: { value: new Vector2(0, 0) }
					},
					vertexShader: DECK_VERTEX,
					fragmentShader: DECK_FRAGMENT,
					// A reflection is the plate turned over, so both faces are drawn.
					side: DoubleSide,
					transparent: true,
					premultipliedAlpha: true,
					depthTest: false,
					depthWrite: false
				})
			)
			mesh.frustumCulled = false
			deckScene.add(mesh)
			return mesh
		}
		return { plate: make(0), mirror: make(1), place: 0, set: false }
	})
	let deckVersion = -1
	let deckAlpha = 0
	let deckAtlas: HTMLCanvasElement | null = null
	const light = new Vector2(0, 0)

	const drawDeck = (frame: PressFrame, dt: number, time: number) => {
		const deck = frame.deck
		const present = deck !== null && deck.version > 0 && frame.turn === null
		deckAlpha = ease(deckAlpha, present ? 1 : 0, dt, present ? 0.35 : 0.08)
		if (deck === null || deckAlpha < 0.01) return

		if (deck.atlas !== deckAtlas || deck.version !== deckVersion) {
			deckAtlas = deck.atlas
			deckVersion = deck.version
			deckTexture.image = deck.atlas
			deckTexture.needsUpdate = true
		}

		const { box } = deck
		// The plates stand in the upper part of the stage; the floor reflects them below.
		const height = box.h * 0.7
		const width = Math.min(height * (16 / 9), box.w * 0.5)
		const tall = width * (9 / 16)
		const floor = box.h / 2 - box.h * 0.05 - tall

		// The light is where the pointer is, or drifts when there is none.
		const wanted =
			frame.pointer === null
				? { x: Math.sin(time * 0.4) * 0.5, y: 0.3 }
				: {
						x: Math.max(-1.2, Math.min(1.2, (frame.pointer.x - (box.x + box.w / 2)) / box.w)),
						y: Math.max(-1, Math.min(1, ((box.y + box.h / 2 - frame.pointer.y) / box.h) * 0.6))
					}
		light.set(ease(light.x, wanted.x, dt, 0.25), ease(light.y, wanted.y, dt, 0.25))

		sheets.forEach((sheet, index) => {
			const target = deck.places[index]
			const shown = target !== undefined && index < deck.tiles
			sheet.plate.visible = shown
			sheet.mirror.visible = shown
			if (!shown) return
			sheet.place = sheet.set ? ease(sheet.place, target, dt, 0.28) : target
			sheet.set = true
			const away = Math.abs(sheet.place)
			const x = sheet.place * width * 1.05
			const z = -away * width * 0.55
			const turn = -sheet.place * 0.75
			const alpha = Math.max(0, Math.min(1, 1.15 - away * 0.5)) * deckAlpha
			for (const [mesh, y, flip] of [
				[sheet.plate, floor + tall / 2, 1],
				[sheet.mirror, floor - tall / 2 - 3, -1]
			] as const) {
				mesh.position.set(x, y, z)
				mesh.rotation.set(0, turn, 0)
				mesh.scale.set(width, tall * flip, 1)
				mesh.renderOrder = 100 - Math.round(away * 10)
				const u = (mesh.material as ShaderMaterial).uniforms
				u["uTile"]!.value = index
				u["uTiles"]!.value = deck.tiles
				u["uAlpha"]!.value = alpha
				u["uFront"]!.value = Math.max(0, 1 - away)
				;(u["uAccent"]!.value as Vector3).set(...frame.accent)
				;(u["uLight"]!.value as Vector2).copy(light)
			}
		})

		// The eye is close to the stage, so the plates turned away foreshorten.
		const eye = Math.max(box.w * 0.9, 420)
		deckCamera.fov = (2 * Math.atan(box.h / 2 / eye) * 180) / Math.PI
		deckCamera.aspect = box.w / box.h
		deckCamera.position.set(0, box.h * 0.06, eye)
		deckCamera.lookAt(0, 0, 0)
		deckCamera.updateProjectionMatrix()

		const bottom = frame.height - (box.y + box.h)
		renderer.setViewport(box.x, bottom, box.w, box.h)
		renderer.setScissor(box.x, bottom, box.w, box.h)
		renderer.setScissorTest(true)
		renderer.render(deckScene, deckCamera)
		renderer.setScissorTest(false)
	}

	/* ------------------------------------------------------------- its state */

	const loader = new TextureLoader()
	let photoSrc = ""
	let photoReady = false
	const loadPhoto = (src: string) => {
		photoSrc = src
		photoReady = false
		loader.load(src, (texture) => {
			if (src !== photoSrc) {
				texture.dispose()
				return
			}
			texture.colorSpace = NoColorSpace
			texture.minFilter = LinearFilter
			texture.generateMipmaps = false
			reliefUniforms.uPhoto.value?.dispose()
			reliefUniforms.uPhoto.value = texture
			photoReady = true
		})
	}

	let last = 0
	let size = ""
	const lamp = { x: 0, y: 0, w: 0, h: 0, on: 0 }
	const pointer = { x: 0, y: 0, on: 0 }
	const tilt = { x: 0, y: 0 }
	let sweepOn = 0
	let poke = 0
	let reliefBox: Box | null = null

	const draw = (frame: PressFrame, time: number) => {
		const dt = Math.min(0.05, last === 0 ? 0.016 : time - last)
		last = time

		// The sheet is soft light and grain: more pixels than this cost a laptop and show nothing.
		const dpr = Math.min(window.devicePixelRatio || 1, 1.25)
		const wanted = `${frame.width}x${frame.height}@${dpr}`
		if (wanted !== size) {
			size = wanted
			renderer.setPixelRatio(dpr)
			renderer.setSize(frame.width, frame.height, false)
			// As much ink as the sheet is large: a phone's has a quarter of a desk's.
			moteGeometry.setDrawRange(
				0,
				Math.min(MOTES, Math.round((frame.width * frame.height) / MOTE_AREA))
			)
		}

		const turning = frame.turn !== null

		/* The lamp glides to the row under the cursor; over a turn it is put out and relit. */
		if (frame.lamp !== null && !turning) {
			if (lamp.on < 0.05) Object.assign(lamp, frame.lamp)
			lamp.x = ease(lamp.x, frame.lamp.x, dt, 0.09)
			lamp.y = ease(lamp.y, frame.lamp.y, dt, 0.09)
			lamp.w = ease(lamp.w, frame.lamp.w, dt, 0.09)
			lamp.h = ease(lamp.h, frame.lamp.h, dt, 0.09)
			lamp.on = ease(lamp.on, 1, dt, 0.18)
		} else lamp.on = ease(lamp.on, 0, dt, 0.08)

		if (frame.pointer !== null) {
			pointer.x = ease(pointer.x, frame.pointer.x, dt, 0.05)
			pointer.y = ease(pointer.y, frame.pointer.y, dt, 0.05)
			pointer.on = ease(pointer.on, 1, dt, 0.25)
		} else pointer.on = ease(pointer.on, 0, dt, 0.4)

		sweepOn = ease(sweepOn, turning ? 1 : 0, dt, turning ? 0.06 : 0.22)

		const u = sheetUniforms
		u.uSize.value.set(frame.width, frame.height)
		u.uDpr.value = dpr
		u.uTime.value = time
		u.uDark.value = frame.dark ? 1 : 0
		u.uInk.value.set(...frame.ink)
		u.uAccent.value.set(...frame.accent)
		u.uLamp.value.set(lamp.x, lamp.y, lamp.w, lamp.h)
		u.uLampOn.value = lamp.on
		u.uPointer.value.set(pointer.x, pointer.y, pointer.on)
		if (frame.pane !== null)
			u.uPane.value.set(frame.pane.x, frame.pane.y, frame.pane.w, frame.pane.h)
		if (frame.turn !== null) {
			// Forward, the leaf folds from the right edge to the left; the head follows it.
			u.uSweep.value = frame.turn.forward ? 1 - frame.turn.progress : frame.turn.progress
			u.uSweepDir.value = frame.turn.forward ? -1 : 1
		}
		u.uSweepOn.value = sweepOn
		const fold = frame.turn?.fold ?? null
		if (fold === null) u.uFold.value.z = 0
		else u.uFold.value.set(fold.x, fold.edge, 1, fold.lift)
		u.uPaper.value.set(...frame.paper)

		renderer.setScissorTest(false)
		renderer.setViewport(0, 0, frame.width, frame.height)
		renderer.clear()
		renderer.render(sheetScene, flat)

		drawDeck(frame, dt, time)

		/* The relief: printed when its plate is on the page, dissolved when a page turns. */
		const wantedRelief = frame.relief
		if (wantedRelief !== null && wantedRelief.src !== photoSrc) loadPhoto(wantedRelief.src)
		const present = wantedRelief !== null && photoReady && !turning
		if (wantedRelief !== null) {
			reliefBox = wantedRelief
			// A dot every few pixels, whatever the plate's size.
			const side = Math.max(24, Math.min(RELIEF_SIDE, Math.round(wantedRelief.w / RELIEF_CELL)))
			reliefUniforms.uSide.value = side
			reliefUniforms.uModel.value = wantedRelief.model ? 1 : 0
			// A model has room around it in its own picture, so the camera comes closer.
			camera.position.z = wantedRelief.model ? distance * 0.9 : distance
			reliefGeometry.setDrawRange(0, side * side)
		}
		const r = reliefUniforms
		r.uPrint.value = present
			? Math.min(1, r.uPrint.value + dt / 1.5)
			: Math.max(0, r.uPrint.value - dt / 0.22)
		if (r.uPrint.value <= 0 || reliefBox === null) return

		const box = reliefBox
		let pokeTarget = 0
		// Left alone, the plate sways. Otherwise it turns to face what the reader is on:
		// the pointer, or with the keyboard the row under the cursor.
		let tiltX = Math.sin(time * 0.31) * 0.2
		let tiltY = Math.sin(time * 0.23 + 1.3) * 0.07
		const watched =
			frame.pointer ??
			(frame.lamp === null
				? null
				: { x: frame.lamp.x + frame.lamp.w / 2, y: frame.lamp.y + frame.lamp.h / 2 })
		if (watched !== null) {
			const px = (watched.x - box.x) / box.w
			const py = (watched.y - box.y) / box.h
			// The nearer it is, the more the plate gives up its sway to face it.
			const reach = Math.max(0, 1 - Math.hypot(px - 0.5, py - 0.5) / 4.5)
			const clamp = (value: number, most: number) => Math.max(-most, Math.min(most, value))
			tiltX = tiltX * (1 - reach) + clamp((px - 0.5) * 0.32, 0.6) * reach
			tiltY = tiltY * (1 - reach) + clamp((py - 0.5) * 0.22, 0.35) * reach
			if (frame.pointer !== null && px > 0 && px < 1 && py > 0 && py < 1) {
				pokeTarget = 1
				r.uPoke.value.x = px
				r.uPoke.value.y = py
			}
		}
		tilt.x = ease(tilt.x, tiltX, dt, 0.25)
		tilt.y = ease(tilt.y, tiltY, dt, 0.25)
		poke = ease(poke, pokeTarget, dt, 0.2)
		plate.rotation.set(tilt.y, tilt.x, 0)

		r.uPoke.value.z = poke
		r.uTime.value = time
		r.uDark.value = frame.dark ? 1 : 0
		r.uInk.value.set(...frame.ink)
		r.uAccent.value.set(...frame.accent)
		r.uScale.value = (box.h * dpr) / (2 * Math.tan(((RELIEF_FOV / 2) * Math.PI) / 180))
		camera.aspect = box.w / box.h
		camera.updateProjectionMatrix()

		// The plate is a window: the relief is drawn inside its frame and cut at its edge.
		const bottom = frame.height - (box.y + box.h)
		renderer.setViewport(box.x, bottom, box.w, box.h)
		renderer.setScissor(box.x, bottom, box.w, box.h)
		renderer.setScissorTest(true)
		renderer.render(reliefScene, camera)
		renderer.setScissorTest(false)
	}

	return {
		draw,
		setMotes(on) {
			motes.visible = on
		},
		get deckShown() {
			return deckAlpha > 0.5
		},
		get reliefShown() {
			return photoReady && reliefUniforms.uPrint.value > 0.02
		},
		dispose() {
			reliefUniforms.uPhoto.value?.dispose()
			deckTexture.dispose()
			sheetGeometry.dispose()
			for (const sheet of sheets) {
				;(sheet.plate.material as ShaderMaterial).dispose()
				;(sheet.mirror.material as ShaderMaterial).dispose()
			}
			moteGeometry.dispose()
			reliefGeometry.dispose()
			sheet.geometry.dispose()
			for (const object of [sheet, motes, dots]) (object.material as ShaderMaterial).dispose()
			renderer.dispose()
		}
	}
}
