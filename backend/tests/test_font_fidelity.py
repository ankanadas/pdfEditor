"""Save-fidelity: an edit must keep the line's FONT FAMILY (serif vs sans), SIZE and COLOUR
when the user didn't change them, and apply them when they did.

Guards the bug where editing text in a PDF that embeds a sans face whose name isn't in the
recognised-sans list (Carlito/Arimo/Cousine — the open Calibri/Arial/Courier clones LibreOffice
embeds) silently re-inserted the line in Tinos (a serif/Times clone) — i.e. sans -> serif.

Committed + auto-discovered (test_*.py), so it runs on every `npm run build` / push.
"""
import os
import io
import base64
import unittest

import fitz  # noqa: E402

import sys  # noqa: E402
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))   # backend/
import app as appmod  # noqa: E402

FONTS = os.path.join(os.path.dirname(HERE), "fonts")
SAMPLE = "Original sample line ABCxyz 123"

# Output font-NAME families. PyMuPDF mis-sets the serif span flag on some sans faces, so the
# assertion keys on the NAME (the reliable signal), never the flag.
_SERIF_FACES = ("times", "tinos", "tiro", "caladea", "gelasio", "garamond", "noto serif",
                "notoserif", "playfair", "baskerville", "merriweather", "georgia", "cambria", "roman")
_SANS_FACES = ("helvetica", "arial", "arimo", "carlito", "calibri", "verdana", "tahoma",
               "roboto", "cousine", "courier", "open sans", "liberation", "lato", "inter")


def out_is_serif(font_name):
    nm = (font_name or "").lower()
    if any(k in nm for k in _SERIF_FACES):
        return True
    if any(k in nm for k in _SANS_FACES):
        return False
    return None  # unknown — caller decides


