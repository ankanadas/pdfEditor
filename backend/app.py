from flask import Flask, request, jsonify
from flask_cors import CORS
from flask_limiter import Limiter
# pyrefly: ignore [missing-import]
from flask_limiter.util import get_remote_address
# pyrefly: ignore [missing-import]
from werkzeug.middleware.proxy_fix import ProxyFix
# pyrefly: ignore [missing-import]
import fitz  # PyMuPDF
import base64
import io
import math
import os
import re
# pyrefly: ignore [missing-import]
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
# Per-client-IP limits. Storage defaults to in-memory, which lives inside ONE process and
# resets on restart. The default deploy runs a single gunicorn worker (see render.yaml), so
# in-memory counting is EXACT there. The moment you scale to N workers/instances, each counts
# independently and the real limit becomes ~N x the numbers below (and still resets on deploy)
# — fine for casual abuse prevention, but set RATELIMIT_STORAGE_URI to a Redis URL to share
# counts across workers/instances and make the limit exact and durable when you scale up.
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
#
# Kept deliberately modest: a base64 PDF is held whole in RAM, decoded to bytes, then
# PyMuPDF's working set is a further multiple of that. On a 512 MB instance a couple of
# large concurrent uploads would OOM, so 30 MB (override via MAX_PDF_MB) leaves headroom.
# MAX_PDF_PAGES additionally bounds the per-document working set for pathological
# tiny-page / huge-count files that would otherwise slip under the byte-size cap.
MAX_PDF_MB = int(os.environ.get("MAX_PDF_MB", "30"))
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", "500"))
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
# as possible. The BUNDLED open fonts (Arimo/Tinos, OFL/Apache) are tried first so the result is
# license-safe and identical on every host (incl. Linux/Render); local system fonts and Base-14 are
# only later fallbacks. Using TTFs keeps bullets (•), em-dashes (—), curly quotes, etc. intact.
_FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')


def _bundled(stem):
    return os.path.join(_FONTS_DIR, stem)


