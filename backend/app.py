from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix
import fitz  # PyMuPDF
import base64
import io
import math
import os
import re
from PIL import Image

app = Flask(__name__)

# Behind Render's TLS-terminating proxy: trust one X-Forwarded-For / -Proto hop so
# request.remote_addr (the rate-limit key) is the real client, not the proxy. Locally
# there is no proxy header, so this is a no-op in development.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# ---- CORS ----------------------------------------------------------------------------
# Only our own frontend (production + local dev) may call this API from a browser.
# Override with the ALLOWED_ORIGINS env var (comma-separated). NOTE: CORS is enforced by
# the browser — it stops other sites' pages from using fetch() against us; it is NOT a
# server-side firewall (curl / server scripts ignore it). Abuse throttling is the rate
# limiter's job, below.
_DEFAULT_ORIGINS = (
    "https://quickpdfeditor.com,https://www.quickpdfeditor.com,"
    "http://localhost:9000,http://127.0.0.1:9000"
)
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",") if o.strip()
]
CORS(
    app,
    resources={r"/*": {"origins": ALLOWED_ORIGINS}},
    methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
    max_age=86400,
)

# ---- Rate limiting (abuse / DoS protection) ------------------------------------------
# Per-client-IP limits. Storage defaults to in-memory; set RATELIMIT_STORAGE_URI to a
# Redis URL to share counts across gunicorn workers and instances. With in-memory storage
# and N workers, each worker counts independently, so the real limit is ~N x the numbers
# below — fine for abuse prevention; use Redis (or `--workers 1`) for exact limits.
# Set RATELIMIT_ENABLED=0 as an ops kill-switch to disable limiting entirely.
RATE_DEFAULTS = ["60 per minute", "600 per hour"]
RATE_HEAVY = "30 per minute;300 per hour"  # CPU/memory-heavy PDF endpoints

app.config["RATELIMIT_ENABLED"] = os.environ.get("RATELIMIT_ENABLED", "1") not in ("0", "false", "False")

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=RATE_DEFAULTS,
    storage_uri=os.environ.get("RATELIMIT_STORAGE_URI", "memory://"),
    headers_enabled=True,
    strategy="fixed-window",
)


@limiter.request_filter
def _skip_preflight_and_loopback():
    # Never throttle CORS preflight requests, or loopback traffic (local dev, health
    # probes, same-host calls). In production every real request arrives via Render's
    # proxy carrying the client's real IP (see ProxyFix above), so loopback never
    # matches genuine user traffic — this only spares localhost and the test suite.
    return request.method == "OPTIONS" or request.remote_addr in ("127.0.0.1", "::1")


@app.errorhandler(429)
def _rate_limited(_e):
    # JSON 429 to match the rest of the API. flask-cors still attaches the CORS headers
    # to this response, so the browser can read it.
    return jsonify({"error": "Too many requests — please slow down and try again in a moment."}), 429

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

# The 14 standard PDF fonts, by family + (bold, italic) -> PyMuPDF builtin name. Used to re-emit a
# NON-embedded standard font under its OWN name (so a 'Helvetica-Bold' heading saves back as
# 'Helvetica-Bold', not a substituted Arial) for the WinAnsi characters it can draw.
_BASE14_BY_FAMILY = {
    'sans':  {(False, False): 'helv', (True, False): 'hebo', (False, True): 'heit', (True, True): 'hebi'},
    'serif': {(False, False): 'tiro', (True, False): 'tibo', (False, True): 'tiit', (True, True): 'tibi'},
    'mono':  {(False, False): 'cour', (True, False): 'cobo', (False, True): 'coit', (True, True): 'cobi'},
}


def _standard_family(basefont):
    """Family ('sans'|'serif'|'mono') if `basefont` is one of the 14 standard PDF TEXT fonts
    (Helvetica/Arial, Times, Courier), else None. Symbol/ZapfDingbats are intentionally excluded —
    they are symbol fonts, not a home for typed Latin text."""
    nm = (basefont or '').split('+')[-1].lower()
    if nm.startswith('helvetica') or nm.startswith('arial'):
        return 'sans'
    if nm.startswith('times') or 'times new roman' in nm:
        return 'serif'
    if nm.startswith('courier'):
        return 'mono'
    return None


def _base14_draws(ch):
    """True if PyMuPDF's builtin Base-14 fonts render `ch` correctly. Verified by probe: the safe
    set is the Latin-1 printable range (0x20-0x7E and 0xA0-0xFF). The cp1252 'specials' zone
    (smart quotes, en/em dash, bullet, €) misrenders to '·' through the builtin path, so those
    characters are left to a real Unicode TTF instead. Decides which characters a re-emitted
    standard font can keep."""
    o = ord(ch)
    return 0x20 <= o <= 0x7E or 0xA0 <= o <= 0xFF

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

