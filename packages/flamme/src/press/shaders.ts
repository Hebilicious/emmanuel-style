/**
 * The press's shaders.
 *
 * Every colour that leaves a fragment shader is premultiplied by its alpha: the
 * canvas is laid over the page and blended by the browser, which expects that.
 * Colours come in as the theme's ink and accent in sRGB and go out as they are.
 */

const COMMON = /* glsl */ `
uniform vec2 uSize;
uniform float uDpr;
uniform float uTime;
uniform float uDark;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform vec4 uLamp;
uniform float uLampOn;
uniform vec3 uPointer;
uniform vec4 uPane;
uniform float uSweep;
uniform float uSweepOn;
uniform float uSweepDir;
uniform vec4 uFold;
uniform vec3 uPaper;

float hash(vec2 p) {
	vec3 q = fract(vec3(p.xyx) * 0.1031);
	q += dot(q, q.yzx + 33.33);
	return fract((q.x + q.y) * q.z);
}

/* Distance to a box centred on the origin; negative inside. */
float box(vec2 p, vec2 extent) {
	vec2 d = abs(p) - extent;
	return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

/* Where the print head is, across the pane. */
float headX() {
	return mix(uPane.x - 80.0, uPane.x + uPane.z + 80.0, uSweep);
}
`

/* ----------------------------------------------------------------- the sheet */

export const SHEET_VERTEX = /* glsl */ `
void main() {
	gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const SHEET_FRAGMENT = /* glsl */ `
precision highp float;
${COMMON}

