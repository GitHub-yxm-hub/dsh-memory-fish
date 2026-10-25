"""Generate the project art: docs/logo.png, docs/banner.png, icon.svg.

Concept: a chubby round fish ("小肥鱼") whose body is a layered memory core —
memory strata in the back half, a small neural net above, RAM contact pins along
the belly, and a puzzle-piece dorsal fin for "plugin". Deliberately not a whale
and not the DeepSeek logo.

Usage: python docs/make-art.py
"""
from PIL import Image, ImageDraw, ImageFont, ImageChops
import os

OUT = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(OUT)
BG = (15, 20, 25)
INK = (230, 237, 243)
DIM = (139, 152, 169)
ACCENT = (76, 194, 255)
GREEN = (94, 224, 160)
BODY_TOP = (86, 205, 255)
STRATA = [(94, 224, 160), (170, 235, 255), (255, 255, 255)]


def font(size, bold=True):
    for path in (
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def fish_mask(size, cx, cy, rx, ry):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=255)
    return mask


def draw_fish(img):
    """Draw the mark onto an RGBA image; coordinates relative to image size."""
    W = img.size[0]
    d = ImageDraw.Draw(img)
    cx, cy = W * 0.44, W * 0.52
    rx, ry = W * 0.27, W * 0.215

    # --- tail: two fan triangles on the right ---
    tx, ty = cx + rx * 0.86, cy
    d.polygon([(tx, ty), (cx + rx * 1.72, cy - ry * 0.78), (cx + rx * 1.55, ty)], fill=ACCENT)
    d.polygon([(tx, ty), (cx + rx * 1.72, cy + ry * 0.78), (cx + rx * 1.55, ty)], fill=ACCENT)

    # --- body ---
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=BODY_TOP)

    # --- memory strata, clipped to the body's back half ---
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    for i, color in enumerate(STRATA):
        y = cy - ry * 0.12 + i * ry * 0.34
        x0 = cx - rx * 0.10
        w = rx * (0.78 - i * 0.12)
        h = ry * 0.20
        ld.rounded_rectangle([x0, y - h / 2, x0 + w, y + h / 2], radius=h / 2, fill=color + (255,))
    body_mask = fish_mask(W, cx, cy, rx, ry)
    img.alpha_composite(Image.composite(layer, Image.new("RGBA", img.size, (0, 0, 0, 0)), body_mask))

    # --- neural nodes above the strata ---
    nodes = [
        (cx - rx * 0.28, cy - ry * 0.62),
        (cx + rx * 0.06, cy - ry * 0.74),
        (cx + rx * 0.38, cy - ry * 0.60),
        (cx + rx * 0.34, cy - ry * 0.30),
    ]
    for i, a in enumerate(nodes):
        for b in nodes[i + 1:]:
            if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 < rx * 0.62:
                d.line([a, b], fill=BG, width=max(2, int(W * 0.008)))
    for n in nodes:
        r = W * 0.012
        d.ellipse([n[0] - r, n[1] - r, n[0] + r, n[1] + r], fill=BG)

    # --- eye + smile (face on the left) ---
    er = W * 0.052
    ex, ey = cx - rx * 0.46, cy - ry * 0.28
    d.ellipse([ex - er, ey - er, ex + er, ey + er], fill=BG)
    d.ellipse([ex - er * 0.42, ey - er * 0.48, ex - er * 0.02, ey - er * 0.08], fill=(255, 255, 255))
    d.arc([cx - rx * 0.70, cy + ry * 0.06, cx - rx * 0.18, cy + ry * 0.50],
          start=15, end=155, fill=BG, width=max(2, int(W * 0.013)))

    # --- belly pins (memory chip motif) ---
    for i in range(4):
        px = cx - rx * 0.40 + i * rx * 0.26
        d.rounded_rectangle([px, cy + ry * 0.74, px + rx * 0.12, cy + ry * 1.12],
                            radius=W * 0.008, fill=GREEN)

    # --- puzzle-piece dorsal fin (plugin motif) ---
    pz = W * 0.075
    fx, fy = cx + rx * 0.02, cy - ry - pz * 0.72
    d.rounded_rectangle([fx, fy, fx + pz * 1.7, fy + pz], radius=pz * 0.22, fill=GREEN)
    d.ellipse([fx + pz * 0.58, fy - pz * 0.46, fx + pz * 1.14, fy + pz * 0.10], fill=GREEN)