# ---------------------------------------------------------------------------------------------------
#  Toolbar font picker. Each named family the floating toolbar offers resolves to a real font the
#  backend can embed so it renders identically on any host (incl. Linux/Render): a bundled open font
#  (backend/fonts/), a local system font when present, else the metric-compatible Base-14 builtin.
#  `_TOOLBAR_FONTS[key] = (base14_family, variants)` where variants maps (bold, italic) -> candidate
#  file paths (bundled basename or absolute), tried in order. variants=None means "always Base-14".
# ---------------------------------------------------------------------------------------------------
_FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')
_F, _T = False, True
_TOOLBAR_FONTS = {
    # Base-14 metric-compatible — render everywhere, no file needed.
    'arial':     ('sans',  None),
    'helvetica': ('sans',  None),
    'times':     ('serif', None),
    'courier':   ('mono',  None),
    'sans':      ('sans',  None),   # back-compat with the old 3-way picker
    'serif':     ('serif', None),
    'mono':      ('mono',  None),
    # Bundled open fonts (+ local system font first where it exists), Base-14 fallback.
    'roboto':     ('sans', {(_F, _F): ['Roboto-Regular.ttf'], (_T, _F): ['Roboto-Bold.ttf'],
                            (_F, _T): ['Roboto-Italic.ttf'], (_T, _T): ['Roboto-BoldItalic.ttf']}),
    'opensans':   ('sans', {(_F, _F): ['OpenSans-Regular.ttf'], (_T, _F): ['OpenSans-Bold.ttf'],
                            (_F, _T): ['OpenSans-Italic.ttf'], (_T, _T): ['OpenSans-BoldItalic.ttf']}),
    'montserrat': ('sans', {(_F, _F): ['Montserrat-Regular.ttf'], (_T, _F): ['Montserrat-Bold.ttf'],
                            (_F, _T): ['Montserrat-Italic.ttf'], (_T, _T): ['Montserrat-BoldItalic.ttf']}),
    'comicsans':  ('sans', {(_F, _F): ['ComicNeue-Regular.ttf'], (_T, _F): ['ComicNeue-Bold.ttf'],
                            (_F, _T): ['ComicNeue-Italic.ttf'], (_T, _T): ['ComicNeue-BoldItalic.ttf']}),
    'georgia':    ('serif', {
        (_F, _F): ['/System/Library/Fonts/Supplemental/Georgia.ttf', 'Gelasio-Regular.ttf'],
        (_T, _F): ['/System/Library/Fonts/Supplemental/Georgia Bold.ttf', 'Gelasio-Regular.ttf'],
        (_F, _T): ['/System/Library/Fonts/Supplemental/Georgia Italic.ttf', 'Gelasio-Italic.ttf'],
        (_T, _T): ['/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf', 'Gelasio-Italic.ttf']}),
    'verdana':    ('sans', {
        (_F, _F): ['/System/Library/Fonts/Supplemental/Verdana.ttf'],
        (_T, _F): ['/System/Library/Fonts/Supplemental/Verdana Bold.ttf'],
        (_F, _T): ['/System/Library/Fonts/Supplemental/Verdana Italic.ttf'],
        (_T, _T): ['/System/Library/Fonts/Supplemental/Verdana Bold Italic.ttf']}),
}
_toolbar_font_cache = {}


def _toolbar_font_option(family, bold, italic, text):
    """Build the font option for an explicit toolbar family: (insert_kwargs, fitz.Font, charset, True).
    Prefers a real embeddable TTF (so the family renders on any host); falls back to its Base-14 builtin
    (charset = WinAnsi set, so non-Latin glyphs still drop through to the full fallback)."""
    entry = _TOOLBAR_FONTS.get((family or '').lower())
    if not entry:
        return None
    b14_fam, variants = entry
    key = (bool(bold), bool(italic))
    if variants:
        for cand in variants.get(key, []):
            path = cand if os.path.isabs(cand) else os.path.join(_FONTS_DIR, cand)
            if not os.path.exists(path):
                continue
            ce = _toolbar_font_cache.get(path)
            if ce is None:
                try:
                    ce = (re.sub(r'\W', '', 'tf_' + os.path.basename(path)), fitz.Font(fontfile=path))
                    _toolbar_font_cache[path] = ce
                except Exception:
                    _toolbar_font_cache[path] = ce = False
            if ce:
                # Real charset (these are full fonts, so has_glyph is reliable) so _pick_font prefers
                # this font in step 1 — a None charset would only ever be used as the last-resort catch-all.
                cs = {ch for ch in set(text) if ce[1].has_glyph(ord(ch))}
                return (dict(fontname=ce[0], fontfile=path), ce[1], cs, True)
    builtin = _BASE14_BY_FAMILY[b14_fam][key]
    return (dict(fontname=builtin), fitz.Font(fontname=builtin),
            {ch for ch in set(text) if _base14_draws(ch)}, True)


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
    serif = bool(flags & 4) or any(k in nm for k in
                                   ('times', 'serif', 'georgia', 'garamond', 'roman', 'minion', 'charter'))
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