void main() {
	// The fragment's place on the page, in CSS pixels from the top left.
	vec2 p = vec2(gl_FragCoord.x, uSize.y * uDpr - gl_FragCoord.y) / uDpr;

	// The lamp: light that falls off around the row under the cursor.
	vec2 centre = uLamp.xy + uLamp.zw * 0.5;
	float edge = box(p - centre, uLamp.zw * 0.5);
	float lamp = exp(-max(edge, 0.0) / 46.0) * uLampOn;
	// Strongest at the edge of the row: inside it the light thins out, so a large
	// card is lit round its rim rather than washed over.
	lamp *= 0.25 + 0.75 * exp(-max(-edge, 0.0) / 18.0);

	// The pointer carries a smaller light of its own.
	vec2 toPointer = p - uPointer.xy;
	float torch = exp(-dot(toPointer, toPointer) / (2.0 * 90.0 * 90.0)) * uPointer.z;

	// The print head: a band of light crossing the pane with the turning leaf.
	float inPane = step(uPane.y, p.y) * step(p.y, uPane.y + uPane.w)
		* step(uPane.x, p.x) * step(p.x, uPane.x + uPane.z);
	float fromHead = (p.x - headX()) * uSweepDir;
	// Sharp ahead of the head, a long tail of drying ink behind it.
	float head = (fromHead > 0.0 ? exp(-fromHead / 7.0) : exp(fromHead / 150.0)) * uSweepOn * inPane;

	// All of it is light through a halftone screen, so it reads as print, not as glow.
	vec2 cell = mat2(0.7071, -0.7071, 0.7071, 0.7071) * p / 4.5;
	float screen = smoothstep(0.5, 0.18, length(fract(cell) - 0.5));
	// A real turn is shaded as a fold (below); the band is the press's own first pass.
	head *= 1.0 - uFold.z;
	float light = lamp * 0.085 + torch * 0.05 + head * 0.2;
	light *= mix(0.45, 1.0, screen);
	// On light paper the same light is a tint of ink, and less of it reads as much.
	light *= mix(0.6, 1.0, uDark);

	// The grain of the paper, still in dark and light alike.
	float grain = hash(floor(p * uDpr) + floor(uTime * 24.0) * 17.0);
	float speck = smoothstep(0.86, 1.0, grain) * 0.035;

	vec3 tint = mix(uAccent, uInk, 0.25);
	float alpha = clamp(light + speck, 0.0, 1.0);
	vec4 sheet = vec4(tint * light + uInk * speck, alpha);

	/*
	 * The fold of a turning leaf. The browser moves the pages; what makes it paper
	 * is the light: the leaf curves up to the fold, so it darkens toward it and
	 * catches a line of light along it; it throws a shadow on the page it is leaving
	 * behind it, and another, past its free edge, on the page it is coming down on.
	 */
	float fold = uFold.x;
	float tip = uFold.y;
	float side = sign(tip - fold);            // which side of the fold the leaf lies on
	float width = abs(tip - fold);
	float fromFold = (p.x - fold) * side;      // positive on the leaf's side
	float onLeaf = step(0.0, fromFold) * step(fromFold, width);
	float grown = smoothstep(0.0, 28.0, width) * uFold.z * inPane;

	float bend = onLeaf * (0.34 * exp(-fromFold / (width * 0.22 + 10.0)) + 0.1 * smoothstep(width - 26.0, width, fromFold));
	float behind = step(fromFold, 0.0) * 0.5 * exp(fromFold / 34.0);
	float thrown = step(width, fromFold) * 0.46 * exp(-(fromFold - width) / 26.0);
	float shade = clamp((bend + behind + thrown) * grown, 0.0, 0.8);
	float glint = onLeaf * exp(-fromFold / 2.2) * 0.55 * grown;

	// On a phone the leaf's back is not a page of its own: the press paints it as paper.
	float back = onLeaf * uFold.w * uFold.z * inPane;
	vec4 leaf = vec4(mix(uPaper, uInk, 0.07) * back, back);
	// Shade over the leaf, then the line of light.
	leaf = vec4(leaf.rgb * (1.0 - shade), shade + leaf.a * (1.0 - shade));
	// On dark paper a shadow does not show, so the leaf is told from the page under it
	// by light instead: it is lifted toward the lamp, most where it curves at the fold,
	// and its free edge is drawn.
	float lifted = onLeaf * (0.035 + 0.11 * exp(-fromFold / (width * 0.3 + 14.0))) * grown * uDark;
	float rim = exp(-abs(fromFold - width) / 1.1) * 0.5 * grown;
	vec3 lampLight = mix(vec3(1.0), uAccent, 0.35);
	leaf.rgb += lampLight * (glint + lifted) + mix(uInk, uAccent, 0.5) * rim * 0.6;
	leaf.a = max(leaf.a, max(glint, max(lifted, rim * 0.6)));

	gl_FragColor = leaf + sheet * (1.0 - leaf.a);
}
`

/* ----------------------------------------------------------------- the motes */

export const MOTES_VERTEX = /* glsl */ `
${COMMON}
attribute vec4 aSeed;
varying float vAlpha;
varying float vAccent;