def make_logo(size=512, with_bg=True):
    S = 3
    W = size * S
    img = Image.new("RGBA", (W, W), BG + (255,) if with_bg else (0, 0, 0, 0))
    if not with_bg:
        draw_fish(img)
        return img.resize((size, size), Image.LANCZOS)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W, W], radius=int(W * 0.22), fill=BG + (255,))
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for r in range(int(W * 0.58), 0, -6):
        a = max(0, int(26 - r / (W * 0.035)))
        gd.ellipse([W / 2 - r, W / 2 - r, W / 2 + r, W / 2 + r], fill=(30, 120, 180, a))
    img = Image.alpha_composite(img, glow)
    draw_fish(img)
    return img.resize((size, size), Image.LANCZOS)


def make_mono(size=512):
    """Single-color mark for monochrome contexts (negative-space details)."""
    S = 3
    W = size * S
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = W * 0.44, W * 0.52
    rx, ry = W * 0.27, W * 0.215
    WHITE = (255, 255, 255, 255)

    d.polygon([(cx + rx * 0.86, cy), (cx + rx * 1.72, cy - ry * 0.78), (cx + rx * 1.55, cy)], fill=WHITE)
    d.polygon([(cx + rx * 0.86, cy), (cx + rx * 1.72, cy + ry * 0.78), (cx + rx * 1.55, cy)], fill=WHITE)
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=WHITE)
    for i in range(4):
        px = cx - rx * 0.40 + i * rx * 0.26
        d.rounded_rectangle([px, cy + ry * 0.74, px + rx * 0.12, cy + ry * 1.12], radius=W * 0.008, fill=WHITE)
    pz = W * 0.075
    fx, fy = cx + rx * 0.02, cy - ry - pz * 0.72
    d.rounded_rectangle([fx, fy, fx + pz * 1.7, fy + pz], radius=pz * 0.22, fill=WHITE)
    d.ellipse([fx + pz * 0.58, fy - pz * 0.46, fx + pz * 1.14, fy + pz * 0.10], fill=WHITE)

    holes = Image.new("L", (W, W), 0)
    hd = ImageDraw.Draw(holes)
    for i in range(3):
        y = cy - ry * 0.12 + i * ry * 0.34
        x0 = cx - rx * 0.10
        w = rx * (0.78 - i * 0.12)
        h = ry * 0.20
        hd.rounded_rectangle([x0, y - h / 2, x0 + w, y + h / 2], radius=h / 2, fill=255)
    nodes = [
        (cx - rx * 0.28, cy - ry * 0.62),
        (cx + rx * 0.06, cy - ry * 0.74),
        (cx + rx * 0.38, cy - ry * 0.60),
        (cx + rx * 0.34, cy - ry * 0.30),
    ]
    for i, a in enumerate(nodes):
        for b in nodes[i + 1:]:
            if ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5 < rx * 0.62:
                hd.line([a, b], fill=255, width=max(2, int(W * 0.008)))
    for n in nodes:
        r = W * 0.012
        hd.ellipse([n[0] - r, n[1] - r, n[0] + r, n[1] + r], fill=255)
    er = W * 0.052
    ex, ey = cx - rx * 0.46, cy - ry * 0.28
    hd.ellipse([ex - er, ey - er, ex + er, ey + er], fill=255)
    hd.arc([cx - rx * 0.70, cy + ry * 0.06, cx - rx * 0.18, cy + ry * 0.50],
           start=15, end=155, fill=255, width=max(2, int(W * 0.013)))

    alpha = ImageChops.subtract(img.getchannel("A"), holes)
    img.putalpha(alpha)
    # keep a small white catchlight in the eye so it doesn't disappear
    d2 = ImageDraw.Draw(img)
    d2.ellipse([ex - er * 0.42, ey - er * 0.48, ex - er * 0.02, ey - er * 0.08], fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def make_banner(logo_transparent, path):
    S = 2
    W, H = 1280, 640
    img = Image.new("RGB", (W * S, H * S), BG)
    glow = Image.new("RGB", (W * S, H * S), BG)
    gd = ImageDraw.Draw(glow)
    for r in range(400, 0, -4):
        alpha = max(0, 26 - r // 20)
        gd.ellipse([(300 - r) * S, (300 - r) * S, (300 + r) * S, (300 + r) * S],
                   fill=(15 + alpha, 20 + alpha, 25 + alpha * 2))
    img = Image.blend(img, glow, 0.5)
    d = ImageDraw.Draw(img)

    mark = logo_transparent.resize((410, 410), Image.LANCZOS)
    img.paste(mark, (40 * S, 100 * S), mark)

    def text(xy, s, size, color, bold=True):
        d.text((xy[0] * S, xy[1] * S), s, font=font(size * S, bold), fill=color)

    text((450, 150), "dsh-memory-fish", 64, INK)
    text((452, 240), "Context-budgeted memory for DeepSeek Harness", 30, DIM, bold=False)
    text((452, 296), "Memory grows. The prompt doesn't.", 30, ACCENT, bold=False)

    # chips laid out sequentially so nothing overflows
    x = 452
    y = 386
    for label in ("~600 token inject", "3-stage sleep", "spaced repetition", "temporal validity"):
        w = d.textlength(label, font=font(22 * S, False)) / S
        d.rounded_rectangle([x * S, y * S, (x + w + 34) * S, (y + 46) * S], radius=10 * S,
                            fill=(23, 29, 38), outline=(38, 48, 65), width=2 * S)
        d.text((x * S + 17 * S, (y + 9) * S), label, font=font(22 * S, False), fill=(214, 226, 238))
        x += w + 34 + 12

    text((452, 506), "zero dependencies  ·  zero servers  ·  local files only", 22, (100, 116, 134), bold=False)
    img.resize((W, H), Image.LANCZOS).save(path)


LOGO_SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect width="128" height="128" rx="28" fill="#0f1419"/>
  <defs>
    <radialGradient id="g" cx="50%" cy="48%" r="58%">
      <stop offset="0%" stop-color="#1e6f9f" stop-opacity=".5"/>
      <stop offset="100%" stop-color="#0f1419" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <!-- tail -->
  <path d="M80 64 L104 44 L98 64 Z" fill="#4cc2ff"/>
  <path d="M80 64 L104 84 L98 64 Z" fill="#4cc2ff"/>
  <!-- body -->
  <ellipse cx="56" cy="64" rx="30" ry="24" fill="#56cdff"/>
  <!-- memory strata -->
  <rect x="54" y="55" width="24" height="6" rx="3" fill="#5ee0a0"/>
  <rect x="54" y="65" width="21" height="6" rx="3" fill="#aaeBff"/>
  <rect x="54" y="75" width="18" height="6" rx="3" fill="#ffffff"/>
  <!-- neural nodes -->
  <g stroke="#0f1419" stroke-width="1.6" opacity=".95">
    <path d="M42 46 L56 40 L70 47 M56 40 L70 56 M42 46 L52 56"/>
  </g>
  <g fill="#0f1419">
    <circle cx="42" cy="46" r="2.6"/><circle cx="56" cy="40" r="2.6"/>
    <circle cx="70" cy="47" r="2.6"/><circle cx="70" cy="56" r="2.6"/>
  </g>
  <!-- eye + smile -->
  <circle cx="40" cy="62" r="6" fill="#0f1419"/>
  <circle cx="38" cy="59.5" r="2" fill="#fff"/>
  <path d="M36 74 q6 7 12 1" stroke="#0f1419" stroke-width="2.6" fill="none" stroke-linecap="round"/>
  <!-- belly pins -->
  <g fill="#5ee0a0">
    <rect x="38" y="88" width="6" height="9" rx="1.5"/>
    <rect x="48" y="88" width="6" height="9" rx="1.5"/>
    <rect x="58" y="88" width="6" height="9" rx="1.5"/>
    <rect x="68" y="88" width="6" height="9" rx="1.5"/>
  </g>
  <!-- puzzle dorsal fin -->
  <g fill="#5ee0a0">
    <rect x="48" y="22" width="22" height="13" rx="3"/>
    <circle cx="65" cy="22" r="5"/>
  </g>
</svg>
"""

logo_bg = make_logo(512, with_bg=True)
make_mono(512).save(os.path.join(OUT, 'logo-mono.png'))
logo_bg.save(os.path.join(OUT, "logo.png"))
logo_clear = make_logo(512, with_bg=False)
logo_clear.save(os.path.join(OUT, "logo-transparent.png"))
make_banner(logo_clear, os.path.join(OUT, "banner.png"))
with open(os.path.join(ROOT, "icon.svg"), "w", encoding="utf-8") as f:
    f.write(LOGO_SVG)
print("logo:", os.path.join(OUT, "logo.png"))
print("banner:", os.path.join(OUT, "banner.png"))
print("icon:", os.path.join(ROOT, "icon.svg"))


