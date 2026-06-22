"""Font engine: family/weight/style resolution for re-inserting edited text.

The bulk of the backend — chooses a bundled Unicode TTF (or a reused embedded font /
Base-14 fallback) per line to match the original as closely as possible, including a
LaTeX (Computer Modern / Latin Modern) fallback profile. Moved verbatim from app.py;
behavior is unchanged.
"""
import os
import re
import fitz  # PyMuPDF

from pdf.spans import _SERIF_NAME_HINTS, _SANS_NAME_HINTS


# Real Unicode TrueType fonts for re-inserting edited text. We choose the family
# (serif vs sans) and weight/style (bold/italic) per line to match the original as closely
# as possible. The BUNDLED open fonts (Arimo/Tinos, OFL/Apache) are tried first so the result is
# license-safe and identical on every host (incl. Linux/Render); local system fonts and Base-14 are
# only later fallbacks. Using TTFs keeps bullets (•), em-dashes (—), curly quotes, etc. intact.
# backend/fonts — anchored to the package parent (backend/) so it is unaffected by this module
# now living in backend/pdf/ rather than backend/ (the fonts directory itself did not move).
_FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'fonts')


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
