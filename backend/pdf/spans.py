"""Span / style detection: locate the original span under an edit, read its colour and
weight/slant, decide a line's uniform style, and detect line alignment.

Moved verbatim from app.py — behavior is unchanged. These are the authoritative
weight/colour/alignment signals the frontend can only guess at.
"""
import fitz  # PyMuPDF


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


def _span_color(span):
    """A span's fill colour as an (r, g, b) tuple in 0..1, so a replacement keeps the original
    text colour (e.g. white text on a dark page). PyMuPDF stores it as an sRGB int; default black."""
    c = int((span or {}).get('color', 0) or 0)
    return ((c >> 16 & 255) / 255.0, (c >> 8 & 255) / 255.0, (c & 255) / 255.0)


def _parse_color(c):
    """Frontend colour -> (r, g, b) floats 0..1, or None when unset. Accepts an [r,g,b] list
    (0-255 or already 0-1) or a '#rrggbb' string. Used by the floating toolbar's colour control."""
    if c is None:
        return None
    try:
        if isinstance(c, str):
            s = c.strip().lstrip('#')
            if len(s) == 6:
                return (int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0)
            return None
        if isinstance(c, (list, tuple)) and len(c) >= 3:
            r, g, b = float(c[0]), float(c[1]), float(c[2])
            if max(r, g, b) > 1.0001:                    # 0-255 ints -> 0-1
                return (r / 255.0, g / 255.0, b / 255.0)
            return (r, g, b)
    except (TypeError, ValueError):
        return None
    return None


def _clamp_opacity(v):
    """Frontend opacity -> float in [0, 1]; 1.0 (fully opaque) when unset/invalid."""
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 1.0


# Font-family name hints (used by _span_style and the _resolve_fonts serif override). A clear family
# name in the font's basename is more reliable than the PDF's serif flag bit or the frontend's guess.
_SERIF_NAME_HINTS = ('times', 'serif', 'georgia', 'garamond', 'roman', 'minion', 'charter')
_SANS_NAME_HINTS = ('helvetica', 'arial', 'verdana', 'tahoma', 'segoe', 'calibri', 'roboto',
                    'open sans', 'opensans', 'montserrat', 'noto sans', 'dejavu sans',
                    'liberation sans', 'gill', 'futura', 'myriad')


def _span_style(span):
    """(serif, bold, italic) inferred from a PyMuPDF span's flags + font name. This is the
    authoritative weight/slant for that span — the frontend can only guess from the pdf.js font NAME
    (a loadedName like 'g_d0_f1' that hides the weight), so a bold heading on a standard,
    non-embedded font (e.g. 'Helvetica-Bold') would otherwise come back regular. PyMuPDF span flag
    bits: 1=superscript, 2=italic, 4=serifed, 8=monospaced, 16=bold; the font name is a second
    signal for fonts whose flags don't set the bits."""
    if not span:
        return (False, False, False)
    flags = int(span.get('flags', 0) or 0)
    nm = (span.get('font', '') or '').lower()
    name_serif = any(k in nm for k in _SERIF_NAME_HINTS)
    # A recognisably SANS font name wins over a stray serif flag bit: some PDFs (e.g. Jio bills) set
    # the serif FontDescriptor flag on a 'HelveticaBold', which would otherwise redraw the fallback in
    # Times. Trust the explicit family name over the flag in that case.
    name_sans = any(k in nm for k in _SANS_NAME_HINTS)
    serif = name_serif or (bool(flags & 4) and not name_sans)
    bold = bool(flags & 16) or any(k in nm for k in ('bold', 'black', 'heavy', 'semibold'))
    italic = bool(flags & 2) or ('italic' in nm) or ('oblique' in nm)
    return (serif, bold, italic)