void main() {
	// Each mote drifts on a slow path of its own and wraps at the edges of the sheet.
	float pace = 0.5 + aSeed.z;
	float t = uTime * 0.035 * pace;
	vec2 p = aSeed.xy * uSize;
	p += vec2(
		sin(t * 2.1 + aSeed.w * 6.283) * 70.0 + t * 26.0,
		cos(t * 1.7 + aSeed.z * 6.283) * 50.0 - t * 11.0
	);
	p = mod(p, uSize);

	// Ink gathers toward the lit row.
	vec2 centre = uLamp.xy + uLamp.zw * 0.5;
	vec2 toLamp = centre - p;
	float near = exp(-max(box(-toLamp, uLamp.zw * 0.5), 0.0) / 120.0) * uLampOn;
	p += toLamp * near * 0.07;

	// And is stirred by the pointer as it passes.
	vec2 fromPointer = p - uPointer.xy;
	float reach = length(fromPointer);
	float stirred = exp(-reach / 110.0) * uPointer.z;
	p += vec2(-fromPointer.y, fromPointer.x) / max(reach, 1.0) * stirred * 22.0;

	// The print head pushes ink ahead of it.
	float inPane = step(uPane.y, p.y) * step(p.y, uPane.y + uPane.w);
	float pushed = exp(-pow((p.x - headX()) / 110.0, 2.0)) * uSweepOn * inPane;
	p.x += uSweepDir * pushed * 46.0;

	float twinkle = 0.65 + 0.35 * sin(uTime * (0.6 + aSeed.w) + aSeed.z * 40.0);
	// Inside the lit row itself the ink stays thin, so it never sits on the words.
	float inside = step(box(p - centre, uLamp.zw * 0.5), 0.0) * uLampOn;
	vAlpha = (0.08 + 0.18 * aSeed.z) * twinkle * (1.0 + near * 1.4 + stirred * 2.0 + pushed * 4.0);
	vAlpha *= 1.0 - inside * 0.75;
	vAccent = step(0.72, aSeed.w) + near * 0.6 + pushed;
	gl_PointSize = (1.1 + aSeed.w * 1.5 + near * 1.2 + pushed * 1.5) * uDpr;
	gl_Position = vec4(p.x / uSize.x * 2.0 - 1.0, 1.0 - p.y / uSize.y * 2.0, 0.0, 1.0);
}
`

export const MOTES_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uInk;
uniform vec3 uAccent;
uniform float uDark;
varying float vAlpha;
varying float vAccent;

void main() {
	float d = length(gl_PointCoord - 0.5) * 2.0;
	float alpha = smoothstep(1.0, 0.35, d) * clamp(vAlpha, 0.0, 0.9);
	// On light paper a mote is a fleck of ink and needs less of it to show.
	alpha *= mix(0.6, 1.0, uDark);
	vec3 colour = mix(uInk, uAccent, clamp(vAccent, 0.0, 1.0));
	gl_FragColor = vec4(colour * alpha, alpha);
}
`

/* ---------------------------------------------------------------- the relief */

export const RELIEF_VERTEX = /* glsl */ `
uniform sampler2D uPhoto;
uniform float uTime;
uniform float uDark;
uniform float uPrint;
uniform vec3 uPoke;
uniform float uScale;
uniform float uSide;
uniform float uModel;
uniform float uDistance;
attribute float aIndex;
attribute vec3 aRand;
varying float vAlpha;
varying float vGlow;
varying float vTone;

void main() {
	// The dot's place on the screen: every other row half a cell over, as a halftone is.
	float row = floor(aIndex / uSide);
	float column = aIndex - row * uSide;
	vec2 aUv = vec2((column + (mod(row, 2.0) < 0.5 ? 0.25 : 0.75)) / uSide, (row + 0.5) / uSide);
	float uCell = 1.0 / uSide;

	vec4 texel = texture2D(uPhoto, vec2(aUv.x, 1.0 - aUv.y));
	float light = texel.r;
	// A model has dots only where there is something; its alpha is how near that is.
	float covered = mix(1.0, step(0.05, texel.a), uModel);
	// On dark paper the lights are printed; on light paper, the shadows.
	float tone = mix(1.0 - light, light, uDark);
	tone = smoothstep(0.04, 0.96, tone);
	// A render is mostly mid-greys: its tones are spread, so the form reads in the dots.
	tone = mix(tone, 0.08 + 0.6 * pow(tone, 2.4), uModel);

	// A photograph's dots stand as high as they are light; a model's, at its real depth.
	float height = mix((light - 0.42) * 0.2, (texel.a - 0.62) * 0.75, uModel);
	vec3 at = vec3(aUv.x - 0.5, 0.5 - aUv.y, height);
	at.z += sin(aUv.y * 11.0 - uTime * 0.8 + aUv.x * 4.0) * 0.004;

	// The pointer presses the dots under it up off the plate.
	vec2 fromPoke = aUv - uPoke.xy;
	float pressed = exp(-dot(fromPoke, fromPoke) / 0.012) * uPoke.z;
	at.z += pressed * 0.09;

	// Printing: the head comes down the plate and each dot flies in to its place.
	float arrived = clamp((uPrint * 1.4 - aUv.y - aRand.x * 0.12) / 0.28, 0.0, 1.0);
	arrived = arrived * arrived * (3.0 - 2.0 * arrived);
	vec3 from = at + vec3((aRand.x - 0.5) * 0.7, (aRand.y - 0.5) * 0.4, 0.5 + aRand.z * 0.9);
	at = mix(from, at, arrived);

	// A band of light passes over the face now and then.
	float band = exp(-pow((aUv.x + aUv.y * 0.35 - fract(uTime * 0.07) * 2.2 + 0.4) / 0.07, 2.0));

	vec4 view = modelViewMatrix * vec4(at, 1.0);
	// A dot with nothing to print is put off the plate: a point is never smaller than a pixel.
	gl_Position = covered > 0.5 ? projectionMatrix * view : vec4(2.0, 2.0, 2.0, 1.0);
	float size = uCell * (0.12 + 0.86 * pow(tone, 1.15)) * (1.0 + pressed * 0.7) * covered;
	gl_PointSize = max(size * uScale * uDistance / -view.z, 0.0);

	vTone = tone;
	vGlow = clamp(pressed * 0.9 + band * 0.55 + (1.0 - arrived), 0.0, 1.0);
	// Nearer dots are a little stronger: the plate has air in it.
	float depth = clamp(1.0 + (uDistance + view.z) * 1.4, 0.55, 1.35);
	vAlpha = arrived * (0.3 + 0.7 * tone) * depth;
}
`

