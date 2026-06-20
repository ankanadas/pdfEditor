"""
Regression tests for the /edit-pdf text-replacement behaviour.

These guard the fixes made to high-fidelity editing:
  - a typed character absent from the document still renders — it falls back to a font
    that can draw it (synthetic stand-in for the old VOE "typed 'J' disappears" bug);
  - replaced text is truly removed (ATS-clean);
  - edited text reuses the document's OWN fonts (e.g. Calibri), not a generic one;
  - the matched span's weight (e.g. a bold bullet/header) does NOT force the whole
    edited line bold — the line's own flag wins;
  - a coloured/shaded background survives a text replace (fill=False);
  - stray characters a contentEditable can introduce (nbsp/zero-width) are cleaned;
  - "Add text" with mixed per-run font size / bold / italic saves each run correctly.

Some tests use a real résumé PDF that contains personal data and is therefore NOT
committed (see backend/tests/fixtures/README.md). Those tests SKIP automatically when
the fixture is absent; the synthetic tests always run.
"""

import base64
import os
import sys
import unittest

import fitz  # PyMuPDF

# Make backend/app.py importable regardless of how the runner is invoked.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app as appmod  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
RESUME = os.path.join(FIXTURES, "resume.pdf")
# A LaTeX/Computer-Modern résumé (subset Type1 CM fonts that have NO space glyph). Personal data,
# so gitignored and absent in CI — the test below skips when missing.
RESUME_LATEX = os.path.join(FIXTURES, "resume_latex.pdf")


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def post_edit(pdf_bytes, edits):
    """Run edits through the Flask app in-process and return the edited PDF bytes."""
    client = appmod.app.test_client()
    resp = client.post("/edit-pdf", json={
        "pdfBase64": base64.b64encode(pdf_bytes).decode(),
        "edits": edits,
    })
    data = resp.get_json()
    assert resp.status_code == 200 and data and data.get("success"), \
        f"/edit-pdf failed: status={resp.status_code} body={data}"
    return base64.b64decode(data["pdfBase64"])


def find_span(doc, substring, page=0):
    """First text span on `page` whose text contains `substring` (None if not found)."""
    for block in doc[page].get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if substring in span.get("text", ""):
                    return span
    return None


def spans_with(doc, substring, page=0):
    """All spans on `page` whose (nbsp-normalised) text contains `substring`."""
    out = []
    for block in doc[page].get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if substring in span.get("text", "").replace("\u00a0", " "):
                    out.append(span)
    return out


def page_text(doc, page=0):
    return doc[page].get_text().replace("\u00a0", " ")


def edit_from_span(span, new_text, **overrides):
    """Build an /edit-pdf edit dict that replaces `span` with `new_text`."""
    ox, oy = span["origin"]
    x0, y0, x1, y1 = span["bbox"]
    edit = {
        "pageIndex": 0,
        "x": round(ox, 1), "right": round(x1, 1),
        "top": round(y0, 1), "bottom": round(y1, 1),
        "baseline": round(oy, 1),
        "fontSize": round(span["size"], 1),
        "bold": False, "italic": False, "serif": False,
        "newText": new_text,
    }
    edit.update(overrides)
    return edit


def region_ink(page, x_left, y0, y1, width=8.0, scale=4):
    """Count near-black pixels in a small clip — used to confirm a glyph actually painted."""
    clip = fitz.Rect(x_left - 1, y0 - 1, x_left + width, y1 + 1)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=clip)
    return sum(1 for i in range(0, len(pix.samples), pix.n) if pix.samples[i] < 100)


def sample_rgb(page, x, y, scale=2):
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
    i = (int(y * scale) * pix.w + int(x * scale)) * pix.n
    return tuple(pix.samples[i:i + 3])


