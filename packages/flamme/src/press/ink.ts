/**
 * The ink, simulated on WebGPU.
 *
 * Where the browser has WebGPU, the motes of ink in the sheet are not drawn from a
 * formula: they are tens of thousands of particles with a position and a velocity
 * each, moved every frame by a compute shader. They drift on a slow current, gather
 * along the edge of the row under the reading cursor so that the row is outlined in
 * ink, are stirred into a whirl by the pointer, and are swept along by the print
 * head when a page turns. A second pass draws each one as a small soft dot.
 *
 * It is a canvas of its own under the press's, because a canvas has one context
 * and the press's is WebGL. Without WebGPU `createInk` resolves to `null` and the
 * press draws its own, simpler motes instead.
 *
 * The API is used directly: one buffer of particles, one of uniforms, a compute
 * pipeline and a render pipeline. Everything the shaders need about the page comes
 * in the uniforms, written from the same `PressFrame` the press is drawn from.
 */
import type { PressFrame } from "./engine.js"

export interface Ink {
	/** Move the ink and draw it. `time` is in seconds. */
	draw(frame: PressFrame, time: number): void
	dispose(): void
}

/** The most particles, and the area of sheet, in CSS pixels, to each. */
const MOST = 60_000
const AREA = 110

/** Seven `vec4f`: see `Frame` in the shader. */
const UNIFORM_FLOATS = 28

const SHADER = /* wgsl */ `
struct Frame {
	size: vec4f,    // width, height, device pixel ratio, time
	lamp: vec4f,    // x, y, width, height of the lit row
	pointer: vec4f, // x, y, how present the pointer is, how lit the lamp is
	pane: vec4f,    // x, y, width, height of the reading pane
	sweep: vec4f,   // where the print head is (0..1), how present, its direction, dt
	ink: vec4f,     // the ink's colour, and 1 on dark paper
	accent: vec4f,  // the accent's colour
}

struct Particle {
	at: vec2f,
	velocity: vec2f,
}

@group(0) @binding(0) var<uniform> frame: Frame;

fn hash(value: u32) -> f32 {
	var x = value;
	x ^= x >> 16u;
	x *= 0x7feb352du;
	x ^= x >> 15u;
	x *= 0x846ca68bu;
	x ^= x >> 16u;
	return f32(x) / 4294967295.0;
}

/* ------------------------------------------------------------------ moving */

@group(1) @binding(0) var<storage, read_write> moving: array<Particle>;

@compute @workgroup_size(64)
fn simulate(@builtin(global_invocation_id) id: vec3u) {
	let index = id.x;
	if (index >= arrayLength(&moving)) {
		return;
	}
	var particle = moving[index];
	let size = frame.size.xy;
	let time = frame.size.w;
	let dt = frame.sweep.w;
	let seed = hash(index);

	// The current: slow, and a little different for every particle.
	let q = particle.at * 0.0035;
	let current = vec2f(
		sin(q.y * 1.7 + time * 0.11 + seed * 6.283) + cos(q.x * 1.3 - time * 0.07),
		cos(q.x * 1.9 + time * 0.09) - sin(q.y * 1.1 + time * 0.05 + seed * 3.0)
	) * (9.0 + seed * 13.0);
	var push = (current - particle.velocity) * 1.5;

	// The lamp: ink near the lit row is drawn to its edge, and outlines it.
	let half = frame.lamp.zw * 0.5;
	let centre = frame.lamp.xy + half;
	let offset = particle.at - centre;
	let gap = abs(offset) - half;
	let distance = length(max(gap, vec2f(0.0))) + min(max(gap.x, gap.y), 0.0);
	var edge = centre + clamp(offset, -half, half);
	if (distance < 0.0) {
		let room = half - abs(offset);
		if (room.x < room.y) {
			edge.x = centre.x + sign(offset.x) * half.x;
		} else {
			edge.y = centre.y + sign(offset.y) * half.y;
		}
	}
	let lit = exp(-abs(distance) / 70.0) * frame.pointer.w;
	push += (edge - particle.at) * lit * 2.2;
	// Along the edge it keeps moving, so the outline runs rather than sits.
	let along = normalize(vec2f(-(edge.y - centre.y) * half.x, (edge.x - centre.x) * half.y) + vec2f(0.0001));
	push += along * lit * 60.0;

	// The pointer stirs it into a whirl and holds a little of it off.
	let away = particle.at - frame.pointer.xy;
	let reach = max(length(away), 1.0);
	let stirred = exp(-reach / 120.0) * frame.pointer.z;
	push += (vec2f(-away.y, away.x) / reach * 300.0 + away / reach * 70.0) * stirred;

	// The print head carries ink along with it as it crosses the pane.
	let head = mix(frame.pane.x - 80.0, frame.pane.x + frame.pane.z + 80.0, frame.sweep.x);
	let inPane = step(frame.pane.y, particle.at.y) * step(particle.at.y, frame.pane.y + frame.pane.w);
	let swept = exp(-pow((particle.at.x - head) / 110.0, 2.0)) * frame.sweep.y * inPane;
	push.x += frame.sweep.z * swept * 1100.0;

	particle.velocity += push * dt;
	particle.at += particle.velocity * dt;
	// The sheet has no edge: what leaves one side comes back on the other.
	particle.at = particle.at - size * floor(particle.at / size);

	// Now and then a particle is lifted and set down somewhere else, so ink never
	// all ends up in one place.
	let tick = u32(time * 30.0);
	if (hash(index * 7919u + tick * 104729u) < dt * 0.05) {
		particle.at = vec2f(hash(index + tick * 31u), hash(index * 3u + tick * 17u)) * size;
		particle.velocity = vec2f(0.0);
	}
	moving[index] = particle;
}

/* ----------------------------------------------------------------- drawing */

@group(1) @binding(0) var<storage, read> still: array<Particle>;

struct Dot {
	@builtin(position) position: vec4f,
	@location(0) corner: vec2f,
	@location(1) alpha: f32,
	@location(2) tint: f32,
}

@vertex
fn place(@builtin(vertex_index) corner: u32, @builtin(instance_index) index: u32) -> Dot {
	// A dot is two triangles.
	var CORNERS = array<vec2f, 6>(
		vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
		vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
	);
	let particle = still[index];
	let seed = hash(index);
	let speed = length(particle.velocity);
	// Faster ink is brighter and a little larger: the eye follows what moves.
	let quick = min(speed / 55.0, 2.5);
	let radius = 0.55 + seed * 0.75 + quick * 0.35;
	let at = particle.at + CORNERS[corner] * radius;
	var dot: Dot;
	dot.position = vec4f(at.x / frame.size.x * 2.0 - 1.0, 1.0 - at.y / frame.size.y * 2.0, 0.0, 1.0);
	dot.corner = CORNERS[corner];
	// Still ink is faint enough to read through; it is the moving ink that shows.
	dot.alpha = (0.025 + 0.07 * seed) * (1.0 + quick * 3.2) * mix(0.6, 1.0, frame.ink.w);
	dot.tint = clamp(step(0.74, hash(index * 13u)) + quick * 0.5, 0.0, 1.0);
	return dot;
}

@fragment
fn colour(dot: Dot) -> @location(0) vec4f {
	let alpha = smoothstep(1.0, 0.25, length(dot.corner)) * min(dot.alpha, 0.85);
	let ink = mix(frame.ink.rgb, frame.accent.rgb, dot.tint);
	return vec4f(ink * alpha, alpha);
}
`

