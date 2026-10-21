"""Prepare transparent mascot layers from the owner-provided flat PNG, locally."""
from __future__ import annotations

from collections import deque
import json
from pathlib import Path
import sys
from typing import Callable

from PIL import Image, ImageDraw

CANVAS = 1024
ART_SIZE = 896
SVG_WIDTH = 240
SVG_HEIGHT = 200
IMAGE_X = 0
IMAGE_Y = -20
IMAGE_SIZE = 240


def connected_component(
    width: int,
    height: int,
    seeds: list[tuple[int, int]],
    predicate: Callable[[int, int], bool],
    bounds: tuple[int, int, int, int] | None = None,
) -> bytearray:
    mask = bytearray(width * height)
    if bounds is None:
        bounds = (0, 0, width, height)
    left, top, right, bottom = bounds
    queue: deque[tuple[int, int]] = deque()
    for x, y in seeds:
        if left <= x < right and top <= y < bottom and predicate(x, y):
            index = y * width + x
            if not mask[index]:
                mask[index] = 1
                queue.append((x, y))
    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if left <= nx < right and top <= ny < bottom:
                index = ny * width + nx
                if not mask[index] and predicate(nx, ny):
                    mask[index] = 1
                    queue.append((nx, ny))
    return mask


def mask_bounds(mask: bytearray, width: int, height: int) -> tuple[int, int, int, int]:
    xs: list[int] = []
    ys: list[int] = []
    for index, value in enumerate(mask):
        if value:
            y, x = divmod(index, width)
            xs.append(x)
            ys.append(y)
    if not xs:
        raise ValueError("Could not locate the pupil in the supplied image")
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def remove_boundary_white(image: Image.Image) -> bytearray:
    width, height = image.size
    pixels = image.load()
    background = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    def is_background(x: int, y: int) -> bool:
        red, green, blue = pixels[x, y]
        return min(red, green, blue) >= 60 and max(red, green, blue) - min(red, green, blue) <= 200

    def add(x: int, y: int) -> None:
        index = y * width + x
        if not background[index] and is_background(x, y):
            background[index] = 1
            queue.append((x, y))

    for x in range(width):
        add(x, 0)
        add(x, height - 1)
    for y in range(height):
        add(0, y)
        add(width - 1, y)
    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height:
                add(nx, ny)
    return background