#                          (bold, italic) -> ordered file candidates (bundled open font first)
_SANS_FILES = {
    (False, False): [_bundled("Arimo-Regular.ttf"), "/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
    (True,  False): [_bundled("Arimo-Bold.ttf"), "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    (False, True):  [_bundled("Arimo-Italic.ttf"), "/System/Library/Fonts/Supplemental/Arial Italic.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Oblique.ttf"],
    (True,  True):  [_bundled("Arimo-BoldItalic.ttf"), "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf"],
}
_SERIF_FILES = {
    (False, False): [_bundled("Tinos-Regular.ttf"), "/System/Library/Fonts/Supplemental/Times New Roman.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"],
    (True,  False): [_bundled("Tinos-Bold.ttf"), "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"],
    (False, True):  [_bundled("Tinos-Italic.ttf"), "/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf"],
    (True,  True):  [_bundled("Tinos-BoldItalic.ttf"), "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf"],
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
#  Toolbar font picker. The dropdown keeps the FAMILIAR names (Arial, Times New Roman, …) but the PDF
#  generator only ever embeds legally distributable OPEN fonts (bundled in backend/fonts/, OFL/Apache),
#  each metric-compatible with the name the user picked, so the saved file looks the same and renders
#  identically on any host (incl. Linux/Render). The proprietary originals are never bundled/embedded.
#    Arial / Helvetica / Verdana -> Arimo   (Apache-2.0, metric-compatible with Arial)
#    Times New Roman             -> Tinos   (Apache-2.0, metric-compatible with Times New Roman)
#    Courier New                 -> Cousine (Apache-2.0, metric-compatible with Courier New)
#    Georgia                     -> Gelasio (OFL, metric-compatible with Georgia)
#    Comic Sans MS               -> Comic Neue (OFL)        Roboto/Open Sans/Montserrat -> themselves
#  `_TOOLBAR_FONTS[key] = (generic_family, variants)` where variants maps (bold, italic) -> bundled
#  file candidates; the Base-14 builtin for `generic_family` is the last-resort fallback if a file is
#  somehow missing (still non-proprietary — Base-14 fonts are referenced by name, never embedded).
# ---------------------------------------------------------------------------------------------------
_F, _T = False, True


def _vfiles(stem):
    """The bundled weight/slant files for a family: stem-{Regular,Bold,Italic,BoldItalic}.ttf, each
    with in-family fallbacks so a family that ships fewer weights (e.g. Pacifico = Regular only, or
    a code font with no italic) stays in its OWN face rather than dropping to a Base-14 substitute.
    _toolbar_font_option picks the first candidate that actually exists on disk."""
    R, B, I, BI = f'{stem}-Regular.ttf', f'{stem}-Bold.ttf', f'{stem}-Italic.ttf', f'{stem}-BoldItalic.ttf'
    return {(_F, _F): [R], (_T, _F): [B, R], (_F, _T): [I, R], (_T, _T): [BI, B, I, R]}


_TOOLBAR_FONTS = {
    'arial':      ('sans',  _vfiles('Arimo')),       # Arial           -> Arimo
    'helvetica':  ('sans',  _vfiles('Arimo')),       # Helvetica       -> Arimo
    'verdana':    ('sans',  _vfiles('Arimo')),       # Verdana         -> Arimo
    'times':      ('serif', _vfiles('Tinos')),       # Times New Roman -> Tinos
    'courier':    ('mono',  _vfiles('Cousine')),     # Courier New     -> Cousine
    'georgia':    ('serif', _vfiles('Gelasio')),     # Georgia         -> Gelasio
    'comicsans':  ('sans',  _vfiles('ComicNeue')),   # Comic Sans MS   -> Comic Neue
    'roboto':     ('sans',  _vfiles('Roboto')),
    'opensans':   ('sans',  _vfiles('OpenSans')),
    'montserrat': ('sans',  _vfiles('Montserrat')),
    # --- proprietary names -> open, metric/visual-close substitutes (originals never bundled) ---
    'calibri':         ('sans',  _vfiles('Carlito')),          # Calibri      -> Carlito (Apache-2.0)
    'cambria':         ('serif', _vfiles('Caladea')),          # Cambria      -> Caladea (Apache-2.0)
    'consolas':        ('mono',  _vfiles('Cousine')),          # Consolas     -> Cousine (Apache-2.0; Liberation Mono twin)
    'tahoma':          ('sans',  _vfiles('Arimo')),            # Tahoma       -> Arimo
    'trebuchet':       ('sans',  _vfiles('Arimo')),            # Trebuchet MS -> Arimo
    'garamond':        ('serif', _vfiles('EBGaramond')),       # Garamond     -> EB Garamond (OFL)
    'baskerville':     ('serif', _vfiles('LibreBaskerville')), # Baskerville  -> Libre Baskerville (OFL)
    'palatino':        ('serif', _vfiles('NotoSerif')),        # Palatino     -> Noto Serif (OFL)
    'brushscript':     ('sans',  _vfiles('Pacifico')),         # Brush Script -> Pacifico (OFL)
    # --- open-source fonts shown under their REAL names ---
    'inter':           ('sans',  _vfiles('Inter')),
    'lato':            ('sans',  _vfiles('Lato')),
    'poppins':         ('sans',  _vfiles('Poppins')),
    'nunito':          ('sans',  _vfiles('Nunito')),
    'sourcesans':      ('sans',  _vfiles('SourceSans3')),      # Source Sans Pro -> Source Sans 3
    'ubuntu':          ('sans',  _vfiles('Ubuntu')),
    'ptsans':          ('sans',  _vfiles('PTSans')),
    'merriweather':    ('serif', _vfiles('Merriweather')),
    'librebaskerville':('serif', _vfiles('LibreBaskerville')),
    'playfair':        ('serif', _vfiles('PlayfairDisplay')),
    'notoserif':       ('serif', _vfiles('NotoSerif')),
    'firacode':        ('mono',  _vfiles('FiraCode')),
    'jetbrainsmono':   ('mono',  _vfiles('JetBrainsMono')),
    'sourcecodepro':   ('mono',  _vfiles('SourceCodePro')),
    'ibmplexmono':     ('mono',  _vfiles('IBMPlexMono')),
    'pacifico':        ('sans',  _vfiles('Pacifico')),
    'comicneue':       ('sans',  _vfiles('ComicNeue')),
    # Back-compat keys from the old 3-way picker (and the added-text default 'sans').
    'sans':       ('sans',  _vfiles('Arimo')),
    'serif':      ('serif', _vfiles('Tinos')),
    'mono':       ('mono',  _vfiles('Cousine')),
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


# LaTeX/TeX subset fonts: Computer Modern (CMR/CMBX/CMTI/CMSY/CMMI/CMCSC…) and Latin Modern (LMR…).
_LATEX_FONT_RE = re.compile(r'^(cm|lm)[a-z]{1,6}\d')


def _is_latex_subset_font(basefont):
    """A LaTeX/TeX Type1 SUBSET font (Computer Modern / Latin Modern). These use a non-standard TeX
    encoding whose re-insertion is unreliable: PyMuPDF draws via the re-embedded font's own glyph
    mapping, which can disagree with the has_glyph check used to pick it and come out as the WRONG
    (symbol-like) glyphs — the 'edited line is gibberish only after save' bug. We do NOT reuse them;
    their text is redrawn with the open serif/sans fallback, which is correct on every host."""
    return bool(_LATEX_FONT_RE.match((basefont or '').split('+')[-1].lower()))


# Open, LaTeX-compatible fallback faces (bundled OTF) for re-drawing edited text whose original
# embedded LaTeX/TeX font can't be reused — so the edit blends with the surrounding LaTeX text
# instead of dropping to Arial/Times. Latin Modern = the open Computer Modern; TeX Gyre
# Termes/Heros/Cursor = open Times/Helvetica/Courier (for LaTeX docs that use those families).
_LATEX_FILES = {
    'cm': {   # Computer Modern / Latin Modern -> Latin Modern (serif / sans / mono)
        'serif': {(False, False): 'LMRoman-Regular.otf', (True, False): 'LMRoman-Bold.otf',
                  (False, True): 'LMRoman-Italic.otf',  (True, True): 'LMRoman-BoldItalic.otf'},
        'sans':  {(False, False): 'LMSans-Regular.otf',  (True, False): 'LMSans-Bold.otf',
                  (False, True): 'LMSans-Regular.otf',   (True, True): 'LMSans-Bold.otf'},
        'mono':  {(False, False): 'LMMono-Regular.otf',  (True, False): 'LMMono-Regular.otf',
                  (False, True): 'LMMono-Regular.otf',   (True, True): 'LMMono-Regular.otf'},
    },
    'times':     {(False, False): 'TeXGyreTermes-Regular.otf', (True, False): 'TeXGyreTermes-Bold.otf',
                  (False, True): 'TeXGyreTermes-Italic.otf',   (True, True): 'TeXGyreTermes-BoldItalic.otf'},
    'helvetica': {(False, False): 'TeXGyreHeros-Regular.otf',  (True, False): 'TeXGyreHeros-Bold.otf',
                  (False, True): 'TeXGyreHeros-Regular.otf',   (True, True): 'TeXGyreHeros-Bold.otf'},
    'courier':   {(False, False): 'TeXGyreCursor-Regular.otf', (True, False): 'TeXGyreCursor-Regular.otf',
                  (False, True): 'TeXGyreCursor-Regular.otf',  (True, True): 'TeXGyreCursor-Regular.otf'},
}
_LATEX_BOLD_HINTS = ('cmbx', 'cmb', 'bx', 'bold', 'black', 'heavy', 'semibold')
_LATEX_ITALIC_HINTS = ('cmti', 'cmsl', 'cmmi', 'cmssi', 'cmitt', 'cmsltt', 'italic', 'oblique', 'slanted')


def _latex_font_profile(basefont):
    """If `basefont` is a LaTeX/TeX family, return (shape, family, bold, italic):
      shape in {'cm','times','helvetica','courier'} chooses the open fallback;
      family in {'serif','sans','mono'} picks the Latin Modern face.
    Recognises Computer Modern (CMR/CMBX/CMTI/CMSY/CMMI/CMSS/CMTT…), Latin Modern (LMRoman/LMSans/
    LMMono…), TeX Gyre (Termes/Heros/Cursor…) and the classic mathptmx/helvet/courier substitutes,
    including subset names like 'ABCDEF+CMR10' or 'XYZABC+LMRoman10-Regular'. None if not LaTeX/TeX."""
    raw = (basefont or '').split('+')[-1].lower()
    nm = raw.replace(' ', '').replace('-', '')
    cm_lm = bool(_LATEX_FONT_RE.match(raw)) or 'latinmodern' in nm or 'computermodern' in nm \
        or nm.startswith(('lmroman', 'lmsans', 'lmmono'))
    times = any(k in nm for k in ('texgyretermes', 'termes', 'nimbusrom', 'pagella', 'bonum', 'schola'))
    helv = any(k in nm for k in ('texgyreheros', 'heros', 'nimbussans', 'adventor'))
    cour = any(k in nm for k in ('texgyrecursor', 'cursor', 'nimbusmono'))
    if not (cm_lm or times or helv or cour):
        return None
    bold = any(k in nm for k in _LATEX_BOLD_HINTS)
    italic = any(k in nm for k in _LATEX_ITALIC_HINTS)
    if times:
        return ('times', 'serif', bold, italic)
    if helv:
        return ('helvetica', 'sans', bold, italic)
    if cour:
        return ('courier', 'mono', bold, italic)
    if any(k in nm for k in ('cmss', 'lmsans', 'lmss')):
        fam = 'sans'
    elif any(k in nm for k in ('cmtt', 'cmitt', 'cmsltt', 'lmmono', 'lmtt')):
        fam = 'mono'
    else:
        fam = 'serif'
    return ('cm', fam, bold, italic)


def _latex_fallback_kwargs(profile, bold, italic):
    """insert_text kwargs (stable fontname + bundled OTF path) for the open LaTeX-compatible face
    matching `profile`'s shape/family and the requested weight/slant. None if the file is missing."""
    shape, family = profile[0], profile[1]
    key = (bool(bold), bool(italic))
    table = _LATEX_FILES['cm'][family] if shape == 'cm' else _LATEX_FILES[shape]
    fname = table.get(key) or table[(False, False)]
    path = _bundled(fname)
    if not os.path.exists(path):
        return None
    return dict(fontname='lx_%s_%s_%d%d' % (shape, family, int(key[0]), int(key[1])), fontfile=path)


def _is_embedded_type1(ext, ftype):
    """An embedded PostScript Type1 / CIDFontType0 outline font (ext 'pfa'/'pfb', or type 'Type1').

    Reusing one to re-insert edited text is unsafe: PyMuPDF re-embeds it as a CIDFontType0 /
    Identity-H font whose glyph indices don't line up with what STRICT viewers (macOS Preview,
    Acrobat) expect, so the edited text renders as the WRONG glyphs there — while PyMuPDF and PDF.js
    render it fine and it still copies/extracts correctly via ToUnicode, which hides the bug until
    the user opens the download (e.g. Jio bills with custom 'HelveticaBold' Type1 fonts). We don't
    reuse them; the text is redrawn with the bundled, metric-compatible open font, which is correct
    everywhere. TrueType ('ttf') embeds reuse cleanly (CIDFontType2 with a proper CIDToGIDMap) and
    are kept — that's how an edited résumé line keeps its real Calibri outlines."""
    return (ext or '').lower() in ('pfa', 'pfb') or (ftype or '').lower() == 'type1'


def _span_uses_unreusable_embedded(page, span):
    """True if `span` is drawn with an embedded font we WON'T reuse for re-insertion (a PostScript
    Type1 or LaTeX subset). These faces often carry the 'Foradian' rupee convention — the ₹ glyph
    sits in the grave-accent slot (U+0060), so the symbol extracts/edits as a backtick. When such a
    line is redrawn with the bundled fallback (which draws a literal backtick), the grave accent must
    be mapped back to a real ₹ (see the remap in edit_pdf)."""
    if not span:
        return False
    target = (span.get('font', '') or '').split('+')[-1].lower()
    for f in page.get_fonts(full=True):     # (xref, ext, type, basefont, refname, encoding)
        if (f[3] or '').split('+')[-1].lower() == target:
            if _is_latex_subset_font(f[3]) or _is_embedded_type1(f[1], f[2]):
                return True
    return False


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
    # The backend knows the original span's REAL font name; a clearly sans/serif family there overrides
    # the frontend's name-based guess (pdf.js can mislabel a flag-serifed 'HelveticaBold' as serif, so
    # the sans original would otherwise be redrawn in Times). Only a user-chosen fontFamily wins over it.
    if span and not _fam_key:
        _nm = (span.get('font', '') or '').lower()
        if any(k in _nm for k in _SANS_NAME_HINTS):
            want_serif = False
        elif any(k in _nm for k in _SERIF_NAME_HINTS):
            want_serif = True
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
        # xref -> (basefont, ext, type) so we can both name- and type-match each embedded font.
        xref_meta = {f[0]: (f[3] or '', f[1] or '', f[2] or '') for f in page.get_fonts(full=True)}
        for xref in _embedded_xrefs(page, span.get('font', '')):
            base, ext, ftype = xref_meta.get(xref, ('', '', ''))
            # Never reuse a font whose re-insertion draws the wrong glyphs after save: LaTeX/Computer-
            # Modern subsets (TeX encoding) and any embedded PostScript Type1/CIDFontType0 outline
            # (mis-mapped by strict viewers — Preview/Acrobat). Their text drops to the open fallback.
            if _is_latex_subset_font(base) or _is_embedded_type1(ext, ftype):
                continue
            ent = _install_embedded_font(doc, page, xref, cache)
            if ent:
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
    # Catch-all fallback. For an unreusable LaTeX/TeX original (Computer Modern / Latin Modern /
    # TeX Gyre) with no explicit dropdown font, redraw with the matching OPEN LaTeX-compatible face
    # (Latin Modern / TeX Gyre) so the edit blends with the surrounding LaTeX text, instead of
    # dropping to the generic Arial/Times. A user-chosen toolbar font (handled above) still wins.
    latex_kw = None
    if span and _fam_key not in _TOOLBAR_FONTS:
        prof = _latex_font_profile(span.get('font', ''))
        if prof:
            latex_kw = _latex_fallback_kwargs(prof, want_bold or prof[2], want_italic or prof[3])
    if latex_kw:
        kw, fb = latex_kw, fitz.Font(fontfile=latex_kw['fontfile'])
    else:
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


# ToUnicode destinations to repair: nbsp -> space, soft-hyphen -> hyphen. These are NOT in the text
# we draw (input is cleaned to ASCII) — they are artifacts of how PyMuPDF/the reused font build the
# ToUnicode CMap, and only corrupt the *text layer* (copy/extract), not the rendering.
_TOUNI_FIX = {b'00a0': b'0020', b'00ad': b'002d'}
_BFCHAR_BLOCK = re.compile(rb'beginbfchar(.*?)endbfchar', re.S)
_BFCHAR_PAIR = re.compile(rb'(<[0-9a-fA-F]{4,}>)\s*<([0-9a-fA-F]{4})>')


def _clean_tounicode(doc):
    """PyMuPDF's insert_text writes inter-word spaces into the ToUnicode CMap as U+00A0 (nbsp), and a
    reused LaTeX/Computer-Modern font maps its hyphen glyph to U+00AD (soft hyphen). Both render fine
    but make an edited line's TEXT LAYER copy/extract as 'unreadable unicode'. Rewrite those bfchar
    destinations back to plain space / hyphen so selected text is clean ASCII. Only touches bfchar
    destinations (the 2nd code of each pair); bfrange and source codes are left untouched."""
    def fix_block(bm):
        def fix_pair(pm):
            dst = pm.group(2).lower()
            return pm.group(1) + b' <' + _TOUNI_FIX[dst] + b'>' if dst in _TOUNI_FIX else pm.group(0)
        return b'beginbfchar' + _BFCHAR_PAIR.sub(fix_pair, bm.group(1)) + b'endbfchar'
    for x in range(1, doc.xref_length()):
        if not doc.xref_is_stream(x):
            continue
        try:
            s = doc.xref_stream(x)
        except Exception:
            continue
        if not s or b'beginbfchar' not in s:
            continue
        ns = _BFCHAR_BLOCK.sub(fix_block, s)
        if ns != s:
            try:
                doc.update_stream(x, ns)
            except Exception:
                pass


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
            lk = r.get('link')
            if isinstance(lk, dict):
                lk = lk.get('uri')
            lk = lk if isinstance(lk, str) and lk.strip() else None
            parts.append((t, max(4.0, min(400.0, sz)), b, it, ul, col, lk))
        out.append(parts)
    return out if any(parts for parts in out) else None


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


def _link_rect_for_edit(edit, size, text_lines, font):
    """Clickable-area rect (PDF points, top-origin) for an edit carrying a hyperlink. An existing-text
    edit uses the line's own bbox; added text is measured from the drawn block (x/baseline + text
    width/height). Used to place a LINK_URI annotation over the final text position."""
    x = float(edit.get('x', 0))
    if edit.get('redact', True):                      # existing line -> its captured bbox
        top = float(edit.get('top', 0)); right = float(edit.get('right', x)); bottom = float(edit.get('bottom', top))
        return fitz.Rect(max(0, x - 1), max(0, top - 1), max(right, x + 4) + 1, bottom + 1)
    baseline = float(edit.get('baseline', 0))         # added text -> measure the drawn text block
    lines = [ln for ln in (text_lines or []) if ln.strip()]
    try:
        w = max((font.text_length(ln, fontsize=size) for ln in lines), default=size)
    except Exception:
        w = max((0.5 * size * len(ln) for ln in lines), default=size)
    line_h = size * 1.2
    top = baseline - size * 0.8
    bottom = baseline + (max(1, len(lines)) - 1) * line_h + size * 0.3
    return fitz.Rect(x, top, x + max(w, 4), bottom)


def _open_authenticated(pdf_bytes, password=""):
    """Open a PDF and authenticate it if it is encrypted.

    Tries the empty password first (covers permission-only / empty-user-password files that
    are common in the wild), then the supplied password. Returns (doc, ok); when ok is False
    the document needs a real password the caller didn't provide and must not be used.
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    if doc.needs_pass:
        if not doc.authenticate("") and not (password and doc.authenticate(password)):
            return doc, False
    return doc, True


def _page_limit_response(doc):
    """A JSON 413 response if the document has more pages than we allow, else None.

    Bounds PyMuPDF's working memory on the 512 MB Render free tier: a pathological
    tiny-page / huge-count PDF can slip under the byte-size cap yet still blow up RAM
    once every page is processed. Callers return this and close the doc when it fires."""
    n = doc.page_count
    if n > MAX_PDF_PAGES:
        return jsonify({"error": f"Too many pages ({n}). Maximum is {MAX_PDF_PAGES} pages."}), 413
    return None


# A PDF must carry the %PDF- signature near the start. The spec / Acrobat tolerate up to ~1 KB of
# leading junk (and so does PyMuPDF), so we scan the head rather than require it at offset 0.
PDF_MAGIC = b"%PDF-"


def _looks_like_pdf(pdf_bytes):
    return bool(pdf_bytes) and PDF_MAGIC in pdf_bytes[:1024]


def _decode_pdf_or_400(data, field="pdfBase64"):
    """Decode the base64 PDF payload and verify it really is a PDF *before* it reaches the
    MuPDF C parser. Returns (pdf_bytes, None) on success, or (None, (response, 400)) for a
    missing field, undecodable base64, or non-PDF/malformed bytes — a cheap, clean rejection."""
    b64 = data.get(field)
    if not b64:
        return None, (jsonify({"error": "Missing required fields"}), 400)
    try:
        pdf_bytes = base64.b64decode(b64)
    except Exception:
        return None, (jsonify({"error": "Invalid PDF data."}), 400)
    if not _looks_like_pdf(pdf_bytes):
        return None, (jsonify({"error": "This file is not a valid PDF."}), 400)
    return pdf_bytes, None


@app.route('/health', methods=['GET'])
@limiter.exempt
def health():
    """Health check endpoint"""
    return jsonify({"status": "ok", "message": "PDF Editor Backend is running"})


@app.route('/extract-text', methods=['POST'])
@limiter.limit(RATE_HEAVY)
def extract_text():
    """Extract text with positions from a PDF (kept for compatibility; the frontend
    now uses PDF.js for geometry and only relies on the backend for editing/saving).

    Takes the PDF as base64 JSON (`pdfBase64`), the same in-memory path as the other
    endpoints — nothing is spooled to disk, so "never written to disk" holds server-wide."""
    try:
        data = request.get_json(silent=True) or {}
        pdf_bytes, err = _decode_pdf_or_400(data)
        if err:
            return err

        doc, ok = _open_authenticated(pdf_bytes, data.get('password', ''))
        if not ok:
            doc.close()
            return jsonify({"success": False, "needsPassword": True,
                            "error": "This PDF needs a password."}), 200

        over = _page_limit_response(doc)
        if over:
            doc.close()
            return over

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
        data = request.get_json(silent=True) or {}
        if 'edits' not in data:
            return jsonify({"error": "Missing required fields"}), 400
        pdf_bytes, err = _decode_pdf_or_400(data)
        if err:
            return err

        # Authenticate if encrypted. The frontend normally sends an already-decrypted working
        # copy (see /decrypt at open time), but accept a password here too for robustness and
        # so empty-password ("permission-only") files edit cleanly.
        doc, ok = _open_authenticated(pdf_bytes, data.get('password', ''))
        if not ok:
            doc.close()
            return jsonify({"success": False, "needsPassword": True,
                            "error": "This PDF needs a password."}), 200

        over = _page_limit_response(doc)
        if over:
            doc.close()
            return over

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
                # Whether this line's original font is an unreusable embedded face (Type1/LaTeX) that
                # may use the Foradian rupee convention — captured now, before redaction removes the
                # spans, so the grave-accent→₹ remap below knows to apply.
                edit['_graveRupee'] = _span_uses_unreusable_embedded(page, edit['_span'])
                # The line's uniform weight/slant (authoritative PyMuPDF flags) recovers a bold/italic
                # the frontend's name-based guess missed; mixed lines stay on the frontend's flag.
                x = float(edit.get('x', 0))
                edit['_lineStyle'] = _line_uniform_style(page, (
                    x, float(edit.get('top', 0)),
                    float(edit.get('right', x)), float(edit.get('bottom', 0))))
                # Detected alignment, so a different-length replacement keeps a right-aligned date
                # column or a centred title aligned (re-anchored on re-insert), not left-shifted.
                # Pass the line's real box so a full-width (justified) line is recognised and stays
                # left instead of being re-anchored right.
                edit['_align'] = _detect_align(page, edit['_span'], x, float(edit.get('right', x)))

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

            # 1b) An UNDERLINED replaced line is re-drawn with a fresh underline at the new text width;
            #     keeping line art (above) means the ORIGINAL underline survives too, so cover its
            #     sub-baseline strip with the line's own background before re-inserting. The new text +
            #     underline are painted on top next, so only one underline (the right width) remains.
            for edit in page_edits:
                if not edit.get('redact', True) or edit.get('kind') in ('image', 'erase'):
                    continue
                has_ul = bool(edit.get('underline')) or any(
                    isinstance(r, dict) and r.get('underline')
                    for ln in (edit.get('runs') or []) for r in (ln or []))
                if not has_ul:
                    continue
                ex = float(edit.get('x', 0)); er = float(edit.get('right', ex))
                eb = float(edit.get('baseline', 0)); ebot = float(edit.get('bottom', eb))
                fs = float(edit.get('fontSize', 12) or 12)
                strip = fitz.Rect(max(0, ex - 1), eb + fs * 0.02,
                                  min(pw, er + 1), min(ph, max(ebot, eb + fs * 0.30) + 1))
                if strip.is_empty or strip.is_infinite:
                    continue
                bgc = edit.get('bgColor')
                bg = tuple(max(0.0, min(1.0, c / 255.0)) for c in bgc[:3]) if isinstance(bgc, (list, tuple)) and len(bgc) >= 3 else (1, 1, 1)
                page.draw_rect(strip, fill=bg, color=None)

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
                # Foradian rupee convention: some Indian-bill fonts (e.g. these custom Type1 'Helvetica*'
                # faces) place the ₹ glyph at the grave-accent slot (U+0060), so the rupee extracts/edits
                # as a backtick. When we redraw such a REPLACE line with the bundled fallback (which draws
                # a literal backtick), map the grave accent to the real ₹ so the symbol survives. Scoped
                # to those fonts only — never touches added text (`is_insert`) or normal-font edits.
                if not is_insert and '`' in raw and edit.get('_graveRupee'):
                    raw = raw.replace('`', '₹')
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
                    # Use the per-run (segmented) drawing for added text AND for a REPLACE edit that
                    # carries runs (e.g. a partial hyperlink on an existing line — only the linked
                    # span is blue/underlined). Plain replace edits (no runs) take the simple path.
                    seg_lines = _runs_to_segments(
                        edit.get('runs'), size, bool(edit.get('bold')), bool(edit.get('italic'))
                    ) if edit.get('runs') else None
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
                                       for st, ssz, sb, si, _, _, _ in parts if st)
                        widths = [line_width(parts) for parts in seg_lines]
                        maxw = max(widths, default=0.0)

                        # Alignment: an ADDED box aligns within its own widest line; a REPLACE line
                        # re-anchors within the original line's box (x .. right), so a right-/centre-
                        # aligned existing line keeps its position when re-drawn as runs.
                        seg_align = box_align or (None if is_insert else edit.get('_align', 'left'))
                        avail_w = maxw if is_insert else (float(edit.get('right', x)) - x)
                        run_link_spans = []          # per-run hyperlink areas (rect, uri) -> annotations
                        y = baseline
                        prev_max = None
                        for idx, parts in enumerate(seg_lines):
                            this_max = max([sz for _, sz, _, _, _, _, _ in parts], default=size)
                            # Advance to this line using the LARGER of the two adjacent lines, so a
                            # big line after a small one (or vice-versa) never overlaps.
                            if prev_max is not None:
                                y += max(prev_max, this_max) * 1.2
                            off = (avail_w - widths[idx]) if seg_align == 'right' else \
                                  (avail_w - widths[idx]) / 2 if seg_align == 'center' else 0.0
                            cx = x + max(0.0, off)
                            cur_link = None          # [uri, x0, x1] — merge contiguous same-uri runs
                            ytop, ybot = y - this_max * 0.8, y + this_max * 0.3
                            for seg_text, seg_size, seg_bold, seg_italic, seg_ul, seg_col, seg_link in parts:
                                if not seg_text:
                                    continue
                                seg_x0 = cx
                                cx += _insert_text_runs(page, cx, y, seg_text, seg_size,
                                                        opts_for(seg_bold, seg_italic),
                                                        pw - cx - 4, morph,
                                                        color=(seg_col or box_color or text_color),
                                                        opacity=box_opacity,
                                                        underline=(seg_ul or box_underline))
                                if seg_link:
                                    if cur_link and cur_link[0] == seg_link:
                                        cur_link[2] = cx
                                    else:
                                        if cur_link:
                                            run_link_spans.append((fitz.Rect(cur_link[1], ytop, cur_link[2], ybot), cur_link[0]))
                                        cur_link = [seg_link, seg_x0, cx]
                                elif cur_link:
                                    run_link_spans.append((fitz.Rect(cur_link[1], ytop, cur_link[2], ybot), cur_link[0]))
                                    cur_link = None
                            if cur_link:
                                run_link_spans.append((fitz.Rect(cur_link[1], ytop, cur_link[2], ybot), cur_link[0]))
                            prev_max = this_max
                        if run_link_spans:
                            edit['_run_link_spans'] = run_link_spans
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
                    # Hyperlink: remember the clickable area over this text so it's applied once all
                    # text/redaction is done (computed here while size/font are in hand).
                    if edit.get('link') or edit.get('linkRemoved'):
                        try:
                            edit['_link_rect'] = _link_rect_for_edit(edit, size, text_lines, options[0][1])
                        except Exception:
                            edit['_link_rect'] = None
                # Note: never log the document's text content (keeps the app traceless).
                print(f"  page {page_num}: [{style}] text written at ({x:.1f}, {baseline:.1f})")

            # 3) Hyperlinks the user added / edited / removed. A link edit places a LINK_URI annotation
            #    over the final text area; a removed link is deleted. Every managed area is remembered so
            #    the saved-link re-add below never brings the old link back (no duplicate / no resurrection).
            managed_link_rects = []
            for edit in page_edits:
                # 3a) Per-run links (a hyperlink applied to PART of an added-text box).
                for r, uri in (edit.get('_run_link_spans') or []):
                    managed_link_rects.append(r)
                    try:
                        page.insert_link({"kind": fitz.LINK_URI, "from": r, "uri": uri})
                    except Exception:
                        pass
                # 3b) Whole-object link (or removal).
                r = edit.get('_link_rect')
                if r is None:
                    continue
                managed_link_rects.append(r)
                link = edit.get('link') if isinstance(edit.get('link'), dict) else None
                uri = (link or {}).get('uri')
                try:
                    for l in page.get_links():        # drop any stale link over this area first
                        if l.get('uri') and fitz.Rect(l['from']).intersects(r):
                            page.delete_link(l)
                except Exception:
                    pass
                if uri and not edit.get('linkRemoved'):
                    try:
                        page.insert_link({"kind": fitz.LINK_URI, "from": r, "uri": uri})
                    except Exception:
                        pass

            # Re-add hyperlinks the redaction dropped (so an edited footer/contact line stays
            # clickable). Only restore links that OVERLAP a redacted rect — those are the ones
            # apply_redactions removed; others survived. Skip any area the user explicitly managed
            # above. Avoids get_links() here (it can raise right after redaction) and dup links.
            for l in saved_links:
                r = fitz.Rect(l['from'])
                if any(r.intersects(rr) for rr in redact_rects) and not any(r.intersects(rm) for rm in managed_link_rects):
                    try:
                        page.insert_link({"kind": fitz.LINK_URI, "from": r, "uri": l['uri']})
                    except Exception:
                        pass

        _clean_tounicode(doc)   # repair nbsp/soft-hyphen in the edited lines' text layer (copy/extract)

        # ── Fabric annotation descriptors (highlights, shapes, etc.) ───────────────
        # These are separate from text edits: they come in as `annotations` and are
        # burned in using PyMuPDF's native drawing / annotation APIs so PDF viewers
        # render them correctly, in particular with real transparency.
        annotations = data.get('annotations', [])
        for ann in annotations:
            try:
                kind = ann.get('kind', '')
                page_num = int(ann.get('pageIndex', 0))
                if page_num < 0 or page_num >= len(doc):
                    continue
                page = doc[page_num]
                ph = page.rect.height
                pw = page.rect.width

                def _hex_to_rgb(h):
                    """'#rrggbb' → (r, g, b) floats 0..1, or None."""
                    if not h or not isinstance(h, str):
                        return None
                    s = h.strip().lstrip('#')
                    if len(s) == 6:
                        try:
                            return (int(s[0:2], 16) / 255.0,
                                    int(s[2:4], 16) / 255.0,
                                    int(s[4:6], 16) / 255.0)
                        except ValueError:
                            return None
                    return None

                def _rgba_to_rgb(c):
                    """'rgba(r,g,b,a)' or '#rrggbb' → (r,g,b) floats 0..1, or None."""
                    if not c or not isinstance(c, str):
                        return None
                    import re as _re
                    m = _re.match(r'rgba?\((\d+),\s*(\d+),\s*(\d+)', c)
                    if m:
                        return (int(m.group(1)) / 255.0,
                                int(m.group(2)) / 255.0,
                                int(m.group(3)) / 255.0)
                    return _hex_to_rgb(c)

                if kind == 'ann-highlight':
                    # Use PyMuPDF's NATIVE highlight annotation so every PDF viewer
                    # renders it as translucent ink (never as an opaque rectangle).
                    # Coordinates from the serialiser are PDF points, bottom-left origin.
                    x = float(ann.get('x', 0))
                    y = float(ann.get('y', 0))         # bottom-left of rect (PDF space)
                    w = float(ann.get('width', 0))
                    h = float(ann.get('height', 0))
                    opacity = float(ann.get('opacity', 0.4))
                    fill_color = _rgba_to_rgb(ann.get('fill')) or (1.0, 0.84, 0.0)  # #FFD600

                    # fitz.Rect uses top-left origin; the serialiser sends bottom-left
                    # (y = ph - top - height, so top = ph - y - h).
                    # Convert back to PyMuPDF rect: (x0, y0, x1, y1) in page top-left space.
                    rect = fitz.Rect(x, ph - y - h, x + w, ph - y)
                    try:
                        # add_highlight_annot prefers an explicit fitz.Quad so the quad
                        # array in the annotation /QuadPoints entry is correct in all
                        # PyMuPDF versions (passing a bare Rect can produce a 1-point
                        # default quad in older builds, giving an invisible annotation).
                        quad = rect.quad
                        hl = page.add_highlight_annot(quad)
                        # PDF highlight annotations use "stroke" as the ink colour key.
                        # We also set "fill" so viewers that use either field render it.
                        hl.set_colors(stroke=fill_color, fill=fill_color)
                        hl.set_opacity(opacity)
                        hl.update()
                    except Exception:
                        # Fallback: draw a semi-transparent filled rect if
                        # add_highlight_annot fails (e.g. very old PyMuPDF).
                        page.draw_rect(rect, color=None, fill=fill_color,
                                       fill_opacity=opacity)

                elif kind == 'ann-rect':
                    x = float(ann.get('x', 0))
                    y = float(ann.get('y', 0))
                    w = float(ann.get('width', 0))
                    h = float(ann.get('height', 0))
                    rect = fitz.Rect(x, ph - y - h, x + w, ph - y)
                    stroke = _rgba_to_rgb(ann.get('stroke')) or (0, 0, 0)
                    sw = float(ann.get('strokeWidth', 1))
                    page.draw_rect(rect, color=stroke, fill=None, width=sw)

                elif kind == 'ann-ellipse':
                    cx = float(ann.get('x', 0))
                    cy = float(ann.get('y', 0))
                    rx = float(ann.get('rx', 0))
                    ry = float(ann.get('ry', 0))
                    # PyMuPDF cy is top-origin
                    pdf_cy = ph - cy
                    rect = fitz.Rect(cx - rx, pdf_cy - ry, cx + rx, pdf_cy + ry)
                    stroke = _rgba_to_rgb(ann.get('stroke')) or (0, 0, 0)
                    sw = float(ann.get('strokeWidth', 1))
                    page.draw_oval(rect, color=stroke, fill=None, width=sw)

                elif kind == 'ann-line':
                    x1 = float(ann.get('x1', 0))
                    y1 = float(ann.get('y1', 0))
                    x2 = float(ann.get('x2', 0))
                    y2 = float(ann.get('y2', 0))
                    stroke = _rgba_to_rgb(ann.get('stroke')) or (0, 0, 0)
                    sw = float(ann.get('strokeWidth', 1))
                    page.draw_line(fitz.Point(x1, ph - y1), fitz.Point(x2, ph - y2),
                                   color=stroke, width=sw)

                elif kind == 'ann-path':
                    # Freehand (highlighter) stroke: a polyline of PDF-point vertices (bottom-left
                    # origin). Draw with round caps/joins; a highlight stroke is translucent.
                    pts = ann.get('points') or []
                    poly = [fitz.Point(float(p[0]), ph - float(p[1])) for p in pts
                            if isinstance(p, (list, tuple)) and len(p) >= 2]
                    if len(poly) >= 2:
                        stroke = _rgba_to_rgb(ann.get('stroke')) or (1.0, 0.84, 0.0)
                        sw = max(0.5, float(ann.get('strokeWidth', 2)))
                        op = _clamp_opacity(ann.get('opacity')) if ann.get('isHighlight') else 1.0
                        sh = page.new_shape()
                        sh.draw_polyline(poly)
                        sh.finish(color=stroke, width=sw, stroke_opacity=op,
                                  lineCap=1, lineJoin=1, closePath=False)
                        sh.commit()

                elif kind == 'ann-table':
                    # Grid: rows+1 horizontal + cols+1 vertical lines over the table box.
                    x = float(ann.get('x', 0))
                    y = float(ann.get('y', 0))          # bottom-left corner (PDF space)
                    w = float(ann.get('width', 0))
                    h = float(ann.get('height', 0))
                    rows = max(1, int(ann.get('rows', 3)))
                    cols = max(1, int(ann.get('cols', 3)))
                    stroke = _rgba_to_rgb(ann.get('stroke')) or (0.18, 0.23, 0.36)
                    sw = float(ann.get('strokeWidth', 1)) or 1.0
                    top = ph - y - h                    # top edge (PyMuPDF top-origin)
                    sh = page.new_shape()
                    for r in range(rows + 1):
                        yy = top + h * r / rows
                        sh.draw_line(fitz.Point(x, yy), fitz.Point(x + w, yy))
                    for c in range(cols + 1):
                        xx = x + w * c / cols
                        sh.draw_line(fitz.Point(xx, top), fitz.Point(xx, top + h))
                    sh.finish(color=stroke, width=sw)
                    sh.commit()

            except Exception as _ann_err:
                print(f"  annotation draw error ({ann.get('kind','')}): {_ann_err}")

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
        data = request.get_json(silent=True) or {}
        pdf_bytes, err = _decode_pdf_or_400(data)
        if err:
            return err

        doc, ok = _open_authenticated(pdf_bytes, data.get('password', ''))
        if not ok:
            doc.close()
            return jsonify({"success": False, "needsPassword": True,
                            "error": "This PDF needs a password."}), 200

        over = _page_limit_response(doc)
        if over:
            doc.close()
            return over

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
    A user-supplied `password` unlocks files that need a real password (used by the editor's
    "open a password-protected PDF" flow); the saved/working copy returned is unlocked.
    Nothing is stored — the file is decrypted in memory and the bytes are returned."""
    try:
        data = request.get_json(silent=True) or {}
        if 'pdfBase64' not in data:
            return jsonify({"success": False, "error": "Missing required fields"}), 400

        try:
            pdf_bytes = base64.b64decode(data['pdfBase64'])
        except Exception:
            return jsonify({"success": False, "error": "Invalid PDF data."}), 400
        if not _looks_like_pdf(pdf_bytes):
            return jsonify({"success": False, "error": "This file is not a valid PDF."}), 400

        password = data.get('password') or ''
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        except Exception:
            return jsonify({"success": False, "error": "Could not read PDF"}), 400

        # Try the empty password first (permission-only files), then the user-supplied one.
        if doc.needs_pass and not doc.authenticate(""):
            if password and doc.authenticate(password):
                pass  # unlocked with the user's password
            else:
                doc.close()
                # Distinguish "needs a password" from "that password was wrong" so the UI can
                # show the right message and re-prompt.
                if password:
                    return jsonify({"success": False, "wrongPassword": True,
                                    "error": "Incorrect password."}), 200
                return jsonify({"success": False, "needsPassword": True,
                                "error": "This PDF needs a password to open."}), 200

        over = _page_limit_response(doc)
        if over:
            doc.close()
            return over

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