export const RELIEF_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uInk;
uniform vec3 uAccent;
varying float vAlpha;
varying float vGlow;
varying float vTone;

void main() {
	float d = length(gl_PointCoord - 0.5) * 2.0;
	float alpha = smoothstep(1.0, 0.78, d) * clamp(vAlpha, 0.0, 1.0);
	vec3 colour = mix(uInk, uAccent, vGlow * 0.85);
	gl_FragColor = vec4(colour * alpha, alpha);
}
`

/* ------------------------------------------------------------------ the deck */

export const DECK_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;

void main() {
	vUv = uv;
	vNormal = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const DECK_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform float uTile;
uniform float uTiles;
uniform float uAlpha;
uniform float uFront;
uniform float uMirror;
uniform vec3 uAccent;
uniform vec2 uLight;
varying vec2 vUv;
varying vec3 vNormal;

void main() {
	// The plate's tile of the strip.
	vec4 plate = texture2D(uAtlas, vec2((uTile + vUv.x) / uTiles, vUv.y));

	// Lit from where the pointer is: a plate turned to the light is brighter, and
	// the light catches it in a band as it passes.
	vec3 towards = normalize(vec3(uLight, 0.9));
	vec3 normal = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
	float lit = 0.5 + 0.6 * max(dot(normal, towards), 0.0);
	float glint = pow(max(dot(normal, normalize(towards + vec3(0.0, 0.0, 1.0))), 0.0), 40.0);
	vec3 colour = plate.rgb * lit + uAccent * glint * 0.25;

	// Its frame, in the accent on the plate in front.
	vec2 edge = min(vUv, 1.0 - vUv) * vec2(16.0 / 9.0, 1.0);
	float frame = 1.0 - smoothstep(0.004, 0.012, min(edge.x, edge.y));
	colour = mix(colour, uAccent, frame * (0.3 + 0.7 * uFront));

	float alpha = uAlpha;
	// The reflection is faint, and fades as it leaves the floor.
	if (uMirror > 0.5) alpha *= 0.4 * pow(1.0 - vUv.y, 2.0);
	gl_FragColor = vec4(colour * alpha, alpha);
}
`