# --------------------------------------------------------------------------- #
# Real-PDF tests (skip if the gitignored fixture isn't present locally)
# --------------------------------------------------------------------------- #
@unittest.skipUnless(os.path.exists(RESUME), f"missing fixture: {RESUME}")
class ResumeTests(unittest.TestCase):
    """Résumé — Calibri/Calibri-Bold/SymbolMT(bullet); tests font reuse + weight."""

    def test_edit_reuses_document_font(self):
        # Editing text whose characters all exist in the doc keeps the doc's own font (Calibri).
        src = fitz.open(RESUME)
        span = find_span(src, "GPA: 4.0/4.0")
        self.assertIsNotNone(span, "could not find the GPA span")
        new = span["text"].replace("4.0/4.0", "5.0/4.0")
        res = fitz.open(stream=post_edit(src.tobytes(), [edit_from_span(span, new)]), filetype="pdf")
        self.assertIn("5.0/4.0", page_text(res))
        self.assertNotIn("4.0/4.0", page_text(res), "old GPA not removed")
        got = spans_with(res, "5.0/4.0")
        self.assertTrue(got, "edited GPA span not found in output")
        self.assertEqual(got[0]["font"], "Calibri",
                         f"expected the document font 'Calibri', got {got[0]['font']!r}")

    def test_mixed_weight_line_not_forced_bold(self):
        # A line that MIXES bold (title/company) and regular (punctuation/location). Editing the
        # whole line with bold=False must NOT force the regular text bold just because the line
        # starts with a bold span — only a UNIFORMLY bold line recovers bold (see the synthetic test).
        src = fitz.open(RESUME)
        line = next((l for pno in range(len(src))
                     for b in src[pno].get_text("dict")["blocks"]
                     for l in b.get("lines", [])
                     if "Software Engineer" in "".join(s["text"] for s in l["spans"])), None)
        self.assertIsNotNone(line, "could not find the 'Software Engineer' line")
        fonts = [s["font"] for s in line["spans"]]
        self.assertTrue(any("Bold" in f for f in fonts) and any("Bold" not in f for f in fonts),
                        f"precondition: line should mix bold + regular spans, got {fonts}")
        x0, y0, x1, y1 = line["bbox"]
        oy = line["spans"][0]["origin"][1]
        edit = {"pageIndex": 0, "x": round(x0, 1), "right": round(x1, 1),
                "top": round(y0, 1), "bottom": round(y1, 1), "baseline": round(oy, 1),
                "fontSize": round(line["spans"][0]["size"], 1),
                "bold": False, "italic": False, "serif": False,
                "newText": "engineering team lead role"}
        res = fitz.open(stream=post_edit(src.tobytes(), [edit]), filetype="pdf")
        got = spans_with(res, "engineer")
        self.assertTrue(got, "edited text not found in output")
        for s in got:
            self.assertNotIn("Bold", s["font"],
                             f"mixed regular line rendered bold: {s['font']!r}")

    def test_no_characters_dropped(self):
        # Every typed character of a body edit must survive (no silent drops / boxes).
        src = fitz.open(RESUME)
        span = find_span(src, "Integrated AWS")
        self.assertIsNotNone(span, "could not find the Amazon bullet body span")
        new = "Designed and shipped a scalable service"
        res = fitz.open(stream=post_edit(src.tobytes(), [edit_from_span(span, new)]), filetype="pdf")
        self.assertIn(new, page_text(res), "some characters were dropped on re-insert")


@unittest.skipUnless(os.path.exists(RESUME_LATEX), f"missing fixture: {RESUME_LATEX}")
class LatexResumeTests(unittest.TestCase):
    """LaTeX / Computer-Modern résumé (CMR10/CMBX10/CMTI10 …). These subset fonts have NO space
    glyph (LaTeX positions words by kerning, not a space char), so a careless re-insert drew
    .notdef boxes (U+FFFD) for every space — the "full of gibberish chars" bug. Guards that an
    edited CM line stays clean: real spaces, weight kept, digits intact."""

    def _line_edit(self, src_doc, contains, new_text):
        line = next((l for b in src_doc[0].get_text("dict")["blocks"]
                     for l in b.get("lines", [])
                     if contains in "".join(s["text"] for s in l["spans"])), None)
        self.assertIsNotNone(line, f"could not find line {contains!r}")
        sp = line["spans"]
        x0 = min(s["bbox"][0] for s in sp); y0 = min(s["bbox"][1] for s in sp)
        x1 = max(s["bbox"][2] for s in sp); y1 = max(s["bbox"][3] for s in sp)
        s0 = sp[0]
        return {
            "pageIndex": 0, "x": round(x0, 1), "right": round(x1, 1),
            "top": round(y0, 1), "bottom": round(y1, 1), "baseline": round(s0["origin"][1], 1),
            "fontSize": round(s0["size"], 1),
            "bold": bool(s0["flags"] & 16), "italic": bool(s0["flags"] & 2), "serif": bool(s0["flags"] & 4),
            "newText": new_text,
        }, s0["font"]

    def test_edited_cm_line_has_no_missing_glyph_boxes(self):
        src = fitz.open(RESUME_LATEX)
        edit, _ = self._line_edit(src, "J.B. Hunt", "J.B. Hunt, Boston, MA")
        res = fitz.open(stream=post_edit(src.tobytes(), [edit]), filetype="pdf")
        self.assertNotIn("�", res[0].get_text(),
                         "missing-glyph box (U+FFFD) in edited CM line — spaces broke")
        self.assertTrue(res[0].search_for("J.B. Hunt, Boston, MA"),
                        "edited CM text not searchable (spaces mangled)")

    def test_edited_cm_bold_heading_keeps_weight_and_digits(self):
        src = fitz.open(RESUME_LATEX)
        edit, font = self._line_edit(src, "Software Engineer III", "Software Engineer 2024")
        self.assertTrue("CMBX" in font or edit["bold"], f"precondition: bold CM heading, got {font!r}")
        res = fitz.open(stream=post_edit(src.tobytes(), [edit]), filetype="pdf")
        self.assertNotIn("�", res[0].get_text())
        self.assertTrue(res[0].search_for("Software Engineer 2024"),
                        "digits/spaces broke in the bold CM heading")
        head = [s for s in spans_with(res, "Engineer") if abs(s["origin"][1] - edit["baseline"]) < 4]
        self.assertTrue(head, "edited heading not found in output")
        self.assertTrue(any(("CMBX" in s["font"]) or (s["flags"] & 16) or ("Bold" in s["font"]) for s in head),
                        f"bold heading lost its weight: {[s['font'] for s in head]}")


