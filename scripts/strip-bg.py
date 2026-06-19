#!/usr/bin/env python3
"""Turn the raw sticker images into transparent-background PNG icons.

It removes only the background that is connected to the image border (a flood
fill from the edges), so white *inside* an icon -- the eraser's white tip, the
trash-can highlights, the speech bubble -- is preserved. Then it trims the
transparent margin and downscales so the icons stay light to ship.

Usage:
    python3 scripts/strip-bg.py

Input  : assets/fun-ui/raw/<name>.(png|jpg|jpeg|webp)
Output : assets/fun-ui/<name>.png   (transparent, trimmed, max 256px)
"""
import os
import sys
from collections import deque

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install Pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RAW = os.path.join(ROOT, "assets", "fun-ui", "raw")
OUT = os.path.join(ROOT, "assets", "fun-ui")

THRESH = 38      # how close to the corner colour still counts as background
MAX_SIDE = 128   # longest edge of the saved icon (displays ~40px, so 128 covers retina)
COLORS = 128     # palette size for the 8-bit PNG (fewer colours = smaller file)


def is_bg(px, ref, thresh=THRESH):
    return abs(px[0] - ref[0]) <= thresh and abs(px[1] - ref[1]) <= thresh and abs(px[2] - ref[2]) <= thresh


def strip(path):
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    px = img.load()
    # Reference background colour = average of the four corners.
    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    ref = tuple(sum(c[i] for c in corners) // 4 for i in range(3))

    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            q.append((x, y))

    while q:
        x, y = q.popleft()
        idx = y * w + x
        if seen[idx]:
            continue
        seen[idx] = 1
        r, g, b, a = px[x, y]
        if not is_bg((r, g, b), ref):
            continue
        px[x, y] = (r, g, b, 0)               # background -> transparent
        if x > 0:     q.append((x - 1, y))
        if x < w - 1: q.append((x + 1, y))
        if y > 0:     q.append((x, y - 1))
        if y < h - 1: q.append((x, y + 1))

    bbox = img.getbbox()                       # trim transparent margin
    if bbox:
        img = img.crop(bbox)
    if max(img.size) > MAX_SIDE:               # keep the files small
        s = MAX_SIDE / max(img.size)
        img = img.resize((max(1, round(img.size[0] * s)), max(1, round(img.size[1] * s))), Image.LANCZOS)
    return img


def main():
    if not os.path.isdir(RAW):
        sys.exit(f"Put the raw sticker images in: {RAW}")
    exts = (".png", ".jpg", ".jpeg", ".webp")
    files = [f for f in sorted(os.listdir(RAW)) if f.lower().endswith(exts)]
    if not files:
        sys.exit(f"No images found in {RAW}")
    os.makedirs(OUT, exist_ok=True)
    for f in files:
        name = os.path.splitext(f)[0]
        out = os.path.join(OUT, name + ".png")
        img = strip(os.path.join(RAW, f))
        # Compress: 8-bit palette with transparency (FASTOCTREE keeps alpha) + zlib optimise.
        img = img.quantize(colors=COLORS, method=2)
        img.save(out, optimize=True)
        print(f"  {f}  ->  {os.path.relpath(out, ROOT)}  ({os.path.getsize(out) // 1024} KB)")
    print(f"Done: {len(files)} icon(s) written to {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