def _font_is_embedded(page, basefont):
    """Whether `basefont` is embedded on the page (carries a font-file stream) rather than a
    name-only standard reference. PyMuPDF reports a non-embedded standard font with ext 'n/a'."""
    target = (basefont or '').split('+')[-1].lower()
    for f in page.get_fonts(full=True):     # (xref, ext, type, basefont, refname, encoding)
        if (f[3] or '').split('+')[-1].lower() == target and (f[1] or '') not in ('', 'n/a'):
            return True
    return False


def _embedded_xrefs(page, basefont):
    """Embedded-font xrefs on the page, with those matching `basefont` first (the closest visual
    match to the edited span) followed by any other embedded fonts. This lets an edited line keep
    a *document* font even when the span we matched (often a bullet) uses a font that can't render
    the new letters — we then reuse the body font instead of dropping to a generic one."""
    primary = _font_xrefs_for(page, basefont)
    seen = set(primary)
    others = []
    for f in page.get_fonts(full=True):     # (xref, ext, type, basefont, refname, encoding)
        if f[0] not in seen and (f[1] or '') not in ('', 'n/a'):   # has an embedded font file
            others.append((0 if f[2] == 'TrueType' else 1, f[0]))
            seen.add(f[0])
    others.sort()
    return primary + [x[1] for x in others]


def _font_charset(doc, basefont, cache):
    """Set of characters actually DRAWN with `basefont` anywhere in the document. This is the only
    reliable test of what a subset embedded font can render: a glyph that was drawn must have an
    outline. font.valid_codepoints() and has_glyph() are NOT reliable — real-world subsets keep the
    full cmap (so they claim ~3600 code points, incl. a 'J' the letter never used) while stripping
    the actual outlines, so a freshly typed 'J' would be assigned to them and render as nothing."""
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


def _warm_charsets(doc, cache):
    """Pre-compute every font's drawn-character set from the ORIGINAL document, in one pass, BEFORE
    any redaction. Redaction removes an edited line's text, so if charsets were built afterwards the
    line's OWN glyphs would look 'undrawable' by their own font and each character would scatter to
    whatever other embedded font happened to draw it elsewhere (a word ending up in 4 fonts). Seeding
    from the original keeps 'drawn == has an outline' (so subset fonts stay honest) while ensuring a
    font is always credited with the characters it actually drew, including on the edited line."""
    for pg in doc:
        for block in pg.get_text("dict").get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    key = (span.get('font', '') or '').split('+')[-1].lower()
                    if key:
                        cache.setdefault(key, set()).update(span.get('text', ''))


def _install_embedded_font(doc, page, xref, cache):
    """Embed the PDF's OWN font (by xref) into the page once and return (fontname, fitz.Font),
    or None if it can't be extracted. Cached per page so each font is embedded only once."""
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
    return cache[xref]