# --------------------------------------------------------------------------- #
# Synthetic tests (always run) for fixes the real PDFs don't exercise
# --------------------------------------------------------------------------- #
class SyntheticTests(unittest.TestCase):

    def test_background_preserved_on_text_replace(self):
        # A shaded cell must keep its colour when its text is replaced (fill=False).
        doc = fitz.open()
        pg = doc.new_page(width=320, height=120)
        pg.draw_rect(fitz.Rect(20, 20, 300, 70), color=(0.2, 0.4, 0.9), fill=(0.2, 0.4, 0.9))
        pg.insert_text(fitz.Point(30, 55), "Company", fontsize=14, color=(1, 1, 1))
        edit = {"pageIndex": 0, "x": 30, "right": 110, "top": 42, "bottom": 59,
                "baseline": 55, "fontSize": 14, "newText": "Org"}
        res = fitz.open(stream=post_edit(doc.tobytes(), [edit]), filetype="pdf")
        r, g, b = sample_rgb(res[0], 90, 50)
        # original blue ~ (51,102,229); allow small antialiasing tolerance
        self.assertTrue(abs(r - 51) < 30 and abs(g - 102) < 30 and abs(b - 229) < 30,
                        f"background not preserved, sampled {(r, g, b)} (expected ~blue)")

    def test_text_colour_preserved_on_replace(self):
        # White text on a dark page must STAY white after a replace — the old code re-inserted
        # every edit in black, which made the white "RYZE AI" headline vanish on its dark page.
        doc = fitz.open()
        pg = doc.new_page(width=320, height=120)
        pg.draw_rect(pg.rect, color=(0.06, 0.05, 0.04), fill=(0.06, 0.05, 0.04))
        pg.insert_text(fitz.Point(30, 60), "RYZE", fontsize=28, color=(1, 1, 1))
        edit = {"pageIndex": 0, "x": 30, "right": 120, "top": 38, "bottom": 64,
                "baseline": 60, "fontSize": 28, "newText": "RYZE2"}
        res = fitz.open(stream=post_edit(doc.tobytes(), [edit]), filetype="pdf")
        span = find_span(res, "RYZE2")
        self.assertIsNotNone(span, "replaced text not found")
        c = span.get("color", 0)
        r, g, b = (c >> 16 & 255, c >> 8 & 255, c & 255)
        self.assertTrue(r > 220 and g > 220 and b > 220,
                        f"text colour not preserved, span colour {(r, g, b)} (expected ~white)")

    def test_uniform_bold_line_recovers_bold(self):
        # A heading drawn in a standard bold font (Helvetica-Bold). The frontend can't see the
        # weight in pdf.js's loadedName, so it sends bold=False — but the whole line is uniformly
        # bold, so the replacement must come back bold (the "RYZE AI -> ArialMT regular" bug).
        doc = fitz.open()
        pg = doc.new_page(width=400, height=160)
        pg.insert_text(fitz.Point(30, 80), "RYZE AI", fontsize=40, fontname="hebo")  # Helvetica-Bold
        src = doc.tobytes()
        span = find_span(fitz.open(stream=src, filetype="pdf"), "RYZE AI")
        self.assertIsNotNone(span, "could not find the bold heading span")
        res = fitz.open(stream=post_edit(src, [edit_from_span(span, "RYZE89 AI", bold=False)]),
                        filetype="pdf")
        got = spans_with(res, "RYZE89")
        self.assertTrue(got, "edited heading not found in output")
        self.assertTrue(any(("Bold" in s["font"]) or (s["flags"] & 16) for s in got),
                        f"uniformly-bold heading came back regular: {[s['font'] for s in got]}")

    def test_standard_font_name_preserved(self):
        # A non-embedded standard font (Helvetica-Bold) must be re-emitted under its OWN name, not
        # substituted with Arial — so the edited heading still reads 'Helvetica-Bold' in the output.
        doc = fitz.open()
        pg = doc.new_page(width=400, height=160)
        pg.insert_text(fitz.Point(30, 80), "RYZE AI", fontsize=40, fontname="hebo")  # Helvetica-Bold
        src = doc.tobytes()
        span = find_span(fitz.open(stream=src, filetype="pdf"), "RYZE AI")
        res = fitz.open(stream=post_edit(src, [edit_from_span(span, "RYZE89 AI", bold=False)]),
                        filetype="pdf")
        got = spans_with(res, "RYZE89")
        self.assertTrue(got, "edited heading not found in output")
        self.assertTrue(all("Helvetica" in s["font"] for s in got),
                        f"standard font not preserved, got {[s['font'] for s in got]}")

    def test_non_winansi_char_falls_back_from_base14(self):
        # The standard-font re-emit only covers Latin-1. A character outside it (an em-dash) must
        # still render — it falls through to a real Unicode TTF — while the Latin text keeps the
        # standard font name.
        doc = fitz.open()
        pg = doc.new_page(width=400, height=160)
        pg.insert_text(fitz.Point(30, 80), "Title here", fontsize=24, fontname="helv")  # Helvetica
        src = doc.tobytes()
        span = find_span(fitz.open(stream=src, filetype="pdf"), "Title here")
        res = fitz.open(stream=post_edit(src, [edit_from_span(span, "Title — End")]), filetype="pdf")
        self.assertIn("—", page_text(res), "em-dash dropped instead of falling back to a TTF")
        latin = [s for s in spans_with(res, "Title")]
        self.assertTrue(latin and all("Helvetica" in s["font"] for s in latin),
                        f"Latin text lost the standard font, got {[s['font'] for s in latin]}")

    def test_edit_keeps_line_in_one_font(self):
        # A word whose font drew it ONLY on this line must not scatter across other embedded fonts
        # when edited. Reproduces the "SUMMARY -> CMCSC10/CMR10/CMBX12/CMTI10" scatter: charsets are
        # warmed from the ORIGINAL doc (before redaction) so the line keeps its own font.
        f1 = "/System/Library/Fonts/Supplemental/Times New Roman.ttf"
        f2 = "/System/Library/Fonts/Supplemental/Georgia.ttf"
        if not (os.path.exists(f1) and os.path.exists(f2)):
            self.skipTest("needs two distinct embeddable system fonts")
        doc = fitz.open()
        pg = doc.new_page(width=400, height=200)
        pg.insert_text((40, 60), "WIDGET", fontsize=16, fontfile=f1, fontname="F1")   # unique here
        pg.insert_text((40, 120), "WIDGET", fontsize=16, fontfile=f2, fontname="F2")  # same chars, other font
        src = doc.tobytes()
        sdoc = fitz.open(stream=src, filetype="pdf")
        span = next(s for b in sdoc[0].get_text("dict")["blocks"] for l in b.get("lines", [])
                    for s in l["spans"] if "WIDGET" in s["text"] and abs(s["origin"][1] - 60) < 3)
        res = fitz.open(stream=post_edit(src, [edit_from_span(span, "WIDGET")]), filetype="pdf")
        line = [s for b in res[0].get_text("dict")["blocks"] for l in b.get("lines", [])
                for s in l["spans"] if "WIDGET" in s["text"] and abs(s["origin"][1] - 60) < 4]
        fonts = {s["font"] for s in line}
        self.assertEqual(len(fonts), 1, f"edited line scattered across fonts: {fonts}")

    def test_edit_keeps_hyperlink(self):
        # Editing a line that carries a hyperlink must NOT drop the link (redaction removes it; the
        # backend re-adds it). Footer/contact links stay clickable.
        doc = fitz.open()
        pg = doc.new_page(width=400, height=200)
        pg.insert_text((40, 60), "Visit our site", fontsize=12)
        pg.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(40, 50, 150, 63),
                        "uri": "https://example.com/"})
        src = doc.tobytes()
        span = find_span(fitz.open(stream=src, filetype="pdf"), "Visit our site")
        res = fitz.open(stream=post_edit(src, [edit_from_span(span, "Visit our website")]), filetype="pdf")
        uris = [l["uri"] for l in res[0].get_links() if l.get("uri")]
        self.assertIn("https://example.com/", uris, "hyperlink dropped when the line was edited")

    def test_right_aligned_edit_keeps_right_edge(self):
        # A right-aligned column (rows ending at the same x, starting at varying x): editing one row
        # with shorter text must keep its RIGHT edge aligned, not left-shift it.
        doc = fitz.open()
        pg = doc.new_page(width=400, height=300)
        f = fitz.Font("helv")
        right = 360.0
        rows = [("January 2020 - March 2021", 60), ("May 2019", 95), ("Feb 2018 - Dec 2018", 130)]
        for text, y in rows:
            pg.insert_text((right - f.text_length(text, 11), y), text, fontsize=11)
        src = doc.tobytes()
        sdoc = fitz.open(stream=src, filetype="pdf")
        span = next(s for b in sdoc[0].get_text("dict")["blocks"]
                    for l in b.get("lines", []) for s in l["spans"] if "May 2019" in s["text"])
        res = fitz.open(stream=post_edit(src, [edit_from_span(span, "Q4")]), filetype="pdf")
        s = next(x for b in res[0].get_text("dict")["blocks"] for l in b.get("lines", [])
                 for x in l["spans"] if "Q4" in x["text"] and abs(x["origin"][1] - 95) < 4)
        self.assertAlmostEqual(s["bbox"][2], right, delta=4,
                               msg=f"right-aligned edit lost its right edge: {s['bbox'][2]:.1f} != {right}")

    def test_typed_digit_in_bold_line_stays_bold(self):
        # Typing a digit the bold line's own (subset) font never had must stay BOLD via the
        # weight-matched fallback, not borrow a regular document font that happens to have the digit.
        fb = "/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf"
        fr = "/System/Library/Fonts/Supplemental/Times New Roman.ttf"
        if not (os.path.exists(fb) and os.path.exists(fr)):
            self.skipTest("needs Times New Roman + bold system fonts")
        doc = fitz.open()
        pg = doc.new_page(width=400, height=200)
        pg.insert_text((40, 60), "ABC", fontsize=20, fontfile=fb, fontname="FB")   # bold line, no digits
        pg.insert_text((40, 120), "5", fontsize=20, fontfile=fr, fontname="FR")    # '5' only in a REGULAR font
        src = doc.tobytes()
        sdoc = fitz.open(stream=src, filetype="pdf")
        span = next(s for b in sdoc[0].get_text("dict")["blocks"]
                    for l in b.get("lines", []) for s in l["spans"]
                    if "ABC" in s["text"] and abs(s["origin"][1] - 60) < 3)
        res = fitz.open(stream=post_edit(src, [edit_from_span(span, "ABC5", bold=True)]), filetype="pdf")
        s5 = next(x for b in res[0].get_text("dict")["blocks"] for l in b.get("lines", [])
                  for x in l["spans"] if "5" in x["text"] and abs(x["origin"][1] - 60) < 4)
        self.assertTrue((s5["flags"] & 16) or "Bold" in s5["font"],
                        f"typed digit fell to a regular font: {s5['font']}")

    def test_space_drawn_with_a_space_capable_font(self):
        # A space must NEVER be assigned to a font that lacks a space glyph. LaTeX/Computer Modern
        # subset fonts have none — PyMuPDF synthesizes inter-word spaces from glyph gaps, so the
        # drawn-charset wrongly credits the font with ' '; drawing one then yields a .notdef box that
        # renders as U+FFFD ("Software<box>Engineer"). _pick_font must skip such a font for ' '.
        class _StubFont:
            def __init__(self, space):
                self._space = space

            def has_glyph(self, cp):
                return 1 if (cp != 0x20 or self._space) else 0

        cm = _StubFont(space=False)          # like CMR10/CMBX10/CMTI10: NO space glyph
        fallback = _StubFont(space=True)     # the Arial/Times catch-all: always has a space
        options = [
            (dict(fontname="cm"), cm, set("Software "), True),   # charset wrongly includes ' '
            (dict(fontname="fallback"), fallback, None, True),
        ]
        kwargs, font = appmod._pick_font(" ", options)
        self.assertIs(font, fallback, "space went to a font with no space glyph (renders as a box)")
        self.assertEqual(kwargs.get("fontname"), "fallback")

    def test_space_keeps_primary_font_when_it_has_a_space(self):
        # Normal documents must NOT fragment: when the primary font has a real space glyph the space
        # is drawn with it (no needless switch to the fallback).
        class _StubFont:
            def __init__(self, space):
                self._space = space

            def has_glyph(self, cp):
                return 1 if (cp != 0x20 or self._space) else 0

        primary = _StubFont(space=True)
        options = [
            (dict(fontname="calibri"), primary, set("Hi "), True),
            (dict(fontname="fallback"), _StubFont(space=True), None, True),
        ]
        kwargs, font = appmod._pick_font(" ", options)
        self.assertIs(font, primary)
        self.assertEqual(kwargs.get("fontname"), "calibri")

    def test_erase_still_whitens(self):
        # The erase tool (kind='erase') must still paint white.
        doc = fitz.open()
        pg = doc.new_page(width=320, height=120)
        pg.draw_rect(fitz.Rect(20, 20, 300, 70), color=(0.2, 0.4, 0.9), fill=(0.2, 0.4, 0.9))
        pg.insert_text(fitz.Point(30, 55), "Secret", fontsize=14, color=(1, 1, 1))
        edit = {"pageIndex": 0, "kind": "erase", "x": 25, "right": 295,
                "top": 22, "bottom": 68, "baseline": 55, "newText": ""}
        res = fitz.open(stream=post_edit(doc.tobytes(), [edit]), filetype="pdf")
        r, g, b = sample_rgb(res[0], 90, 45)
        self.assertTrue(r > 230 and g > 230 and b > 230,
                        f"erase did not whiten, sampled {(r, g, b)}")

    def test_stray_nbsp_is_cleaned(self):
        # A non-breaking space in the typed text must not become a missing-glyph box.
        doc = fitz.open()
        pg = doc.new_page(width=320, height=120)
        pg.insert_text(fitz.Point(30, 55), "Company", fontsize=14, color=(0, 0, 0))
        edit = {"pageIndex": 0, "x": 30, "right": 110, "top": 42, "bottom": 59,
                "baseline": 55, "fontSize": 14, "newText": "New Co"}
        res = fitz.open(stream=post_edit(doc.tobytes(), [edit]), filetype="pdf")
        txt = page_text(res).strip()
        self.assertIn("New Co", txt, f"nbsp not normalised to a space: {txt!r}")
        self.assertFalse(any(0x25A0 <= ord(c) <= 0x25FF or ord(c) == 0xFFFD for c in txt),
                         f"a missing-glyph box rendered: {txt!r}")

    def test_typed_char_absent_from_doc_renders(self):
        # Synthetic stand-in for the old VOE "typed 'J' disappears" check: a character that appears
        # NOWHERE in the document must still render when typed (the editor must fall back to a font
        # that can draw it), and the replaced text must be truly removed. Generated in-memory so no
        # PDF is committed.
        doc = fitz.open()
        pg = doc.new_page(width=320, height=120)
        pg.insert_text(fitz.Point(30, 60), "Test Document", fontsize=14, color=(0, 0, 0))
        self.assertNotIn("J", page_text(doc), "precondition: the doc must contain no 'J'")

        span = find_span(doc, "Test")
        self.assertIsNotNone(span, "could not find the source span")
        res = fitz.open(stream=post_edit(doc.tobytes(), [edit_from_span(span, "Jan 18, 2025")]),
                        filetype="pdf")
        txt = page_text(res)
        self.assertIn("Jan 18, 2025", txt, "typed text not present in output")
        self.assertNotIn("Test Document", txt, "replaced text was not removed")
        _, y0, _, y1 = span["bbox"]
        ink = region_ink(res[0], span["origin"][0], y0, y1, width=8.0)
        self.assertGreater(ink, 5, "the typed 'J' produced no ink (missing-glyph regression)")

    def test_added_text_is_multiline(self):
        # "Add text" with line breaks must render as multiple lines (Enter -> new line).
        doc = fitz.open()
        doc.new_page(width=400, height=220)
        edit = {"pageIndex": 0, "redact": False, "style": "text",
                "x": 40, "baseline": 60, "fontSize": 14,
                "fontFamily": "sans", "bold": False, "italic": False,
                "newText": "Line one\nLine two\nLine three"}
        res = fitz.open(stream=post_edit(doc.tobytes(), [edit]), filetype="pdf")
        txt = page_text(res)
        for line in ("Line one", "Line two", "Line three"):
            self.assertIn(line, txt, f"missing inserted line: {line!r}")
        rows = set()
        for block in res[0].get_text("dict").get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    if "Line" in span.get("text", ""):
                        rows.add(round(span["origin"][1], 1))
        self.assertGreaterEqual(len(rows), 3,
                                f"expected 3 separate line rows, got {sorted(rows)}")

    def test_added_text_rotation(self):
        # Rotated "Add text" (90° clockwise) must render rotated about its origin: a horizontal
        # word becomes taller than wide and extends downward from the (x, baseline) point.
        doc = fitz.open()
        doc.new_page(width=300, height=300)
        edit = {"pageIndex": 0, "redact": False, "style": "text",
                "x": 100, "baseline": 100, "fontSize": 20, "fontFamily": "sans",
                "newText": "Hello", "rotation": 90}
        res = fitz.open(stream=post_edit(doc.tobytes(), [edit]), filetype="pdf")
        bb = None
        for block in res[0].get_text("dict").get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    if "Hello" in span.get("text", ""):
                        bb = span["bbox"]
        self.assertIsNotNone(bb, "rotated text not found")
        self.assertGreater(bb[3] - bb[1], bb[2] - bb[0], "rotated text should be taller than wide")
        self.assertGreater(bb[3], 110, "90° clockwise text should extend downward from the origin")

    def test_added_text_mixed_run_sizes(self):
        # A single "Add text" box can hold runs of different font sizes (edit['runs']): each run
        # must save at its own size, not collapse to one size for the whole box.
        doc = fitz.open()
        doc.new_page(width=400, height=200)
        edit = {"pageIndex": 0, "redact": False, "style": "text",
                "x": 40, "baseline": 80, "fontSize": 28, "fontFamily": "sans",
                "bold": False, "italic": False,
                "newText": "Bigsmall",
                "runs": [[{"text": "Big", "size": 28}, {"text": "small", "size": 10}]]}
        res = fitz.open(stream=post_edit(doc.tobytes(), [edit]), filetype="pdf")
        big = spans_with(res, "Big")
        small = spans_with(res, "small")
        self.assertTrue(big, "large run 'Big' not found in output")
        self.assertTrue(small, "small run 'small' not found in output")
        self.assertAlmostEqual(big[0]["size"], 28, delta=1.5,
                               msg=f"large run saved at {big[0]['size']}, expected ~28")
        self.assertAlmostEqual(small[0]["size"], 10, delta=1.5,
                               msg=f"small run saved at {small[0]['size']}, expected ~10")
        self.assertGreater(big[0]["size"], small[0]["size"] + 5,
                           "the two runs should keep clearly different sizes")
        # The smaller run starts to the right of the larger one (runs chain left-to-right).
        self.assertGreater(small[0]["origin"][0], big[0]["origin"][0],
                           "small run should follow the big run on the same line")

    def test_added_text_mixed_bold_italic(self):
        # One "Add text" box can mix regular / bold / italic runs (like size). Each run must save
        # in the matching font variant, not collapse to one style.
        doc = fitz.open()
        doc.new_page(width=480, height=200)
        edit = {"pageIndex": 0, "redact": False, "style": "text",
                "x": 40, "baseline": 80, "fontSize": 18, "fontFamily": "sans",
                "bold": False, "italic": False,
                "newText": "NormBoldItal",
                "runs": [[{"text": "Norm", "size": 18, "bold": False, "italic": False},
                          {"text": "Bold", "size": 18, "bold": True, "italic": False},
                          {"text": "Ital", "size": 18, "bold": False, "italic": True}]]}
        res = fitz.open(stream=post_edit(doc.tobytes(), [edit]), filetype="pdf")
        norm = spans_with(res, "Norm")
        bold = spans_with(res, "Bold")
        ital = spans_with(res, "Ital")
        self.assertTrue(norm and bold and ital, "expected separate Norm / Bold / Ital runs")
        # Bold and italic runs use a different font variant than the regular run.
        self.assertNotEqual(bold[0]["font"], norm[0]["font"],
                            f"bold run reused the regular font {norm[0]['font']!r}")
        self.assertNotEqual(ital[0]["font"], norm[0]["font"],
                            f"italic run reused the regular font {norm[0]['font']!r}")
        # PyMuPDF span flags: bit 2**1 = italic, bit 2**4 = bold (when the font advertises it).
        self.assertTrue(ital[0]["flags"] & 2, "italic run should carry the italic flag")


