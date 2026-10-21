import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/prepare-monster-assets.py"


class MonsterAssetsTest(unittest.TestCase):
    def test_exports_registered_layers_with_transparent_exterior_and_restored_eye(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as folder:
            root = Path(folder)
            source = Image.new("RGB", (512, 512), "white")
            draw = ImageDraw.Draw(source)
            draw.ellipse((75, 40, 437, 472), fill=(122, 235, 36), outline=(6, 54, 48), width=12)
            draw.ellipse((124, 144, 374, 394), fill="white", outline=(6, 54, 48), width=8)
            draw.ellipse((184, 204, 314, 334), fill=(4, 65, 56))
            draw.ellipse((225, 226, 248, 249), fill="white")
            draw.ellipse((268, 262, 276, 270), fill="white")
            source.save(root / "input.png")
            output = root / "branding"
            favicon = root / "icon.png"
            geometry = root / "eye.ts"
            result = subprocess.run(
                ["python3", str(SCRIPT), str(root / "input.png"), str(output), str(favicon), str(geometry)],
                check=False, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

            with Image.open(output / "nail-monster.png") as full, Image.open(output / "nail-monster-body.png") as body, Image.open(output / "nail-monster-pupil.png") as pupil:
                self.assertEqual(full.size, (1024, 1024))
                self.assertEqual(body.size, full.size)
                self.assertEqual(pupil.size, full.size)
                self.assertEqual(full.mode, "RGBA")
                self.assertEqual(body.mode, "RGBA")
                self.assertEqual(pupil.mode, "RGBA")
                self.assertEqual(full.getpixel((0, 0))[3], 0)
                self.assertEqual(body.getpixel((0, 0))[3], 0)
                self.assertEqual(pupil.getpixel((0, 0))[3], 0)
                pupil_box = pupil.getchannel("A").getbbox()
                if pupil_box is None:
                    self.fail("Expected non-empty pupil layer")
                pupil_center = ((pupil_box[0] + pupil_box[2]) // 2, (pupil_box[1] + pupil_box[3]) // 2)
                self.assertGreater(pupil.getpixel(pupil_center)[3], 0)
                geometry_text = geometry.read_text(encoding="utf-8")
                self.assertIn('"cx"', geometry_text)
                self.assertIn('"cy"', geometry_text)
                self.assertIn('"rx"', geometry_text)
                self.assertIn('"ry"', geometry_text)
                # Body/pupil separation leaves an opaque white sclera beneath an opaque isolated pupil.
                self.assertEqual(body.getpixel(pupil_center), (255, 255, 255, 255))
                pupil_pixels = pupil.load()
                bright_pupil_pixels = sum(
                    1
                    for y in range(pupil_box[1], pupil_box[3])
                    for x in range(pupil_box[0], pupil_box[2])
                    if pupil_pixels[x, y][3] > 220 and min(pupil_pixels[x, y][:3]) > 220
                )
                self.assertGreaterEqual(bright_pupil_pixels, 3)
                self.assertEqual(pupil.getpixel((0, 0))[3], 0)

            with Image.open(favicon) as icon:
                self.assertEqual(icon.size, (128, 128))
                self.assertEqual(icon.mode, "RGBA")
                self.assertEqual(icon.getpixel((0, 0))[3], 0)


if __name__ == "__main__":
    unittest.main()
