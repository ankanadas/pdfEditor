"""Image-edit insertion: place a signature/stamp image at its box, with optional rotation.

Moved verbatim from app.py — behavior is unchanged.
"""
import base64
import io
import math
import fitz  # PyMuPDF
from PIL import Image


def _insert_image_edit(page, edit):
    """Place a signature/stamp image (PNG/JPEG data-URL) at its box, honouring an optional
    rotation in degrees (CSS-clockwise, about the box centre — matching the on-screen overlay)."""
    img_bytes = base64.b64decode(edit['dataUrl'].split(',', 1)[1])
    x = float(edit.get('x', 0))
    top = float(edit.get('top', 0))
    w = float(edit.get('width', 0))
    h = float(edit.get('height', 0))
    rot = float(edit.get('rotation', 0) or 0)
    if rot:
        # CSS rotates clockwise for +deg; PIL rotates counter-clockwise, so negate. expand=True
        # grows the canvas to the rotated bounding box, which we then place centred on the box.
        im = Image.open(io.BytesIO(img_bytes)).convert('RGBA').rotate(-rot, expand=True, resample=Image.BICUBIC)
        buf = io.BytesIO()
        im.save(buf, format='PNG')
        img_bytes = buf.getvalue()
        rad = math.radians(rot)
        bw = abs(w * math.cos(rad)) + abs(h * math.sin(rad))
        bh = abs(w * math.sin(rad)) + abs(h * math.cos(rad))
        cx, cy = x + w / 2, top + h / 2
        rect = fitz.Rect(cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2)
    else:
        rect = fitz.Rect(x, top, x + w, top + h)
    page.insert_image(rect, stream=img_bytes, keep_proportion=False)