def _line_uniform_style(page, bbox):
    """(serif, bold, italic) where each is True only when EVERY non-blank text span overlapping the
    edited line's bbox has that attribute — i.e. the line is uniformly styled. This recovers a weight
    the frontend's name-based guess missed (a bold heading whose font is the standard, non-embedded
    'Helvetica-Bold') WITHOUT forcing a genuinely mixed line (a bold label + a regular body) bold.
    Must be read BEFORE redaction removes the spans."""
    try:
        rect = fitz.Rect(bbox)
    except Exception:
        return (False, False, False)
    spans = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if not span.get("text", "").strip():
                    continue
                if fitz.Rect(span["bbox"]).intersects(rect):
                    spans.append(span)
    if not spans:
        return (False, False, False)
    serif = all(_span_style(s)[0] for s in spans)
    bold = all(_span_style(s)[1] for s in spans)
    italic = all(_span_style(s)[2] for s in spans)
    return (serif, bold, italic)


def _detect_align(page, span, line_left=None, line_right=None):
    """Best-effort alignment of the edited LINE so a replacement of a different length keeps it:
    'right' for a right-aligned column (several rows end at the SAME x while starting at varying x —
    e.g. résumé dates), 'center' for a line centred in the content area and indented from both
    margins (e.g. a name title), else 'left'. Conservative: anything unclear stays 'left'.

    line_left/line_right (the edit's actual line box) are preferred over the matched span's bbox so
    the full-width guard sees the WHOLE line. A line spanning most of the content width is body /
    justified text — and LaTeX justifies paragraphs, so every full line shares the right margin,
    which otherwise looks like a right-aligned column and shifts the replacement rightward (the
    'extra space before the text' bug)."""
    if not span:
        return 'left'
    sx0 = line_left if line_left is not None else span['bbox'][0]
    sx1 = line_right if line_right is not None else span['bbox'][2]
    # Per-LINE bounds (merge each text line's spans into one bbox) are far more reliable than raw span
    # bboxes: a single body line holds many span fragments whose right edges scatter near the margin and
    # falsely look like a right-aligned column. Collapsing to one bbox per line removes that noise.
    lines_bb = []
    for b in page.get_text("dict").get("blocks", []):
        for line in b.get("lines", []):
            sp = [s['bbox'] for s in line.get("spans", []) if s.get('text', '').strip()]
            if sp:
                lines_bb.append((min(x[0] for x in sp), max(x[2] for x in sp)))
    if len(lines_bb) < 3:
        return 'left'
    margin_left = min(b[0] for b in lines_bb)
    content_right = max(b[1] for b in lines_bb)
    if content_right - margin_left > 1 and (sx1 - sx0) > 0.6 * (content_right - margin_left):
        return 'left'      # near-full-width line -> body/justified text, never a right column/centre
    # A line whose left edge sits on a COMMON left margin (shared by several other lines) is left-anchored
    # text — keep it LEFT even when its right edge happens to align with other lines (a wrapped/justified
    # body line that ends near a column's right edge). This is the 'gap before the text' fix.
    if sum(1 for L, _ in lines_bb if abs(L - sx0) < 1.5) >= 3:
        return 'left'
    indent = sx0 - margin_left
    # right-aligned column: >=2 LINES whose right edge matches this one, lining up tighter on the right
    # than on the left (so it's a right-aligned column — e.g. résumé dates — not a justified/left block).
    same_right = [(L, R) for L, R in lines_bb if abs(R - sx1) < 1.5]
    if len(same_right) >= 2 and indent > 30:
        l_spread = max(L for L, _ in same_right) - min(L for L, _ in same_right)
        r_spread = max(R for _, R in same_right) - min(R for _, R in same_right)
        if l_spread > r_spread + 1.0:
            return 'right'
    # centred: midpoint near the content centre, clearly indented on both sides.
    center = (sx0 + sx1) / 2
    if abs(center - (margin_left + content_right) / 2) < 8 and indent > 25 and (content_right - sx1) > 25:
        return 'center'
    return 'left'