def _resolve_fonts(doc, page, edit, text, cache, charset_cache, style_override=None):
    """Build the list of font options to draw `text` with, plus the size. Each option is
    (insert_kwargs, fitz.Font, charset, style_ok): the document's OWN embedded fonts (matched span's
    font first, then the page's other embedded fonts) each with the set of characters it actually
    drew and whether its weight/slant matches the line, and a full Arial/Times last as a catch-all
    (charset None). Drawing per-character from this keeps the document's look and never drops a glyph
    — even on a line that mixes fonts (a bullet in one font, the body in another).

    The desired weight/slant start from the LINE-level flags the frontend computed (its dominant
    style), then — for a replace edit — are unioned with the original line's UNIFORM style
    (`edit['_lineStyle']`, captured from PyMuPDF before redaction). The frontend can only guess weight
    from the pdf.js font name and misses it for standard fonts (a bold Helvetica heading came back
    regular); the uniform-style signal catches that while leaving a genuinely mixed line (bold label
    + regular body) to the frontend's dominant flag. Union only adds — never un-bolds a correct line."""
    span = edit.get('_span')
    size = float(edit.get('fontSize', 12) or 12)
    # Keep the line's exact original size by DEFAULT (the frontend's geometric size guess can come out
    # "too big"); but honour an explicit toolbar size change, which the frontend marks sizeOverride.
    if span and span.get('size') and not edit.get('sizeOverride'):
        size = float(span['size'])
    _fam_key = (edit.get('fontFamily') or '').lower()
    want_serif = bool(edit.get('serif')) or _TOOLBAR_FONTS.get(_fam_key, (None,))[0] == 'serif'
    # style_override lets a per-run segment request its own weight/slant (mixed bold/italic in
    # one "Add text" box); otherwise the box-level flags apply.
    want_bold = bool(style_override[0]) if style_override else bool(edit.get('bold'))
    want_italic = bool(style_override[1]) if style_override else bool(edit.get('italic'))
    if not style_override:                        # replace edit: recover a uniformly-styled line
        ls = edit.get('_lineStyle')
        if ls:
            want_serif = want_serif or bool(ls[0])
            want_bold = want_bold or bool(ls[1])
            want_italic = want_italic or bool(ls[2])
    options = []
    if span:
        xref_base = {f[0]: (f[3] or '') for f in page.get_fonts(full=True)}   # xref -> basefont
        for xref in _embedded_xrefs(page, span.get('font', '')):
            ent = _install_embedded_font(doc, page, xref, cache)
            if ent:
                base = xref_base.get(xref, '')
                charset = _font_charset(doc, base, charset_cache)
                nm = base.lower()
                # Include LaTeX Computer Modern names (cmbx = bold extended, cmti/cmsl = italic/slanted)
                # so an embedded CM bold/italic font is recognised as style-matched and reused, rather
                # than diverted to a fallback on re-insert.
                is_bold = any(k in nm for k in ('bold', 'black', 'heavy', 'semibold', 'cmbx'))
                is_italic = any(k in nm for k in ('italic', 'oblique', 'cmti', 'cmsl'))
                style_ok = (is_bold == want_bold) and (is_italic == want_italic)
                options.append((dict(fontname=ent[0]), ent[1], charset, style_ok))
    # Level 2: when the original font is a NON-embedded standard font (Helvetica/Times/Courier),
    # re-emit it under its OWN name for the WinAnsi characters it can draw — so a bold Helvetica
    # heading saves back as Helvetica-Bold, not a substitute Arial. Placed FIRST so it beats both a
    # borrowed page font and the TTF catch-all; characters outside WinAnsi still fall through to
    # those. Skipped when the font is embedded (level 1 reuses the real outlines instead).
    # An explicit toolbar "font family" override (Arial/Times/Georgia/Roboto/…) re-emits the text in
    # that family — resolved to a bundled/system TTF or its Base-14 builtin (see _toolbar_font_option) —
    # for a replace edit on ANY original font (even embedded) AND for added text. Placed first so it
    # wins. Without an override, the original re-emit still applies to a non-embedded standard span.
    if _fam_key in _TOOLBAR_FONTS:
        opt = _toolbar_font_option(_fam_key, want_bold, want_italic, text)
        if opt:
            options.insert(0, opt)
    elif span and not _font_is_embedded(page, span.get('font', '')):
        fam = _standard_family(span.get('font', ''))
        if fam:
            builtin = _BASE14_BY_FAMILY[fam][(bool(want_bold), bool(want_italic))]
            try:
                b14 = fitz.Font(fontname=builtin)
                b14_charset = {ch for ch in set(text) if _base14_draws(ch)}
                if b14_charset:
                    options.insert(0, (dict(fontname=builtin), b14, b14_charset, True))
            except Exception:
                pass
    kw = _edit_font_kwargs(want_serif, want_bold, want_italic)   # full fallback (covers Latin)
    fb = fitz.Font(fontfile=kw['fontfile']) if 'fontfile' in kw else fitz.Font(fontname=kw['fontname'])
    options.append((kw, fb, None, True))          # charset None == catch-all
    return options, size