# --------------------------------------------------------------------------- #
# Mixed font sizes in an "Add text" box — the save pipeline must honour each
# run's own size (regression guard: a stale/old backend used the box's largest
# size for the whole box, so a small run came out inflated).
# --------------------------------------------------------------------------- #
def add_text_edit(runs, **overrides):
    """Build an inserted "Add text" edit from runs = [[{text,size[,bold,italic]}], ...]."""
    text = "\n".join("".join(r["text"] for r in line) for line in runs)
    sizes = [r["size"] for line in runs for r in line] or [14]
    edit = {"pageIndex": 0, "redact": False, "style": "text",
            "x": 40, "baseline": 90, "fontSize": max(sizes), "fontFamily": "sans",
            "bold": False, "italic": False, "newText": text, "runs": runs}
    edit.update(overrides)
    return edit


def saved_spans(runs, width=460, height=260, **overrides):
    """Save a one-box mixed-style edit and return all drawn spans on page 0."""
    doc = fitz.open(); doc.new_page(width=width, height=height)
    edit = add_text_edit(runs, **overrides)
    res = fitz.open(stream=post_edit(doc.tobytes(), [edit]), filetype="pdf")
    out = []
    for b in res[0].get_text("dict").get("blocks", []):
        for l in b.get("lines", []):
            out.extend(l.get("spans", []))
    return out


