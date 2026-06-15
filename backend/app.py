from flask import Flask, request, jsonify
from flask_cors import CORS
import fitz  # PyMuPDF
import base64
import io
import math
import os
import re
from PIL import Image

app = Flask(__name__)
CORS(app)  # Allow requests from the frontend

# Defense-in-depth file-size limit (the frontend also blocks oversized files).
# The editor sends the PDF base64-encoded (~1.34x larger), so the raw request cap is
# set above the document limit to fit a MAX_PDF_MB document plus JSON overhead.
MAX_PDF_MB = 100
app.config['MAX_CONTENT_LENGTH'] = int(MAX_PDF_MB * 1.4 * 1024 * 1024)


@app.before_request
def _reject_oversized():
    # Reject before the body is read or any view runs, so the size cap can't be
    # swallowed by a view's error handling. Returns a clean JSON 413.
    cl = request.content_length
    if cl is not None and cl > app.config['MAX_CONTENT_LENGTH']:
        return jsonify({"error": f"File too large. Maximum PDF size is {MAX_PDF_MB} MB."}), 413


@app.errorhandler(413)
def request_too_large(_e):
    return jsonify({"error": f"File too large. Maximum PDF size is {MAX_PDF_MB} MB."}), 413


# Real Unicode TrueType fonts for re-inserting edited text. We choose the family
# (serif vs sans) and weight/style (bold/italic) per line to match the original as closely
# as possible, and fall back to PyMuPDF's builtin Base-14 names (Latin-1 only) when no file
# is present (e.g. on a Linux host). Using TTFs keeps bullets (•), em-dashes (—), curly
# quotes, etc. intact.
#                          (bold, italic) -> ordered file candidates
_SANS_FILES = {
    (False, False): ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
    (True,  False): ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    (False, True):  ["/System/Library/Fonts/Supplemental/Arial Italic.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf"],
    (True,  True):  ["/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf"],
}
_SERIF_FILES = {
    (False, False): ["/System/Library/Fonts/Supplemental/Times New Roman.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"],
    (True,  False): ["/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"],
    (False, True):  ["/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf"],
    (True,  True):  ["/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf"],
}
# Builtin Base-14 fallbacks: (serif, bold, italic) -> PyMuPDF font name.
_BUILTIN = {
    (False, False, False): "helv", (False, True, False): "hebo",
    (False, False, True): "heit",  (False, True, True): "hebi",
    (True, False, False): "tiro",  (True, True, False): "tibo",
    (True, False, True): "tiit",   (True, True, True): "tibi",
}

# Script/italic fonts used for typed signatures.
_SIGN_FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc",
    "/System/Library/Fonts/Supplemental/Apple Chancery.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf",
]


def _find_font(candidates):
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def _edit_font_kwargs(serif, bold, italic):
    """insert_text kwargs (fontname + fontfile, or builtin fontname) for a line's style."""
    files = (_SERIF_FILES if serif else _SANS_FILES).get((bool(bold), bool(italic)), [])
    path = _find_font(files)
    if path:
        # A stable per-variant fontname lets PyMuPDF reuse the embedded font.
        name = "ed_%d%d%d" % (int(bool(serif)), int(bool(bold)), int(bool(italic)))
        return dict(fontname=name, fontfile=path)
    return dict(fontname=_BUILTIN[(bool(serif), bool(bold), bool(italic))])


SIGN_FONT_FILE = _find_font(_SIGN_FONT_CANDIDATES)
SIGN_FONT_NAME = "edsig"


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


def _find_original_span(page, x, baseline):
    """The text span whose origin is closest to (x, baseline). Captured BEFORE redaction so the
    replacement text can reuse the original line's exact font + size."""
    best, best_d = None, 1e9
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                ox, oy = span.get("origin", (span["bbox"][0], span["bbox"][3]))
                d = abs(ox - x) + abs(oy - baseline)
                if d < best_d:
                    best_d, best = d, span
    return best if best_d < 25 else None


