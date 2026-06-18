"""'Merge then edit then save' coverage.

The merge itself is client-side (pdf-lib), so here we build a multi-page document that
stands in for a merged result and verify the backend edit/save path that runs after a
merged doc is opened and edited: every page must survive, edits must apply to the right
page, and an edit-free save must round-trip cleanly (guards the save flow).
"""
import base64
import os
import sys
import unittest

import fitz

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
import app as appmod  # noqa: E402


def _multipage(texts):
    """A PDF with one page per string."""
    d = fitz.open()
    for t in texts:
        d.new_page().insert_text((72, 120), t, fontsize=18)
    out = d.tobytes()
    d.close()
    return out


def _post_edit(pdf_bytes, edits):
    client = appmod.app.test_client()
    r = client.post("/edit-pdf", json={
        "pdfBase64": base64.b64encode(pdf_bytes).decode(),
        "edits": edits,
    })
    j = r.get_json()
    assert r.status_code == 200 and j and j.get("success"), f"/edit-pdf failed: {r.status_code} {j}"
    return base64.b64decode(j["pdfBase64"])


def _find_span(doc, substring, page):
    for block in doc[page].get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if substring in span.get("text", ""):
                    return span
    return None


def _edit(span, page_index, new_text):
    ox, oy = span["origin"]
    x0, y0, x1, y1 = span["bbox"]
    return {
        "pageIndex": page_index,
        "x": round(ox, 1), "right": round(x1, 1),
        "top": round(y0, 1), "bottom": round(y1, 1),
        "baseline": round(oy, 1),
        "fontSize": round(span["size"], 1),
        "bold": False, "italic": False, "serif": False,
        "newText": new_text,
    }


class MergeEditSaveTests(unittest.TestCase):
    def test_edit_and_save_on_a_multipage_merged_doc(self):
        merged = _multipage(["Page One Alpha", "Page Two Bravo", "Page Three Charlie"])
        src = fitz.open(stream=merged, filetype="pdf")
        self.assertEqual(src.page_count, 3)
        span = _find_span(src, "Bravo", page=1)            # edit something on page 2
        self.assertIsNotNone(span, "could not find an editable span on page 2")
        new_text = span["text"].replace("Bravo", "Zedited")  # plain-letter marker
        saved = _post_edit(merged, [_edit(span, 1, new_text)])
        src.close()

        # PyMuPDF re-encodes spaces as NBSP, so normalise before comparing (as the other tests do).
        def txt(doc, i):
            return doc[i].get_text().replace(" ", " ")

        out = fitz.open(stream=saved, filetype="pdf")
        try:
            self.assertEqual(out.page_count, 3, "save must keep every merged page")
            self.assertIn("Zedited", txt(out, 1))   # edit applied to page 2
            self.assertIn("Alpha", txt(out, 0))      # other pages untouched
            self.assertIn("Charlie", txt(out, 2))
        finally:
            out.close()

    def test_save_with_no_edits_preserves_all_pages(self):
        merged = _multipage(["One", "Two", "Three", "Four"])
        saved = _post_edit(merged, [])                     # plain save / round-trip
        out = fitz.open(stream=saved, filetype="pdf")
        try:
            self.assertEqual(out.page_count, 4)
        finally:
            out.close()


if __name__ == "__main__":
    unittest.main()