def _pick_font(ch, options):
    """Pick (kwargs, Font) for one character, preferring: (1) an embedded font that drew it AND
    matches the line's weight/slant, then (2) the weight/slant-matched FALLBACK when it can draw the
    character, then (3) any embedded font that drew it, then (4) the full fallback. Step 2 keeps a
    NEW character the document's own fonts never drew — a digit typed into a bold heading whose
    subset font lacks digit glyphs — in the line's weight, instead of borrowing a wrong-weight
    document font (which made typed numbers come out regular inside a bold line). A space goes with
    the first option whose font actually HAS a space glyph (subset CM/LaTeX fonts have none)."""
    if ch == ' ':
        # A space MUST be drawn with a font that actually has a space glyph. Subset LaTeX/Computer
        # Modern fonts have none — PyMuPDF synthesizes inter-word spaces from glyph gaps, so the
        # drawn-charset wrongly credits them, and drawing one yields a .notdef box that renders as �.
        for kwargs, font, charset, style_ok in options:
            if font.has_glyph(0x20):
                return kwargs, font
        return options[0][0], options[0][1]
    # A subset font's drawn-charset can over-credit a character it cannot actually draw (PyMuPDF
    # synthesises some glyphs — e.g. spaces, and in LaTeX/Computer-Modern fonts the odd punctuation),
    # so picking it would emit a .notdef box that renders as gibberish (�). Verify has_glyph before
    # trusting the charset, and fall through to a font that really has the glyph.
    for kwargs, font, charset, style_ok in options:    # 1: drawn-with + right weight/slant
        if charset is not None and style_ok and ch in charset and font.has_glyph(ord(ch)):
            return kwargs, font
    fb = options[-1]                                    # 2: weight/slant-matched fallback (if it has it)
    if fb[2] is None and fb[1].has_glyph(ord(ch)):
        return fb[0], fb[1]
    for kwargs, font, charset, style_ok in options:    # 3: drawn-with (any embedded weight)
        if charset is not None and ch in charset and font.has_glyph(ord(ch)):
            return kwargs, font
    for kwargs, font, charset, style_ok in options:    # 4: full fallback
        if charset is None:
            return kwargs, font
    return options[-1][0], options[-1][1]


def _clean_text(s):
    """Drop stray characters a browser's editable box introduces (nbsp, zero-width, soft hyphen,
    control chars) so they don't save as a missing-glyph box. Keeps tabs; spaces are preserved."""
    s = s or ''
    s = re.sub(r'[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]', ' ', s)
    s = re.sub(r'[\u200b\u200c\u200d\u2060\ufeff\u00ad]', '', s)
    s = re.sub(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]', '', s)  # keeps \t
    return s


def _runs_to_segments(runs, base_size, base_bold, base_italic):
    """Turn the frontend per-run style model (lines -> [{text, size, bold, italic, underline, color}])
    into cleaned [[(text, size, bold, italic, underline, color), ...], ...]. `color` is (r,g,b) 0..1 or
    None. Returns None when there are no runs, so the caller uses the plain single-style path."""
    if not runs:
        return None
    out = []
    for line in runs:
        parts = []
        for r in (line or []):
            t = _clean_text(r.get('text', '')) if isinstance(r, dict) else ''
            if not t:
                continue
            try:
                sz = float(r.get('size') or base_size)
            except (TypeError, ValueError):
                sz = base_size
            b = bool(r.get('bold')) if 'bold' in r else base_bold
            it = bool(r.get('italic')) if 'italic' in r else base_italic
            ul = bool(r.get('underline'))
            col = _parse_color(r.get('color'))
            parts.append((t, max(4.0, min(400.0, sz)), b, it, ul, col))
        out.append(parts)
    return out if any(parts for parts in out) else None


def _detect_align(page, span):
    """Best-effort alignment of `span`'s line so a replacement of a different length keeps it:
    'right' for a right-aligned column (several rows end at the SAME x while starting at varying x —
    e.g. résumé dates), 'center' for a line centred in the content area and indented from both
    margins (e.g. a name title), else 'left'. Conservative: anything unclear stays 'left'."""
    if not span:
        return 'left'
    sx0, _, sx1, _ = span['bbox']
    boxes = [sp['bbox'] for b in page.get_text("dict").get("blocks", [])
             for line in b.get("lines", []) for sp in line.get("spans", []) if sp.get('text', '').strip()]
    if len(boxes) < 3:
        return 'left'
    margin_left = min(b[0] for b in boxes)
    content_right = max(b[2] for b in boxes)
    indent = sx0 - margin_left
    # right-aligned column: >=3 rows whose right edge matches this one, lining up tighter on the
    # right than on the left (so it's a right-aligned column, not a justified/left block).
    same_right = [b for b in boxes if abs(b[2] - sx1) < 1.5]
    if len(same_right) >= 3 and indent > 30:
        l_spread = max(b[0] for b in same_right) - min(b[0] for b in same_right)
        r_spread = max(b[2] for b in same_right) - min(b[2] for b in same_right)
        if l_spread > r_spread + 1.0:
            return 'right'
    # centred: midpoint near the content centre, clearly indented on both sides.
    center = (sx0 + sx1) / 2
    if abs(center - (margin_left + content_right) / 2) < 8 and indent > 25 and (content_right - sx1) > 25:
        return 'center'
    return 'left'