def _font_xrefs_for(page, basefont):
    """All embedded-font xrefs whose basefont matches `basefont`, comparing with the 6-letter
    subset prefix stripped (PyMuPDF reports a span's font as 'Calibri' but get_fonts lists it as
    'BCDFEE+Calibri'). Returns simple TrueType fonts first (easiest to reuse via insert_text)."""
    target = (basefont or '').split('+')[-1].lower()
    matches = []
    for f in page.get_fonts(full=True):     # (xref, ext, type, basefont, refname, encoding)
        name = (f[3] or '').split('+')[-1].lower()
        if name == target:
            simple = 0 if f[2] == 'TrueType' else 1   # prefer simple TrueType over Type0/CID
            matches.append((simple, f[0]))
    matches.sort()
    return [x[1] for x in matches]


def _doc_charset_for(doc, basefont, cache):
    """Set of characters actually drawn with `basefont` anywhere in the document. An embedded
    font is usually SUBSET — it only contains glyphs for the characters the document uses — so
    this is a reliable test of what it can render. (Font.has_glyph is not: a subset can keep a
    cmap entry for a character whose outline was stripped, so it reports a glyph that prints as
    nothing — which is why a typed 'J' silently disappeared when the letter had no 'J'.)"""
    target = (basefont or '').split('+')[-1].lower()
    if target in cache:
        return cache[target]
    chars = set()
    for pg in doc:
        for block in pg.get_text("dict").get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    if (span.get('font', '') or '').split('+')[-1].lower() == target:
                        chars.update(span.get('text', ''))
    cache[target] = chars
    return chars


def _reuse_embedded_font(doc, page, xref, text, cache):
    """Install the PDF's OWN embedded font (by xref) and return (fontname, fitz.Font) if it can
    render every character of `text`; else None. Cached per page so each font is embedded once."""
    if xref not in cache:
        entry = None
        try:
            info = doc.extract_font(xref)       # (basename, ext, type, buffer)
            buf = info[3]
            if buf and len(buf) > 4:
                f = fitz.Font(fontbuffer=buf)
                name = "orig%d" % xref
                page.insert_font(fontname=name, fontbuffer=buf)
                entry = (name, f)
        except Exception:
            entry = None
        cache[xref] = entry
    entry = cache[xref]
    if entry and all(ch == ' ' or entry[1].has_glyph(ord(ch)) for ch in text):
        return entry
    return None


def _resolve_text_font(doc, page, edit, text, cache, charset_cache=None):
    """Choose font + size for re-inserting `text`. Prefers the original embedded font at the
    original size (exact match); otherwise an Arial/Times variant. Returns (kwargs, Font, size)."""
    span = edit.get('_span')
    size = float(edit.get('fontSize', 12) or 12)
    serif = bool(edit.get('serif')) or edit.get('fontFamily') == 'serif'
    bold = bool(edit.get('bold'))
    italic = bool(edit.get('italic'))
    if span:
        if span.get('size'):
            size = float(span['size'])           # exact original size (fixes "too big")
        flags = int(span.get('flags', 0))        # PyMuPDF: 2=italic, 4=serif, 16=bold
        serif = serif or bool(flags & 4)
        bold = bold or bool(flags & 16)
        italic = italic or bool(flags & 2)
        # Only reuse the original (often subset) embedded font if it actually contains every
        # character we need — otherwise a freshly typed character that never appears in the
        # document (e.g. a 'J' in a letter that had none) would silently drop. In that case we
        # fall back to a full Arial/Times so every character renders.
        avail = _doc_charset_for(doc, span.get('font', ''), charset_cache if charset_cache is not None else {})
        if all(ord(ch) == 32 or ch in avail for ch in text):
            for xref in _font_xrefs_for(page, span.get('font', '')):
                reused = _reuse_embedded_font(doc, page, xref, text, cache)
                if reused:
                    return dict(fontname=reused[0]), reused[1], size
    kw = _edit_font_kwargs(serif, bold, italic)
    f = fitz.Font(fontfile=kw['fontfile']) if 'fontfile' in kw else fitz.Font(fontname=kw['fontname'])
    return kw, f, size


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({"status": "ok", "message": "PDF Editor Backend is running"})


