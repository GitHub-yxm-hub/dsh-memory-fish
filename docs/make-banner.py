"""Generate the repository social-preview banner (docs/banner.png).

Usage: python docs/make-banner.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

S = 2  # supersample
W, H = 1280, 640
img = Image.new("RGB", (W * S, H * S), (15, 20, 25))
d = ImageDraw.Draw(img)


def font(size, bold=True):
    candidates = [
        ("C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf", 0),
        ("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf", 0),
    ]
    for path, idx in candidates:
        try:
            return ImageFont.truetype(path, size * S, index=idx)
        except Exception:
            continue
    return ImageFont.load_default()


def text(xy, s, size, color, bold=True):
    d.text((xy[0] * S, xy[1] * S), s, font=font(size, bold), fill=color)


# soft gradient glow behind the fish
glow = Image.new("RGB", (W * S, H * S), (15, 20, 25))
gd = ImageDraw.Draw(glow)
for r in range(360, 0, -4):
    alpha = max(0, 26 - r // 18)
    gd.ellipse([(300 - r) * S, (300 - r) * S, (300 + r) * S, (300 + r) * S],
               fill=(15 + alpha, 20 + alpha, 25 + alpha * 2))
img = Image.blend(img, glow, 0.55)
d = ImageDraw.Draw(img)

# --- fish glyph ---
cx, cy = 170, 250
body = (76, 194, 255)
d.ellipse([(cx - 110) * S, (cy - 62) * S, (cx + 110) * S, (cy + 62) * S], fill=body)
d.polygon([((cx + 96) * S, cy * S), ((cx + 168) * S, (cy - 52) * S), ((cx + 168) * S, (cy + 52) * S)], fill=body)
d.ellipse([(cx - 58) * S, (cy - 22) * S, (cx - 26) * S, (cy + 10) * S], fill=(15, 20, 25))
d.ellipse([(cx - 50) * S, (cy - 16) * S, (cx - 38) * S, (cy - 4) * S], fill=(255, 255, 255))
d.arc([(cx - 76) * S, (cy - 6) * S, (cx - 30) * S, (cy + 34) * S], 20, 150, fill=(15, 20, 25), width=4 * S)
# bubbles
for bx, by, br in [(cx + 190, cy - 70, 10), (cx + 220, cy - 110, 6), (cx + 205, cy - 145, 4)]:
    d.ellipse([(bx - br) * S, (by - br) * S, (bx + br) * S, (by + br) * S],
              outline=(76, 194, 255), width=2 * S)

# --- text ---
text((400, 150), "dsh-memory-fish", 64, (230, 237, 243))
text((400, 240), "Context-budgeted memory for DeepSeek Harness", 30, (139, 152, 169), bold=False)
text((400, 296), "Memory grows. The prompt doesn't.", 30, (76, 194, 255), bold=False)

chips = [
    ("~600 token inject", 360, 380),
    ("3-stage sleep", 620, 380),
    ("spaced repetition", 800, 380),
    ("temporal validity", 1030, 380),
]
for label, x, y in chips:
    w = d.textlength(label, font=font(22, False))
    d.rounded_rectangle([x * S, y * S, (x + w / S + 36) * S, (y + 48) * S], radius=10 * S,
                        fill=(23, 29, 38), outline=(38, 48, 65), width=2 * S)
    d.text((x * S + 18 * S, (y + 10) * S), label, font=font(22, False), fill=(214, 226, 238))

text((400, 500), "zero dependencies  ·  zero servers  ·  local files only", 22, (100, 116, 134), bold=False)

img = img.resize((W, H), Image.LANCZOS)
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "banner.png")
img.save(out)
print(out)