export const createInk = async (canvas: HTMLCanvasElement): Promise<Ink | null> => {
	if (!("gpu" in navigator)) return null
	const adapter = await navigator.gpu
		.requestAdapter({ powerPreference: "low-power" })
		.catch(() => null)
	if (adapter === null) return null
	const device = await adapter.requestDevice().catch(() => null)
	const context = canvas.getContext("webgpu")
	if (device === null || context === null) return null

	const format = navigator.gpu.getPreferredCanvasFormat()
	context.configure({ device, format, alphaMode: "premultiplied" })

	const module = device.createShaderModule({ code: SHADER })
	const info = await module.getCompilationInfo()
	if (info.messages.some((message) => message.type === "error")) {
		device.destroy()
		return null
	}

	const uniforms = new Float32Array(UNIFORM_FLOATS)
	const uniformBuffer = device.createBuffer({
		size: uniforms.byteLength,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
	})

	const frameLayout = device.createBindGroupLayout({
		entries: [
			{
				binding: 0,
				visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
				buffer: { type: "uniform" }
			}
		]
	})
	const movingLayout = device.createBindGroupLayout({
		entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }]
	})
	const stillLayout = device.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }
		]
	})

	const simulate = device.createComputePipeline({
		layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, movingLayout] }),
		compute: { module, entryPoint: "simulate" }
	})
	const premultiplied: GPUBlendComponent = {
		srcFactor: "one",
		dstFactor: "one-minus-src-alpha",
		operation: "add"
	}
	const render = device.createRenderPipeline({
		layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, stillLayout] }),
		vertex: { module, entryPoint: "place" },
		fragment: {
			module,
			entryPoint: "colour",
			targets: [{ format, blend: { color: premultiplied, alpha: premultiplied } }]
		},
		primitive: { topology: "triangle-list" }
	})

	const frameGroup = device.createBindGroup({
		layout: frameLayout,
		entries: [{ binding: 0, resource: { buffer: uniformBuffer } }]
	})

	/* The particles are made for the size of the sheet, and made again when it changes. */
	let particles: GPUBuffer | null = null
	let movingGroup: GPUBindGroup | null = null
	let stillGroup: GPUBindGroup | null = null
	let count = 0
	let size = ""
	let last = 0

	const seed = (width: number, height: number) => {
		count = Math.min(MOST, Math.round((width * height) / AREA))
		const data = new Float32Array(count * 4)
		for (let index = 0; index < count; index += 1) {
			data[index * 4] = Math.random() * width
			data[index * 4 + 1] = Math.random() * height
		}
		particles?.destroy()
		particles = device.createBuffer({
			size: data.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		})
		device.queue.writeBuffer(particles, 0, data)
		movingGroup = device.createBindGroup({
			layout: movingLayout,
			entries: [{ binding: 0, resource: { buffer: particles } }]
		})
		stillGroup = device.createBindGroup({
			layout: stillLayout,
			entries: [{ binding: 0, resource: { buffer: particles } }]
		})
	}

	/* The lamp and the pointer are eased here, as the press eases its own. */
	const lamp = { x: 0, y: 0, w: 0, h: 0, on: 0 }
	const pointer = { x: 0, y: 0, on: 0 }
	let sweepOn = 0
	const ease = (value: number, target: number, dt: number, seconds: number) =>
		value + (target - value) * (1 - Math.exp(-dt / seconds))

	const draw = (frame: PressFrame, time: number) => {
		const dt = Math.min(0.05, last === 0 ? 0.016 : time - last)
		last = time
		const dpr = Math.min(window.devicePixelRatio || 1, 1.75)
		const wanted = `${frame.width}x${frame.height}@${dpr}`
		if (wanted !== size) {
			size = wanted
			canvas.width = Math.round(frame.width * dpr)
			canvas.height = Math.round(frame.height * dpr)
			seed(frame.width, frame.height)
		}
		if (movingGroup === null || stillGroup === null) return

		const turning = frame.turn !== null
		if (frame.lamp !== null && !turning) {
			if (lamp.on < 0.05) Object.assign(lamp, frame.lamp)
			lamp.x = ease(lamp.x, frame.lamp.x, dt, 0.09)
			lamp.y = ease(lamp.y, frame.lamp.y, dt, 0.09)
			lamp.w = ease(lamp.w, frame.lamp.w, dt, 0.09)
			lamp.h = ease(lamp.h, frame.lamp.h, dt, 0.09)
			lamp.on = ease(lamp.on, 1, dt, 0.25)
		} else lamp.on = ease(lamp.on, 0, dt, 0.1)
		if (frame.pointer !== null) {
			pointer.x = frame.pointer.x
			pointer.y = frame.pointer.y
			pointer.on = ease(pointer.on, 1, dt, 0.25)
		} else pointer.on = ease(pointer.on, 0, dt, 0.4)
		sweepOn = ease(sweepOn, turning ? 1 : 0, dt, turning ? 0.06 : 0.22)

		uniforms.set([frame.width, frame.height, dpr, time], 0)
		uniforms.set([lamp.x, lamp.y, lamp.w, lamp.h], 4)
		uniforms.set([pointer.x, pointer.y, pointer.on, lamp.on], 8)
		if (frame.pane !== null)
			uniforms.set([frame.pane.x, frame.pane.y, frame.pane.w, frame.pane.h], 12)
		if (frame.turn !== null) {
			uniforms[16] = frame.turn.forward ? 1 - frame.turn.progress : frame.turn.progress
			uniforms[18] = frame.turn.forward ? -1 : 1
		}
		uniforms[17] = sweepOn
		uniforms[19] = dt
		uniforms.set([...frame.ink, frame.dark ? 1 : 0], 20)
		uniforms.set([...frame.accent, 0], 24)
		device.queue.writeBuffer(uniformBuffer, 0, uniforms)

		const encoder = device.createCommandEncoder()
		const compute = encoder.beginComputePass()
		compute.setPipeline(simulate)
		compute.setBindGroup(0, frameGroup)
		compute.setBindGroup(1, movingGroup)
		compute.dispatchWorkgroups(Math.ceil(count / 64))
		compute.end()

		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: context.getCurrentTexture().createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 0 },
					loadOp: "clear",
					storeOp: "store"
				}
			]
		})
		pass.setPipeline(render)
		pass.setBindGroup(0, frameGroup)
		pass.setBindGroup(1, stillGroup)
		pass.draw(6, count)
		pass.end()
		device.queue.submit([encoder.finish()])
	}

	return {
		draw,
		dispose() {
			particles?.destroy()
			uniformBuffer.destroy()
			device.destroy()
		}
	}
}