class FontFidelityTests(unittest.TestCase):
    def setUp(self):
        self.client = appmod.app.test_client()

    # -- helpers --------------------------------------------------------------
    def _make(self, font, size=14, color=(0, 0, 0), bg=None, text=SAMPLE):
        doc = fitz.open(); pg = doc.new_page(width=480, height=200)
        if bg:
            pg.draw_rect(fitz.Rect(0, 0, 480, 200), color=None, fill=bg)
        if font.endswith(".ttf"):
            pg.insert_text(fitz.Point(72, 120), text, fontsize=size, color=color,
                           fontname="EF", fontfile=os.path.join(FONTS, font))
        else:
            pg.insert_text(fitz.Point(72, 120), text, fontsize=size, color=color, fontname=font)
        return doc.tobytes()

    def _edit(self, pdf_bytes, edits):
        r = self.client.post("/edit-pdf", json={
            "pdfBase64": base64.b64encode(pdf_bytes).decode(), "edits": edits})
        d = r.get_json() or {}
        self.assertTrue(r.status_code == 200 and d.get("success"), f"/edit-pdf {r.status_code} {d}")
        return base64.b64decode(d["pdfBase64"])

    def _first_span(self, pdf_bytes):
        d = fitz.open(stream=pdf_bytes, filetype="pdf")
        for b in d[0].get_text("dict")["blocks"]:
            for ln in b.get("lines", []):
                for s in ln.get("spans", []):
                    if s["text"].strip():
                        return s
        return None

    def _span_with(self, pdf_bytes, needle):
        d = fitz.open(stream=pdf_bytes, filetype="pdf")
        for b in d[0].get_text("dict")["blocks"]:
            for ln in b.get("lines", []):
                for s in ln.get("spans", []):
                    if needle in s["text"]:
                        return s
        return None

    def _edit_obj(self, span, new_text, **ov):
        ox, oy = span["origin"]; x0, y0, x1, y1 = span["bbox"]
        e = {"pageIndex": 0, "x": round(ox, 1), "right": round(x1, 1), "top": round(y0, 1),
             "bottom": round(y1, 1), "baseline": round(oy, 1), "fontSize": round(span["size"], 1),
             "bold": False, "italic": False, "serif": False, "newText": new_text}
        e.update(ov); return e

    @staticmethod
    def _rgb(span):
        c = int(span.get("color", 0) or 0)
        return (c >> 16 & 255, c >> 8 & 255, c & 255)

    # -- 1) text-only edit (no style change) keeps font category -------------
    def test_text_edit_keeps_serif_or_sans_category(self):
        # (label, font, expect-serif). Includes the open clones that previously misfired.
        corpus = [("helvetica", "helv", False), ("times", "tiro", True),
                  ("arimo(sans)", "Arimo-Regular.ttf", False),
                  ("carlito(sans)", "Carlito-Regular.ttf", False),
                  ("cousine(mono)", "Cousine-Regular.ttf", False),
                  ("caladea(serif)", "Caladea-Regular.ttf", True)]
        for label, font, want_serif in corpus:
            src = self._make(font)
            o = self._first_span(src)
            out = self._edit(src, [self._edit_obj(o, "Edited replacement TEXTxyz 987")])
            n = self._span_with(out, "Edited replacement")
            self.assertIsNotNone(n, f"{label}: edited line missing in saved PDF")
            got = out_is_serif(n["font"])
            self.assertEqual(got, want_serif,
                             f"{label}: editing text (no style change) changed the font CATEGORY "
                             f"(want serif={want_serif}, got '{n['font']}')")

    # -- 2) text-only edit keeps size + colour --------------------------------
    def test_text_edit_keeps_size_and_colour(self):
        for font in ("helv", "Arimo-Regular.ttf", "Carlito-Regular.ttf"):
            src = self._make(font, size=14, color=(0, 0, 0))
            o = self._first_span(src)
            n = self._span_with(self._edit(src, [self._edit_obj(o, "KeepStyle xyz")]), "KeepStyle")
            self.assertLess(abs(n["size"] - 14), 1.0, f"{font}: size not preserved ({n['size']})")
            self.assertEqual(self._rgb(n), (0, 0, 0), f"{font}: colour not preserved ({self._rgb(n)})")

    # -- 2b) MONOSPACE preserved on edit (must not drop to a proportional sans) --
    def test_mono_preserved_on_edit(self):
        for label, font in [("courier(base14)", "cour"),
                            ("cousine(embedded)", "Cousine-Regular.ttf")]:
            src = self._make(font, text="def f(): return 0")
            o = self._first_span(src)
            n = self._span_with(self._edit(src, [self._edit_obj(o, "edited_mono = 1")]), "edited_mono")
            self.assertIsNotNone(n, f"{label}: edited mono line missing")
            mono = any(k in n["font"].lower() for k in ("cour", "cousine", "mono", "consol"))
            self.assertTrue(mono, f"{label}: editing monospace text dropped to a proportional "
                                  f"face ('{n['font']}') — fixed-pitch not preserved")

    # -- 3) explicit style changes are applied --------------------------------
    def test_explicit_bold_italic_size_applied(self):
        src = self._make("helv", size=14); o = self._first_span(src)
        nb = self._span_with(self._edit(src, [self._edit_obj(o, "BoldNow", bold=True)]), "BoldNow")
        self.assertTrue(int(nb["flags"]) & 16 or "bold" in nb["font"].lower(), "bold not applied")
        ni = self._span_with(self._edit(src, [self._edit_obj(o, "ItalNow", italic=True)]), "ItalNow")
        self.assertTrue(int(ni["flags"]) & 2 or "italic" in ni["font"].lower()
                        or "oblique" in ni["font"].lower(), "italic not applied")
        ns = self._span_with(self._edit(src, [self._edit_obj(o, "BigNow", fontSize=28, sizeOverride=True)]), "BigNow")
        self.assertGreater(ns["size"], 22, f"size change not applied ({ns['size']})")

    # -- 4) colour: changed when asked, preserved (black/white/red/blue) when not
    def test_colour_change_and_preservation(self):
        src = self._make("helv"); o = self._first_span(src)
        nc = self._span_with(self._edit(src, [self._edit_obj(o, "RedNow", color="#FF0000")]), "RedNow")
        self.assertTrue(self._rgb(nc)[0] > 200 and self._rgb(nc)[1] < 60, f"colour change not applied {self._rgb(nc)}")
        for name, col, bg, chk in [
            ("red", (1, 0, 0), None, lambda r: r[0] > 200 and r[1] < 60),
            ("white", (1, 1, 1), (0.1, 0.1, 0.1), lambda r: min(r) > 200),
            ("blue", (0, 0, 1), None, lambda r: r[2] > 200 and r[0] < 60),
        ]:
            src = self._make("helv", color=col, bg=bg); o = self._first_span(src)
            n = self._span_with(self._edit(src, [self._edit_obj(o, f"Edited {name}")]), f"Edited {name}")
            self.assertTrue(chk(self._rgb(n)), f"{name} text not preserved on edit ({self._rgb(n)})")


if __name__ == "__main__":
    unittest.main(verbosity=2)
