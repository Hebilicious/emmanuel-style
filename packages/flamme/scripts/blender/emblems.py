"""
The emblems of the sections, modelled and rendered in Blender.

Each section of the paper opens with an emblem: books for the Library, a paper
dart for the Blog's dispatches, an hourglass for the ledger, gears for the skills.
They are built here from primitives, lit, and rendered twice from the same camera:
once for the shading and once for the depth. The two are packed into one PNG whose
colour is the shading and whose alpha is how near each pixel is (0 where there is
nothing), which is what the press reads to print the emblem as a relief whose dots
stand at the model's real depth. As a plain image it reads as the emblem fading
with distance, which is what a browser without the press shows.

Run from the package, with Blender on the path:

    pnpm --filter @emmanuel/flamme run emblems

    blender --background --python scripts/blender/emblems.py -- <output directory>
"""

import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

SIZE = 384
OUT = Path(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "public/images/emblems")


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = False
    scene.render.resolution_x = SIZE
    scene.render.resolution_y = SIZE
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.05
    scene.world = world
    return scene


def clay(name, value):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (value, value, value, 1)
    shader.inputs["Roughness"].default_value = 0.7
    return material


def add(kind, material, bevel=0.0, **options):
    getattr(bpy.ops.mesh, f"primitive_{kind}_add")(**options)
    item = bpy.context.object
    item.data.materials.append(material)
    if bevel > 0:
        modifier = item.modifiers.new("Bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = 3
    bpy.ops.object.shade_smooth()
    return item


def mesh(name, vertices, faces, material):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    item = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(item)
    item.data.materials.append(material)
    return item


def lights():
    for location, energy, size in [((4, -4, 6), 260, 3), ((-5, -2, 3), 40, 5), ((0, 5, 4), 70, 4)]:
        bpy.ops.object.light_add(type="AREA", location=location)
        light = bpy.context.object
        light.data.energy = energy
        light.data.size = size
        direction = Vector((0, 0, 0.5)) - Vector(location)
        light.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def camera(scene, location=(4.2, -5.2, 3.6), target=(0, 0, 0.9), scale=4.2):
    bpy.ops.object.camera_add(location=location)
    item = bpy.context.object
    item.data.type = "ORTHO"
    item.data.ortho_scale = scale
    direction = Vector(target) - Vector(location)
    item.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = item
    return item


# ------------------------------------------------------------------ the models


def library():
    light, dark = clay("cover", 0.55), clay("pages", 0.92)
    height = 0.0
    for index, (width, depth, thick, turn) in enumerate(
        [(2.4, 1.7, 0.42, 4), (2.1, 1.6, 0.34, -9), (2.3, 1.5, 0.5, 6), (1.8, 1.4, 0.3, -4)]
    ):
        cover = add("cube", light, bevel=0.04, location=(0, 0, height + thick / 2))
        cover.scale = (width / 2, depth / 2, thick / 2)
        cover.rotation_euler[2] = math.radians(turn)
        pages = add("cube", dark, location=(0.05, 0, height + thick / 2))
        pages.scale = (width / 2 - 0.02, depth / 2 - 0.07, thick / 2 - 0.06)
        pages.rotation_euler[2] = math.radians(turn)
        height += thick
    # One more, leaning against the stack.
    lean = add("cube", light, bevel=0.04, location=(1.75, 0.1, 0.95))
    lean.scale = (0.16, 0.75, 1.0)
    lean.rotation_euler[1] = math.radians(-17)
    return dict(target=(0.3, 0, 0.85), scale=4.6)


def blog():
    paper, shade = clay("paper", 0.9), clay("fold", 0.6)
    # A paper dart, in flight: two wings, and the keel folded under them.
    nose, tail = 2.1, -1.7
    wings = [
        (nose, 0, 1.0),
        (tail, 1.55, 1.45),
        (tail, 0.2, 1.05),
        (tail, -0.2, 1.05),
        (tail, -1.55, 1.45),
    ]
    keel = [(nose, 0, 1.0), (tail, 0.2, 1.05), (tail, 0, 0.3), (tail, -0.2, 1.05)]
    parts = [
        mesh("wings", wings, [(0, 1, 2), (0, 3, 4)], paper),
        mesh("keel", keel, [(0, 1, 2), (0, 2, 3)], shade),
    ]
    for part in parts:
        part.rotation_euler = (math.radians(24), math.radians(-10), math.radians(38))
        modifier = part.modifiers.new("Solid", "SOLIDIFY")
        modifier.thickness = 0.04
    return dict(target=(0.2, 0.2, 1.0), scale=4.6, location=(3.0, -5.6, 3.4))


def experience():
    wood, glass, sand = clay("wood", 0.5), clay("glass", 0.95), clay("sand", 0.72)
    for z in (0.12, 2.68):
        add("cylinder", wood, bevel=0.05, radius=0.95, depth=0.24, location=(0, 0, z))
    for angle in (30, 150, 270):
        x, y = 0.78 * math.cos(math.radians(angle)), 0.78 * math.sin(math.radians(angle))
        add("cylinder", wood, radius=0.07, depth=2.4, location=(x, y, 1.4))
    add("cone", glass, radius1=0.68, radius2=0.06, depth=1.1, location=(0, 0, 0.82))
    add("cone", glass, radius1=0.06, radius2=0.68, depth=1.1, location=(0, 0, 1.98))
    add("cone", sand, radius1=0.5, radius2=0.0, depth=0.5, location=(0, 0, 0.52))
    return dict(target=(0, 0, 1.4), scale=4.0)


def gear(material, radius, teeth, thick, location, turn=0.0):
    add("cylinder", material, bevel=0.03, radius=radius, depth=thick, location=location)
    add("cylinder", clay("hub", 0.35), radius=radius * 0.28, depth=thick + 0.06, location=location)
    for index in range(teeth):
        angle = turn + index * 2 * math.pi / teeth
        tooth = add(
            "cube",
            material,
            bevel=0.02,
            location=(
                location[0] + math.cos(angle) * (radius + 0.06),
                location[1] + math.sin(angle) * (radius + 0.06),
                location[2],
            ),
        )
        tooth.scale = (0.2, 0.13, thick / 2 - 0.015)
        tooth.rotation_euler[2] = angle


def skills():
    # Three gears in mesh, each a different metal and a different height, so they
    # read apart when they are printed in two inks.
    gear(clay("steel", 0.5), 1.0, 12, 0.5, (-0.55, 0, 0.25))
    gear(clay("brass", 0.28), 0.62, 8, 0.8, (1.28, 0.42, 0.4), turn=math.radians(22))
    gear(clay("iron", 0.38), 0.5, 7, 1.1, (0.35, -1.45, 0.55), turn=math.radians(8))
    return dict(target=(0.3, -0.3, 0.3), scale=4.8, location=(3.4, -4.6, 4.2))


EMBLEMS = {"library": library, "blog": blog, "experience": experience, "skills": skills}

# ------------------------------------------------------------------ rendering


def pixels(path):
    image = bpy.data.images.load(str(path))
    data = np.array(image.pixels[:], dtype=np.float32).reshape(SIZE, SIZE, 4)
    bpy.data.images.remove(image)
    return data


def depth_material():
    """Emit how near the surface is to the camera, white at the nearest point."""
    material = bpy.data.materials.new("depth")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    camera_data = nodes.new("ShaderNodeCameraData")
    emission = nodes.new("ShaderNodeEmission")
    output = nodes.new("ShaderNodeOutputMaterial")
    # Scaled into 0..1, which is all a PNG holds; the scenes are a few units deep.
    scale = nodes.new("ShaderNodeMath")
    scale.operation = "MULTIPLY"
    scale.inputs[1].default_value = 1 / 40
    links.new(camera_data.outputs["View Z Depth"], scale.inputs[0])
    links.new(scale.outputs[0], emission.inputs["Strength"])
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def render(name, build):
    scene = reset()
    framing = build()
    lights()
    camera(scene, **framing)

    shaded = OUT / f".{name}-shaded.png"
    scene.render.filepath = str(shaded)
    bpy.ops.render.render(write_still=True)

    # The same view again, every surface emitting its distance from the camera.
    scene.view_settings.view_transform = "Raw"
    scene.render.image_settings.color_depth = "16"
    bpy.context.view_layer.material_override = depth_material()
    distance = OUT / f".{name}-depth.png"
    scene.render.filepath = str(distance)
    bpy.ops.render.render(write_still=True)

    colour, far = pixels(shaded), pixels(distance)
    covered = colour[..., 3] > 0.5
    z = far[..., 0]
    near, back = z[covered].min(), z[covered].max()
    # 1 at the nearest point, 0.25 at the furthest, 0 where there is nothing.
    nearness = np.where(covered, 1.0 - 0.75 * (z - near) / max(back - near, 1e-6), 0.0)
    grey = colour[..., :3].mean(axis=2)
    grey = np.clip((grey - grey[covered].min()) / max(np.ptp(grey[covered]), 1e-6), 0, 1)
    packed = np.dstack([grey, grey, grey, nearness]).astype(np.float32)

    image = bpy.data.images.new(name, SIZE, SIZE, alpha=True)
    image.alpha_mode = "STRAIGHT"
    image.pixels = packed.ravel()
    image.filepath_raw = str(OUT / f"{name}.png")
    image.file_format = "PNG"
    image.save()
    shaded.unlink()
    distance.unlink()
    print(f"emblem: {name}.png")


OUT.mkdir(parents=True, exist_ok=True)
OUT = OUT.resolve()
for emblem, builder in EMBLEMS.items():
    render(emblem, builder)