def _insert_text_runs(page, x, baseline, text, size, options, avail, morph=None, color=(0, 0, 0),
                      anchor=None, opacity=1.0, underline=False, measure_only=False):
    """Draw `text` at (x, baseline), switching font per run so every character uses a font that
    contains it. Groups consecutive same-font characters, shrinks to fit `avail` width, then
    inserts each run, advancing x by its measured width. `morph` (a (fixpoint, Matrix) pair)
    rotates the drawn text about a pivot — used for rotated "Add text" boxes. `anchor`
    (align, box_left, box_right) re-anchors a right-/centre-aligned replacement so a shorter/longer
    edit keeps the line's alignment instead of always starting at the left. `opacity` (0..1) and
    `underline` come from the floating toolbar. `measure_only` returns the drawn width without
    drawing (used to lay out a multi-line added-text box for alignment)."""
    runs, cur, cur_opt = [], [], None
    for ch in text:
        # Keep a space within the current run only when that run's font can actually draw one (most
        # fonts). If it can't (a Computer Modern / LaTeX subset font has no space glyph), fall through
        # to _pick_font so the space is drawn with a space-capable font instead of a � (.notdef) box.
        if ch == ' ' and cur_opt is not None and cur_opt[1].has_glyph(0x20):
            cur.append(ch)
            continue
        opt = _pick_font(ch, options)
        if cur_opt is None or opt[0].get('fontname') != cur_opt[0].get('fontname'):
            if cur:
                runs.append((cur_opt, ''.join(cur)))
            cur, cur_opt = [], opt
        cur.append(ch)
    if cur:
        runs.append((cur_opt, ''.join(cur)))

    total = sum(opt[1].text_length(s, fontsize=size) for opt, s in runs)
    if total > avail > 8:
        size = max(4.0, size * avail / total)
        total = sum(opt[1].text_length(s, fontsize=size) for opt, s in runs)   # after shrink
    if measure_only:
        return total

    cx = x
    if anchor:
        align, box_left, box_right = anchor
        if align == 'right':
            cx = max(box_left, box_right - total)
        elif align == 'center':
            cx = max(box_left, (box_left + box_right) / 2 - total / 2)
    start = cx
    extra = {'morph': morph} if morph else {}
    if opacity is not None and opacity < 1.0:
        extra['fill_opacity'] = opacity
    for opt, s in runs:
        kwargs, font = opt
        page.insert_text(fitz.Point(cx, baseline), s, fontsize=size, color=color, **kwargs, **extra)
        cx += font.text_length(s, fontsize=size)
    if underline and cx > start:
        # A line just below the baseline spanning the drawn text; honour rotation + opacity via Shape.
        uy = baseline + size * 0.12
        sh = page.new_shape()
        sh.draw_line(fitz.Point(start, uy), fitz.Point(cx, uy))
        fin = dict(color=color, width=max(0.4, size * 0.055),
                   stroke_opacity=(opacity if opacity is not None else 1.0))
        if morph:
            fin['morph'] = morph
        sh.finish(**fin)
        sh.commit()
    return cx - start          # drawn advance width (lets a caller chain segments on one line)


@app.route('/health', methods=['GET'])
@limiter.exempt
def health():
    """Health check endpoint"""
    return jsonify({"status": "ok", "message": "PDF Editor Backend is running"})