class ToolbarStyleTests(unittest.TestCase):
    """Floating-toolbar styling that the save pipeline must honour: colour, opacity, underline,
    manual alignment, and a font-family override. All are optional fields on an edit."""

    def _doc_with(self, text, **insert):
        doc = fitz.open()
        pg = doc.new_page(width=400, height=200)
        pg.insert_text((40, 80), text, fontsize=14, **insert)
        return doc

    def test_added_text_custom_colour(self):
        src = self._doc_with("x").tobytes()
        edit = {"pageIndex": 0, "redact": False, "style": "text", "x": 40, "baseline": 140,
                "fontSize": 18, "newText": "REDTEXT", "color": [255, 0, 0]}
        res = fitz.open(stream=post_edit(src, [edit]), filetype="pdf")
        s = find_span(res, "REDTEXT")
        self.assertIsNotNone(s, "added coloured text missing")
        r, g, b = (s["color"] >> 16) & 255, (s["color"] >> 8) & 255, s["color"] & 255
        self.assertTrue(r > 200 and g < 70 and b < 70, f"expected red, got rgb=({r},{g},{b})")

    def test_replace_text_custom_colour(self):
        src = self._doc_with("hello world").tobytes()
        span = find_span(fitz.open(stream=src, filetype="pdf"), "hello")
        res = fitz.open(stream=post_edit(src, [edit_from_span(span, "blue text", color=[0, 0, 255])]),
                        filetype="pdf")
        s = find_span(res, "blue")
        self.assertIsNotNone(s)
        self.assertTrue((s["color"] & 255) > 200 and ((s["color"] >> 16) & 255) < 70,
                        f"expected blue, got {s['color']:06x}")

    def test_added_text_opacity_is_partial(self):
        src = self._doc_with("x").tobytes()
        edit = {"pageIndex": 0, "redact": False, "style": "text", "x": 40, "baseline": 140,
                "fontSize": 40, "newText": "FADE", "opacity": 0.5}
        res = fitz.open(stream=post_edit(src, [edit]), filetype="pdf")
        self.assertIsNotNone(find_span(res, "FADE"), "faded text missing")
        # Black text at 0.5 opacity on white renders ~grey: the darkest ink must NOT be near-black.
        pix = res[0].get_pixmap(matrix=fitz.Matrix(3, 3), clip=fitz.Rect(35, 95, 160, 150))
        mn = min(pix.samples[i] for i in range(0, len(pix.samples), pix.n))
        self.assertTrue(mn > 40, f"opacity not applied — darkest pixel {mn} (≈0 means fully opaque)")

    def test_added_text_underline_draws_a_line(self):
        src = self._doc_with("x").tobytes()
        edit = {"pageIndex": 0, "redact": False, "style": "text", "x": 40, "baseline": 140,
                "fontSize": 20, "newText": "UNDER",
                "runs": [[{"text": "UNDER", "size": 20, "underline": True}]]}
        res = fitz.open(stream=post_edit(src, [edit]), filetype="pdf")
        lines = [it for d in res[0].get_drawings() for it in d["items"] if it[0] == "l"]
        self.assertTrue(any(abs(it[1].y - it[2].y) < 0.6 and it[1].y > 135 for it in lines),
                        "no horizontal underline stroke drawn under the text")

    def test_replace_align_right_override(self):
        src = self._doc_with("a fairly long original line").tobytes()
        span = find_span(fitz.open(stream=src, filetype="pdf"), "fairly")
        x1 = round(span["bbox"][2], 1)
        res = fitz.open(stream=post_edit(src, [edit_from_span(span, "Short", align="right", right=x1)]),
                        filetype="pdf")
        s = find_span(res, "Short")
        self.assertIsNotNone(s)
        self.assertAlmostEqual(s["bbox"][2], x1, delta=6,
                               msg=f"right-align override lost: right edge {s['bbox'][2]:.1f} vs {x1}")

    def test_replace_font_family_override_to_serif(self):
        src = self._doc_with("sans original", fontname="helv").tobytes()
        span = find_span(fitz.open(stream=src, filetype="pdf"), "sans")
        res = fitz.open(stream=post_edit(src, [edit_from_span(span, "now serif", fontFamily="serif")]),
                        filetype="pdf")
        s = find_span(res, "serif")
        self.assertIsNotNone(s)
        self.assertIn("Times", s["font"], f"family override didn't switch to a serif font: {s['font']}")

    def test_added_text_mono_family(self):
        src = self._doc_with("x").tobytes()
        edit = {"pageIndex": 0, "redact": False, "style": "text", "x": 40, "baseline": 140,
                "fontSize": 16, "newText": "mono12", "fontFamily": "mono"}
        res = fitz.open(stream=post_edit(src, [edit]), filetype="pdf")
        s = find_span(res, "mono12")
        self.assertIsNotNone(s)
        self.assertIn("Cour", s["font"], f"mono family not applied: {s['font']}")

    def test_toolbar_named_fonts_embed_the_right_face(self):
        # The toolbar font picker must render each named family with a real embeddable font (bundled
        # open fonts for the non-Base-14 ones), so it looks right on any host — not a generic fallback.
        cases = [("arial", "Helvetica"), ("times", "Times"), ("courier", "Cour"),
                 ("roboto", "Roboto"), ("opensans", "OpenSans"),
                 ("montserrat", "Montserrat"), ("comicsans", "ComicNeue")]
        for fam, expect in cases:
            src = self._doc_with("x").tobytes()
            tok = "FNT" + fam
            edit = {"pageIndex": 0, "redact": False, "style": "text", "x": 40, "baseline": 140,
                    "fontSize": 18, "newText": tok, "fontFamily": fam,
                    "runs": [[{"text": tok, "size": 18}]]}
            res = fitz.open(stream=post_edit(src, [edit]), filetype="pdf")
            s = find_span(res, tok)
            self.assertIsNotNone(s, f"{fam}: text missing")
            self.assertIn(expect, s["font"], f"{fam}: expected {expect!r}, got {s['font']!r}")


