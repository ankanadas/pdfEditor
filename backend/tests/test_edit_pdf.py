"""
Regression tests for the /edit-pdf text-replacement behaviour.

These guard the fixes made to high-fidelity editing:
  - a typed glyph the document never used still renders (subset fonts keep a full
    cmap but strip outlines, so coverage must come from characters actually drawn);
  - replaced text is truly removed (ATS-clean);
  - edited text reuses the document's OWN fonts (e.g. Calibri), not a generic one;
  - the matched span's weight (e.g. a bold bullet/header) does NOT force the whole
    edited line bold — the line's own flag wins;
  - a coloured/shaded background survives a text replace (fill=False);
  - stray characters a contentEditable can introduce (nbsp/zero-width) are cleaned.

Two tests use real PDFs that contain personal data and are therefore NOT committed
(see backend/tests/fixtures/README.md). Those tests SKIP automatically when the
fixture is absent; the synthetic tests always run.
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
VOE = os.path.join(FIXTURES, "voe_letter.pdf")
RESUME = os.path.join(FIXTURES, "resume.pdf")


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
@unittest.skipUnless(os.path.exists(VOE), f"missing fixture: {VOE}")
class VoeLetterTests(unittest.TestCase):
    """Employment letter — its fonts keep a full cmap but strip outlines (the 'J' bug)."""

    def _edit_date(self, new_text):
        src = fitz.open(VOE)
        span = find_span(src, "April")
        self.assertIsNotNone(span, "could not find the 'April …' date span")
        out = post_edit(src.tobytes(), [edit_from_span(span, new_text)])
        return fitz.open(stream=out, filetype="pdf"), span

    def test_typed_glyph_absent_from_doc_renders(self):
        # 'J' appears nowhere in the letter; typing "Jan" must still render the J.
        res, span = self._edit_date("Jan 18, 2025")
        self.assertNotIn("J", page_text(fitz.open(VOE)), "precondition: letter must contain no 'J'")
        self.assertIn("Jan 18, 2025", page_text(res), "edited text not present in output")
        x0, y0, x1, y1 = span["bbox"]
        ink = region_ink(res[0], span["origin"][0], y0, y1, width=7.0)
        self.assertGreater(ink, 5, "the 'J' produced no ink (missing-glyph regression)")

    def test_old_text_truly_removed(self):
        res, _ = self._edit_date("Jan 18, 2025")
        self.assertNotIn("April", page_text(res), "old 'April' text was not removed")


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

    def test_matched_bold_span_does_not_force_bold(self):
        # Anchor on a BOLD span (Calibri-Bold) but say the line is regular (bold=False):
        # the re-inserted text must come out regular, not bold.
        src = fitz.open(RESUME)
        span = find_span(src, "Software Engineer")
        self.assertIsNotNone(span, "could not find a bold 'Software Engineer' span")
        self.assertIn("Bold", span["font"], "precondition: anchor span should be bold")
        res = fitz.open(stream=post_edit(src.tobytes(),
                        [edit_from_span(span, "engineering team lead", bold=False)]), filetype="pdf")
        got = spans_with(res, "engineer")
        self.assertTrue(got, "edited text not found in output")
        for s in got:
            self.assertNotIn("Bold", s["font"],
                             f"edited regular line rendered bold: {s['font']!r}")

    def test_no_characters_dropped(self):
        # Every typed character of a body edit must survive (no silent drops / boxes).
        src = fitz.open(RESUME)
        span = find_span(src, "Integrated AWS")
        self.assertIsNotNone(span, "could not find the Amazon bullet body span")
        new = "Designed and shipped a scalable service"
        res = fitz.open(stream=post_edit(src.tobytes(), [edit_from_span(span, new)]), filetype="pdf")
        self.assertIn(new, page_text(res), "some characters were dropped on re-insert")


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