@app.route('/extract-text', methods=['POST'])
@limiter.limit(RATE_HEAVY)
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
@limiter.limit(RATE_HEAVY)
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

        # Cache of "characters this embedded font actually drew", shared across pages. Warm it from
        # the ORIGINAL doc now, before any redaction, so an edited line's own glyphs aren't lost and
        # its characters don't scatter across multiple fonts on re-insert.
        charset_cache = {}
        _warm_charsets(doc, charset_cache)

        for page_num, page_edits in edits_by_page.items():
            if page_num < 0 or page_num >= len(doc):
                continue
            page = doc[page_num]
            pw, ph = page.rect.width, page.rect.height
            font_cache = {}
            # Capture hyperlink annotations now: apply_redactions drops the ones overlapping an
            # edited line, so we re-add the lost ones after re-inserting (keeps links clickable).
            try:
                saved_links = [l for l in page.get_links() if l.get('uri')]
            except Exception:
                saved_links = []
            redact_rects = []

            # 0) BEFORE redacting, capture each replaced line's original font + size so the
            #    replacement matches exactly (redaction deletes the spans, so we must look now).
            for edit in page_edits:
                if edit.get('kind') == 'image' or not edit.get('redact', True):
                    continue
                edit['_span'] = _find_original_span(
                    page, float(edit.get('x', 0)), float(edit.get('baseline', 0)))
                # The line's uniform weight/slant (authoritative PyMuPDF flags) recovers a bold/italic
                # the frontend's name-based guess missed; mixed lines stay on the frontend's flag.
                x = float(edit.get('x', 0))
                edit['_lineStyle'] = _line_uniform_style(page, (
                    x, float(edit.get('top', 0)),
                    float(edit.get('right', x)), float(edit.get('bottom', 0))))
                # Detected alignment, so a different-length replacement keeps a right-aligned date
                # column or a centred title aligned (re-anchored on re-insert), not left-shifted.
                edit['_align'] = _detect_align(page, edit['_span'])

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
                redact_rects.append(rect)
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
                # Normalise stray characters a browser's editable box can introduce (nbsp,
                # zero-width, soft hyphen) so they don't render as a missing-glyph box. Keep
                # line breaks for ADDED text (it can be multi-line); replace edits are one line.
                raw = (edit.get('newText', '') or '').replace('\r\n', '\n').replace('\r', '\n')
                raw = re.sub(r'[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]', ' ', raw)
                raw = re.sub(r'[\u200b\u200c\u200d\u2060\ufeff\u00ad]', '', raw)
                raw = re.sub(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]', '', raw)  # keeps \t and \n
                is_insert = not edit.get('redact', True)
                text_lines = raw.split('\n') if is_insert else [raw.replace('\n', ' ')]
                if not any(ln.strip() for ln in text_lines):
                    continue

                if style == 'signature' and SIGN_FONT_FILE:
                    size = float(edit.get('fontSize', 12))
                    page.insert_text(fitz.Point(x, baseline), ' '.join(text_lines), fontsize=size,
                                     color=(0, 0, 0), fontname=SIGN_FONT_NAME, fontfile=SIGN_FONT_FILE)
                else:
                    # Draw per-character with the document's own fonts (matched span first, then
                    # the page's other embedded fonts, then a full fallback), so a line keeps its
                    # look even when it mixes fonts. Added text may be multiple lines: draw each
                    # at baseline + i*lineHeight.
                    options, size = _resolve_fonts(doc, page, edit, '\n'.join(text_lines), font_cache, charset_cache)
                    # Re-insert in the ORIGINAL text colour (e.g. white on a dark page); the span we
                    # captured before redaction carries it. Added text / signatures stay black.
                    text_color = _span_color(edit.get('_span')) if edit.get('redact', True) else (0, 0, 0)
                    # Floating-toolbar styling (all optional; absent == today's behaviour): an explicit
                    # colour overrides the default, plus box-level opacity, underline and alignment.
                    box_color = _parse_color(edit.get('color'))
                    box_opacity = _clamp_opacity(edit.get('opacity'))
                    box_underline = bool(edit.get('underline'))
                    box_align = edit.get('align') if edit.get('align') in ('left', 'center', 'right') else None
                    # Rotated "Add text": rotate the whole block about its origin (x, baseline).
                    # CSS rotates clockwise; fitz.Matrix(-deg) matches that in the page's y-down space.
                    rotation = float(edit.get('rotation', 0) or 0)
                    morph = (fitz.Point(x, baseline), fitz.Matrix(-rotation)) if rotation else None
                    # Added text may carry per-run style (edit['runs'] = lines -> [{text,size,bold,
                    # italic,underline,color}]). Insert each segment at its own size + weight/slant,
                    # chaining x by the drawn width; line height follows that line's largest run. Font
                    # options are resolved per distinct (bold, italic) so each segment gets the right variant.
                    seg_lines = _runs_to_segments(
                        edit.get('runs'), size, bool(edit.get('bold')), bool(edit.get('italic'))
                    ) if is_insert else None
                    if seg_lines is not None:
                        style_opts = {}

                        def opts_for(b, it):
                            key = (b, it)
                            if key not in style_opts:
                                style_opts[key], _ = _resolve_fonts(
                                    doc, page, edit, '\n'.join(text_lines),
                                    font_cache, charset_cache, style_override=(b, it))
                            return style_opts[key]

                        # Alignment within an added box: measure each line, then offset shorter lines.
                        def line_width(parts):
                            return sum(_insert_text_runs(page, 0, 0, st, ssz, opts_for(sb, si), 1e9,
                                                         measure_only=True)
                                       for st, ssz, sb, si, _, _ in parts if st)
                        widths = [line_width(parts) for parts in seg_lines]
                        maxw = max(widths, default=0.0)

                        y = baseline
                        prev_max = None
                        for idx, parts in enumerate(seg_lines):
                            this_max = max([sz for _, sz, _, _, _, _ in parts], default=size)
                            # Advance to this line using the LARGER of the two adjacent lines, so a
                            # big line after a small one (or vice-versa) never overlaps.
                            if prev_max is not None:
                                y += max(prev_max, this_max) * 1.2
                            off = (maxw - widths[idx]) if box_align == 'right' else \
                                  (maxw - widths[idx]) / 2 if box_align == 'center' else 0.0
                            cx = x + max(0.0, off)
                            for seg_text, seg_size, seg_bold, seg_italic, seg_ul, seg_col in parts:
                                if seg_text:
                                    cx += _insert_text_runs(page, cx, y, seg_text, seg_size,
                                                            opts_for(seg_bold, seg_italic),
                                                            pw - cx - 4, morph,
                                                            color=(seg_col or box_color or text_color),
                                                            opacity=box_opacity,
                                                            underline=(seg_ul or box_underline))
                            prev_max = this_max
                    else:
                        # Replace edits re-anchor to keep right/centre alignment (manual override wins
                        # over the auto-detected _align); added text is left.
                        align = box_align or (None if is_insert else edit.get('_align', 'left'))
                        anchor = None if is_insert else ((align or 'left'), x, float(edit.get('right', x)))
                        line_color = box_color or text_color
                        line_ul = bool(edit.get('underline'))
                        line_h = size * 1.2
                        for i, ln in enumerate(text_lines):
                            if ln.strip():
                                _insert_text_runs(page, x, baseline + i * line_h, ln, size, options,
                                                  pw - x - 4, morph, color=line_color, anchor=anchor,
                                                  opacity=box_opacity, underline=line_ul)
                # Note: never log the document's text content (keeps the app traceless).
                print(f"  page {page_num}: [{style}] text written at ({x:.1f}, {baseline:.1f})")

            # Re-add hyperlinks the redaction dropped (so an edited footer/contact line stays
            # clickable). Only restore links that OVERLAP a redacted rect — those are the ones
            # apply_redactions removed; others survived. Avoids get_links() here (it can raise right
            # after redaction) and avoids duplicating links that weren't touched.
            for l in saved_links:
                r = fitz.Rect(l['from'])
                if any(r.intersects(rr) for rr in redact_rects):
                    try:
                        page.insert_link({"kind": fitz.LINK_URI, "from": r, "uri": l['uri']})
                    except Exception:
                        pass

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