def prepare_layers(source_path: str, output_directory: str, favicon_path: str, geometry_path: str) -> None:
    source = Image.open(source_path).convert("RGB")
    width, height = source.size
    if width != height:
        raise ValueError(f"Expected the supplied square source, got {width}x{height}")
    pixels = source.load()

    # Eye location is a seed, not a hand-cropped asset. The connected shape determines the final geometry.
    seed = (round(width * 0.487), round(height * 0.519))
    eye_roi = (
        max(0, seed[0] - 155), max(0, seed[1] - 155),
        min(width, seed[0] + 156), min(height, seed[1] + 156),
    )

    def is_pupil(x: int, y: int) -> bool:
        red, green, blue = pixels[x, y]
        dx, dy = x - seed[0], y - seed[1]
        return dx * dx + dy * dy <= 145 * 145 and max(red, green, blue) < 250

    pupil_mask = connected_component(width, height, [seed], is_pupil, eye_roi)
    pupil_box = mask_bounds(pupil_mask, width, height)
    left, top, right, bottom = pupil_box
    pupil_cx = (left + right - 1) / 2
    pupil_cy = (top + bottom - 1) / 2
    pupil_rx = (right - left) / 2
    pupil_ry = (bottom - top) / 2
    if pupil_rx < 60 or pupil_ry < 60:
        raise ValueError(f"Pupil extraction is unexpectedly small: {pupil_box}")

    # Find small, enclosed scleral highlights inside the connected dark pupil. The large sclera component is rejected by area.
    highlight_region = (max(0, left - 8), max(0, top - 8), min(width, right + 9), min(height, bottom + 9))

    def is_white_glint(x: int, y: int) -> bool:
        red, green, blue = pixels[x, y]
        dx, dy = (x - pupil_cx) / pupil_rx, (y - pupil_cy) / pupil_ry
        return min(red, green, blue) >= 220 and max(red, green, blue) - min(red, green, blue) <= 35 and dx * dx + dy * dy < 0.78 * 0.78

    glints = bytearray(width * height)
    visited = bytearray(width * height)
    gx0, gy0, gx1, gy1 = highlight_region
    for y in range(gy0, gy1):
        for x in range(gx0, gx1):
            start = y * width + x
            if visited[start] or not is_white_glint(x, y):
                continue
            component = connected_component(width, height, [(x, y)], is_white_glint, highlight_region)
            area = sum(component)
            for index, value in enumerate(component):
                if value:
                    visited[index] = 1
                    glints[index] = 1
            if area < 3 or area > 8000:
                for index, value in enumerate(component):
                    if value:
                        glints[index] = 0

    pupil_rgba = Image.new("RGBA", source.size, (0, 0, 0, 0))
    pupil_pixels = pupil_rgba.load()
    for index, included in enumerate(pupil_mask):
        if included:
            y, x = divmod(index, width)
            red, green, blue = pixels[x, y]
            brightness = (red + green + blue) / 3
            if brightness < 165:
                alpha = 255
                color = (red, green, blue)
            else:
                # Recover the antialiased dark-green edge against the white sclera.
                alpha = max(1, min(255, round((255 - brightness) * 255 / 235)))
                color = tuple(max(0, min(255, round((channel - 255 + alpha) * 255 / alpha))) for channel in (red, green, blue))
            pupil_pixels[x, y] = (*color, alpha)
        if glints[index]:
            y, x = divmod(index, width)
            pupil_pixels[x, y] = (*pixels[x, y], 255)

    # Sample the white ring well outside the pupil, not its antialiased edge.
    sclera_samples: list[tuple[int, int, int]] = []
    pupil_radius = max(pupil_rx, pupil_ry)
    for y in range(max(0, round(pupil_cy - pupil_radius - 50)), min(height, round(pupil_cy + pupil_radius + 51))):
        for x in range(max(0, round(pupil_cx - pupil_radius - 50)), min(width, round(pupil_cx + pupil_radius + 51))):
            distance = ((x - pupil_cx) ** 2 + (y - pupil_cy) ** 2) ** 0.5
            red, green, blue = pixels[x, y]
            if pupil_radius + 12 <= distance <= pupil_radius + 38 and min(red, green, blue) >= 245 and max(red, green, blue) - min(red, green, blue) <= 20:
                sclera_samples.append((red, green, blue))
    if not sclera_samples:
        raise ValueError("Could not sample clean white sclera outside the pupil")
    sclera_color = tuple(sorted(channel)[len(sclera_samples) // 2] for channel in zip(*sclera_samples))
    body = source.copy()
    patch = Image.new("L", source.size, 0)
    ImageDraw.Draw(patch).ellipse(
        (round(pupil_cx - pupil_rx - 6), round(pupil_cy - pupil_ry - 6), round(pupil_cx + pupil_rx + 6), round(pupil_cy + pupil_ry + 6)),
        fill=255,
    )
    body.paste(sclera_color, mask=patch)

    background = remove_boundary_white(source)
    alpha = Image.new("L", source.size)
    alpha.putdata([0 if value else 255 for value in background])

    # Determine the sclera boundary from its connected near-white annulus, separately from the exterior background.
    sclera_seed = (min(width - 1, round(pupil_cx + max(pupil_rx, pupil_ry) + 16)), round(pupil_cy))

    def is_sclera(x: int, y: int) -> bool:
        red, green, blue = pixels[x, y]
        return min(red, green, blue) >= 230 and max(red, green, blue) - min(red, green, blue) <= 30

    sclera_mask = connected_component(width, height, [sclera_seed], is_sclera, eye_roi)
    sclera_box = mask_bounds(sclera_mask, width, height)
    sx0, sy0, sx1, sy1 = sclera_box
    sclera_cx = (sx0 + sx1 - 1) / 2
    sclera_cy = (sy0 + sy1 - 1) / 2
    clip_rx = max(0, (sx1 - sx0) / 2 - 6)
    clip_ry = max(0, (sy1 - sy0) / 2 - 6)
    if clip_rx < pupil_rx + 20 or clip_ry < pupil_ry + 16:
        raise ValueError(f"Sclera clip is too tight for pupil motion: sclera={sclera_box}, pupil={pupil_box}")

    # Use one exact crop/scale/offset for all layers so the moving pupil remains registered with its body.
    combined_alpha = alpha
    bbox = combined_alpha.getbbox()
    if bbox is None:
        raise ValueError("No foreground found after removing boundary-connected white")
    bx0, by0, bx1, by1 = bbox
    padding = round(max(bx1 - bx0, by1 - by0) * 0.035)
    crop_box = (max(0, bx0 - padding), max(0, by0 - padding), min(width, bx1 + padding), min(height, by1 + padding))
    crop_w, crop_h = crop_box[2] - crop_box[0], crop_box[3] - crop_box[1]
    scale = min(ART_SIZE / crop_w, ART_SIZE / crop_h)
    resized_w, resized_h = round(crop_w * scale), round(crop_h * scale)
    offset_x, offset_y = (CANVAS - resized_w) // 2, (CANVAS - resized_h) // 2

    def transform(rgb: Image.Image, layer_alpha: Image.Image) -> Image.Image:
        rgba = rgb.convert("RGBA")
        rgba.putalpha(layer_alpha)
        cropped = rgba.crop(crop_box)
        resized = cropped.resize((resized_w, resized_h), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        canvas.alpha_composite(resized, (offset_x, offset_y))
        return canvas

    full_asset = transform(source, alpha)
    body_asset = transform(body, alpha)
    pupil_asset = transform(pupil_rgba.convert("RGB"), pupil_rgba.getchannel("A"))

    transform_x = offset_x - crop_box[0] * scale
    transform_y = offset_y - crop_box[1] * scale
    eye_canvas_x = sclera_cx * scale + transform_x
    eye_canvas_y = sclera_cy * scale + transform_y
    eye_svg = {
        "cx": round(IMAGE_X + eye_canvas_x * IMAGE_SIZE / CANVAS, 4),
        "cy": round(IMAGE_Y + eye_canvas_y * IMAGE_SIZE / CANVAS, 4),
        "rx": round(clip_rx * scale * IMAGE_SIZE / CANVAS, 4),
        "ry": round(clip_ry * scale * IMAGE_SIZE / CANVAS, 4),
    }

    output = Path(output_directory)
    output.mkdir(parents=True, exist_ok=True)
    full_asset.save(output / "nail-monster.png", optimize=True)
    body_asset.save(output / "nail-monster-body.png", optimize=True)
    pupil_asset.save(output / "nail-monster-pupil.png", optimize=True)
    geometry = Path(geometry_path)
    geometry.parent.mkdir(parents=True, exist_ok=True)
    geometry.write_text(
        "export const MASCOT_EYE_CLIP = " + json.dumps(eye_svg, indent=2) + " as const;\n",
        encoding="utf-8",
    )
    icon = full_asset.resize((128, 128), Image.Resampling.LANCZOS)
    Path(favicon_path).parent.mkdir(parents=True, exist_ok=True)
    icon.save(favicon_path, optimize=True)


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("Usage: prepare-monster-assets.py SOURCE OUTPUT_DIRECTORY FAVICON_PATH GEOMETRY_MODULE")
    prepare_layers(*sys.argv[1:])


if __name__ == "__main__":
    main()