@app.route('/extract-text', methods=['POST'])
def extract_text():
    """Extract text with positions from a PDF (kept for compatibility; the frontend
    now uses PDF.js for geometry and only relies on the backend for editing/saving)."""
    try:
        if 'file' not in request.files:
            return jsonify({"error": "No file provided"}), 400

        pdf_bytes = request.files['file'].read()
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")

        pages_data = []
        for page_num in range(len(doc)):
            page = doc[page_num]
            rect = page.rect
            text_items = []
            for block in page.get_text("dict").get("blocks", []):
                if block.get("type") == 0:  # text block
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            bbox = span.get("bbox")
                            text_items.append({
                                "text": span.get("text", ""),
                                "x": bbox[0],
                                "y": rect.height - bbox[3],
                                "width": bbox[2] - bbox[0],
                                "height": bbox[3] - bbox[1],
                                "fontSize": span.get("size", 12),
                                "fontName": span.get("font", "Helvetica"),
                            })
            pages_data.append({
                "pageNumber": page_num,
                "width": rect.width,
                "height": rect.height,
                "textItems": text_items,
            })

        page_count = len(doc)
        doc.close()
        return jsonify({"success": True, "pageCount": page_count, "pages": pages_data})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/edit-pdf', methods=['POST'])
def edit_pdf():
    """Replace edited lines in place.

    Each edit describes ONE original line in PDF points with a top-left origin:
      x, right, top, bottom  -> the line's bounding box (used for redaction)
      baseline               -> the text baseline (used to re-insert at the same spot)
      fontSize, newText

    Only the lines the user changed are touched; everything else is left untouched,
    so the original layout (spacing, indents, other text, images) is preserved exactly.
    """
    try:
        data = request.get_json()
        if 'pdfBase64' not in data or 'edits' not in data:
            return jsonify({"error": "Missing required fields"}), 400

        pdf_bytes = base64.b64decode(data['pdfBase64'])
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")

        edits = data['edits']
        print(f"\nProcessing {len(edits)} edit(s)")

        # Group edits by page so we can redact everything, then re-insert text.
        edits_by_page = {}
        for edit in edits:
            edits_by_page.setdefault(int(edit.get('pageIndex', 0)), []).append(edit)

        # Cache of "characters this embedded font actually contains", shared across pages.
        charset_cache = {}

        for page_num, page_edits in edits_by_page.items():
            if page_num < 0 or page_num >= len(doc):
                continue
            page = doc[page_num]
            pw, ph = page.rect.width, page.rect.height
            font_cache = {}

            # 0) BEFORE redacting, capture each replaced line's original font + size so the
            #    replacement matches exactly (redaction deletes the spans, so we must look now).
            for edit in page_edits:
                if edit.get('kind') == 'image' or not edit.get('redact', True):
                    continue
                edit['_span'] = _find_original_span(
                    page, float(edit.get('x', 0)), float(edit.get('baseline', 0)))

            # 1) Redact the original text of REPLACE edits, then re-insert the new text.
            #    Insert-only edits (added text / signatures) set redact=False.
            #    Fill rule:
            #      * Text replace  -> fill=False: remove ONLY the old text and leave the
            #        page's graphics intact, so coloured/shaded cells, borders and logos
            #        survive (no white box over the background).
            #      * Erase tool    -> fill=white: the user wants a clean white-out.
            did_redact = False
            for edit in page_edits:
                if not edit.get('redact', True):
                    continue
                x = float(edit.get('x', 0))
                top = float(edit.get('top', 0))
                bottom = float(edit.get('bottom', 0))
                right = float(edit.get('right', x))
                rect = fitz.Rect(
                    max(0, x - 2),
                    max(0, top - 1),
                    min(pw, max(right, x + 2) + 2),
                    min(ph, bottom + 1),
                )
                is_erase = edit.get('kind') == 'erase'
                page.add_redact_annot(rect, fill=(1, 1, 1) if is_erase else False, cross_out=False)
                did_redact = True
            if did_redact:
                # Keep images; also keep vector graphics where the PyMuPDF build supports it
                # (the `graphics` option / PDF_REDACT_LINE_ART_NONE was added after 1.23.8),
                # so the background fill behind replaced text isn't stripped on newer versions.
                red_kwargs = dict(images=fitz.PDF_REDACT_IMAGE_NONE)
                if hasattr(fitz, 'PDF_REDACT_LINE_ART_NONE'):
                    red_kwargs['graphics'] = fitz.PDF_REDACT_LINE_ART_NONE
                page.apply_redactions(**red_kwargs)

            # 2) Insert images (signatures/stamps) and re-insert edited text at its baseline.
            for edit in page_edits:
                # Image overlay (drawn/typed/uploaded signature, or a stamp).
                if edit.get('kind') == 'image' and edit.get('dataUrl'):
                    _insert_image_edit(page, edit)
                    print(f"  page {page_num}: [image] placed")
                    continue

                x = float(edit.get('x', 0))
                baseline = float(edit.get('baseline', 0))
                style = edit.get('style', 'text')
                new_text = (edit.get('newText', '') or '').replace('\r', '').replace('\n', ' ')
                # Normalise characters a browser's editable box can introduce (non-breaking
                # spaces, zero-width chars, soft hyphens) so they don't render as a missing-
                # glyph box (□) in the PDF's subset font.
                new_text = re.sub(r'[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]', ' ', new_text)
                new_text = re.sub(r'[\u200b\u200c\u200d\u2060\ufeff\u00ad]', '', new_text)
                new_text = re.sub(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]', '', new_text)
                if not new_text:
                    continue

                if style == 'signature' and SIGN_FONT_FILE:
                    kwargs = dict(fontname=SIGN_FONT_NAME, fontfile=SIGN_FONT_FILE)
                    size = float(edit.get('fontSize', 12))
                else:
                    kwargs, font, size = _resolve_text_font(doc, page, edit, new_text, font_cache, charset_cache)
                    # Shrink to fit if the text would run past the right margin (e.g. user added
                    # words, or the fallback font is wider) so an edited line is never cut off.
                    avail = pw - x - 4
                    try:
                        w = font.text_length(new_text, fontsize=size)
                    except Exception:
                        w = 0
                    if w > avail > 8:
                        size = max(4.0, size * avail / w)

                page.insert_text(fitz.Point(x, baseline), new_text, fontsize=size, color=(0, 0, 0), **kwargs)
                # Note: never log the document's text content (keeps the app traceless).
                print(f"  page {page_num}: [{style}] text written at ({x:.1f}, {baseline:.1f})")

        output_bytes = doc.tobytes(deflate=True, garbage=3)
        doc.close()
        return jsonify({
            "success": True,
            "pdfBase64": base64.b64encode(output_bytes).decode('utf-8'),
        })

    except Exception as e:
        print(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/clear-signature', methods=['POST'])
def clear_signature():
    """Clear signature images from a PDF by covering middle-of-page images with white
    (leaves top-of-page logos/headers alone)."""
    try:
        data = request.get_json()
        if 'pdfBase64' not in data:
            return jsonify({"error": "Missing required fields"}), 400

        pdf_bytes = base64.b64decode(data['pdfBase64'])
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")

        for page_num in range(len(doc)):
            page = doc[page_num]
            page_height = page.rect.height
            for img in page.get_images():
                xref = img[0]
                for img_rect in page.get_image_rects(xref):
                    top_pct = (img_rect.y0 / page_height) * 100
                    if 30 <= top_pct <= 80:  # signature zone (skip logos/headers)
                        page.draw_rect(img_rect, color=(1, 1, 1), fill=(1, 1, 1))

        output_bytes = doc.tobytes(deflate=True, garbage=3)
        doc.close()
        return jsonify({
            "success": True,
            "pdfBase64": base64.b64encode(output_bytes).decode('utf-8'),
        })

    except Exception as e:
        print(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    print("🚀 PDF Editor Backend starting...")
    print("📝 Endpoints: GET /health, POST /extract-text, POST /edit-pdf, POST /clear-signature")
    # In production (Render/Railway/Fly) gunicorn serves the `app` object and the platform sets
    # $PORT; we then bind 0.0.0.0 so the host can reach us. With no $PORT (local dev) we keep
    # 127.0.0.1:5001 — localhost-only, never exposed on the network. Port 5000 is avoided
    # because macOS AirPlay Receiver uses it. debug=False disables the code-executing debugger.
    port = int(os.environ.get('PORT', 5001))
    host = '0.0.0.0' if os.environ.get('PORT') else '127.0.0.1'
    print(f"✅ Server running on http://{host}:{port}")
    app.run(debug=False, host=host, port=port)
