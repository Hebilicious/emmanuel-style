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
	float light = lamp * 0.085 + torch * 0.05 + head * 0.2;
	light *= mix(0.45, 1.0, screen);
	// On light paper the same light is a tint of ink, and less of it reads as much.
	light *= mix(0.6, 1.0, uDark);

	// The grain of the paper, still in dark and light alike.
	float grain = hash(floor(p * uDpr) + floor(uTime * 24.0) * 17.0);
	float speck = smoothstep(0.86, 1.0, grain) * 0.035;

	vec3 tint = mix(uAccent, uInk, 0.25);
	float alpha = clamp(light + speck, 0.0, 1.0);
	vec3 colour = (tint * light + uInk * speck) / max(alpha, 1e-4);
	gl_FragColor = vec4(colour * alpha, alpha);
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
uniform float uCell;
uniform float uDistance;
attribute vec2 aUv;
attribute vec3 aRand;
varying float vAlpha;
varying float vGlow;
varying float vTone;

void main() {
	float light = texture2D(uPhoto, vec2(aUv.x, 1.0 - aUv.y)).r;
	// On dark paper the lights are printed; on light paper, the shadows.
	float tone = mix(1.0 - light, light, uDark);
	tone = smoothstep(0.04, 0.96, tone);

	// Each dot stands as high as it is light, so the face has relief.
	vec3 at = vec3(aUv.x - 0.5, 0.5 - aUv.y, (light - 0.42) * 0.2);
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
	gl_Position = projectionMatrix * view;
	float size = uCell * (0.12 + 0.86 * pow(tone, 1.15)) * (1.0 + pressed * 0.7);
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