@app.route('/decrypt', methods=['POST'])
@limiter.limit(RATE_HEAVY)
def decrypt_pdf():
    """Return an unencrypted copy of a PDF that is encrypted but openable without a
    password (empty user password / permission-only restrictions). The client-side Merge
    feature uses this because pdf-lib cannot decrypt. PDFs that need a real password are
    reported back (needsPassword) so the UI can ask the user to unlock them first.
    Nothing is stored — the file is decrypted in memory and the bytes are returned."""
    try:
        data = request.get_json(silent=True) or {}
        if 'pdfBase64' not in data:
            return jsonify({"success": False, "error": "Missing required fields"}), 400

        pdf_bytes = base64.b64decode(data['pdfBase64'])
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        except Exception:
            return jsonify({"success": False, "error": "Could not read PDF"}), 400

        # A real password is required only if the empty password fails to authenticate.
        if doc.needs_pass and not doc.authenticate(""):
            doc.close()
            return jsonify({"success": False, "needsPassword": True,
                            "error": "This PDF needs a password to open."}), 200

        # Re-save with encryption explicitly removed (the default KEEP would retain it).
        output_bytes = doc.tobytes(encryption=fitz.PDF_ENCRYPT_NONE, deflate=True, garbage=3)
        doc.close()
        return jsonify({
            "success": True,
            "pdfBase64": base64.b64encode(output_bytes).decode('utf-8'),
        })

    except Exception as e:
        print(f"Error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == '__main__':
    print("🚀 PDF Editor Backend starting...")
    print("📝 Endpoints: GET /health, POST /extract-text, POST /edit-pdf, POST /clear-signature, POST /decrypt")
    # In production (Render/Railway/Fly) gunicorn serves the `app` object and the platform sets
    # $PORT; we then bind 0.0.0.0 so the host can reach us. With no $PORT (local dev) we keep
    # 127.0.0.1:5001 — localhost-only, never exposed on the network. Port 5000 is avoided
    # because macOS AirPlay Receiver uses it. debug=False disables the code-executing debugger.
    port = int(os.environ.get('PORT', 5001))
    host = '0.0.0.0' if os.environ.get('PORT') else '127.0.0.1'
    print(f"✅ Server running on http://{host}:{port}")
    app.run(debug=False, host=host, port=port)