class MixedSizeSaveTests(unittest.TestCase):

    def test_small_then_large_run_keep_their_sizes(self):
        # The exact reported case: a small run followed by a large run. The small one must NOT be
        # inflated to the box's largest size.
        spans = saved_spans([[{"text": "small ", "size": 12}, {"text": "BIG", "size": 28}]])
        small = next(s for s in spans if "small" in s["text"])
        big = next(s for s in spans if "BIG" in s["text"])
        self.assertAlmostEqual(small["size"], 12, delta=1.0, msg=f"small run = {small['size']}")
        self.assertAlmostEqual(big["size"], 28, delta=1.0, msg=f"big run = {big['size']}")
        self.assertLess(small["size"] + 8, big["size"], "runs collapsed to one size")

    def test_run_sizes_ignore_box_fontSize(self):
        # Even if the box's representative fontSize is bogus/large, each run saves at its OWN size.
        # This directly guards the regression where the whole box used edit.fontSize.
        spans = saved_spans([[{"text": "aa", "size": 12}, {"text": "bb", "size": 18}]], fontSize=99)
        sizes = sorted(round(s["size"]) for s in spans)
        self.assertIn(12, sizes, f"12 missing: {sizes}")
        self.assertIn(18, sizes, f"18 missing: {sizes}")
        self.assertFalse(any(abs(s - 99) < 3 for s in sizes), f"box fontSize leaked into a run: {sizes}")

    def test_three_ascending_runs(self):
        spans = saved_spans([[{"text": "aa", "size": 10},
                              {"text": "bb", "size": 16},
                              {"text": "cc", "size": 24}]])
        by = {t: next(s["size"] for s in spans if t in s["text"]) for t in ("aa", "bb", "cc")}
        self.assertAlmostEqual(by["aa"], 10, delta=1.0)
        self.assertAlmostEqual(by["bb"], 16, delta=1.0)
        self.assertAlmostEqual(by["cc"], 24, delta=1.0)
        self.assertLess(by["aa"], by["bb"])
        self.assertLess(by["bb"], by["cc"])

    def test_mixed_size_multiline_no_overlap(self):
        # A small line followed by a big line: both sizes preserved AND the big line sits fully
        # below the small one (line spacing uses the larger of adjacent lines).
        spans = saved_spans([[{"text": "small", "size": 10}],
                             [{"text": "BIG", "size": 30}]], height=320)
        small = next(s for s in spans if "small" in s["text"])
        big = next(s for s in spans if "BIG" in s["text"])
        self.assertAlmostEqual(small["size"], 10, delta=1.0)
        self.assertAlmostEqual(big["size"], 30, delta=1.0)
        # bbox = (x0, y0_top, x1, y1_bottom); y grows downward.
        self.assertGreaterEqual(big["bbox"][1], small["bbox"][3] - 2,
                                "big line overlaps the small line above it")

    def test_mixed_size_with_bold_and_italic_runs(self):
        # Size and weight/slant vary together across runs in one box.
        spans = saved_spans([[{"text": "Reg", "size": 14, "bold": False, "italic": False},
                              {"text": "Bld", "size": 26, "bold": True, "italic": False},
                              {"text": "Itl", "size": 20, "bold": False, "italic": True}]])
        reg = next(s for s in spans if "Reg" in s["text"])
        bld = next(s for s in spans if "Bld" in s["text"])
        itl = next(s for s in spans if "Itl" in s["text"])
        self.assertAlmostEqual(reg["size"], 14, delta=1.0)
        self.assertAlmostEqual(bld["size"], 26, delta=1.0)
        self.assertAlmostEqual(itl["size"], 20, delta=1.0)
        self.assertNotEqual(bld["font"], reg["font"], "bold run reused the regular font")
        self.assertTrue(itl["flags"] & 2, "italic run should carry the italic flag")

    def test_mixed_sizes_round_trip_text_selectable(self):
        # After saving, every run's text is still real, selectable text (not an image).
        runs = [[{"text": "Hello ", "size": 12}, {"text": "World", "size": 24}]]
        doc = fitz.open(); doc.new_page(width=460, height=200)
        res = fitz.open(stream=post_edit(doc.tobytes(), [add_text_edit(runs)]), filetype="pdf")
        txt = page_text(res)
        self.assertIn("Hello", txt)
        self.assertIn("World", txt)


if __name__ == "__main__":
    unittest.main(verbosity=2)
