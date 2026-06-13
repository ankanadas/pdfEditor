from flask import Flask, request, jsonify
from flask_cors import CORS
import fitz  # PyMuPDF
import base64
import os

app = Flask(__name__)
CORS(app)  # Allow requests from the frontend

# Defense-in-depth file-size limit (the frontend also blocks oversized files).
# The editor sends the PDF base64-encoded (~1.34x larger), so the raw request cap is
# set above the document limit to fit a MAX_PDF_MB document plus JSON overhead.
MAX_PDF_MB = 10
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


# A real Unicode TrueType font is used for inserting edited text so that bullets (•),
# em-dashes (—), curly quotes, etc. are preserved. Falls back to builtin Helvetica
# (Latin-1 only) if no system font is found.
_FONT_CANDIDATES = [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


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


EDIT_FONT_FILE = _find_font(_FONT_CANDIDATES)
EDIT_FONT_NAME = "edixf"
SIGN_FONT_FILE = _find_font(_SIGN_FONT_CANDIDATES)
SIGN_FONT_NAME = "edsig"


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
        print(f"\nProcessing {len(edits)} line edit(s); font={EDIT_FONT_FILE or 'builtin helv'}")

        # Group edits by page so we can redact everything, then re-insert text.
        edits_by_page = {}
        for edit in edits:
            edits_by_page.setdefault(int(edit.get('pageIndex', 0)), []).append(edit)

        for page_num, page_edits in edits_by_page.items():
            if page_num < 0 or page_num >= len(doc):
                continue
            page = doc[page_num]
            pw, ph = page.rect.width, page.rect.height

            # 1) Redact the original text of REPLACE edits (white fill, no cross-out).
            #    Insert-only edits (added text / signatures) set redact=False.
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
                page.add_redact_annot(rect, fill=(1, 1, 1), cross_out=False)
                did_redact = True
            if did_redact:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)

            # 2) Insert each edit's text at its baseline (signatures use a script font).
            for edit in page_edits:
                x = float(edit.get('x', 0))
                baseline = float(edit.get('baseline', 0))
                font_size = float(edit.get('fontSize', 12))
                style = edit.get('style', 'text')
                new_text = (edit.get('newText', '') or '').replace('\n', ' ').replace('\r', '')
                if not new_text:
                    continue

                kwargs = dict(fontsize=font_size, color=(0, 0, 0))
                if style == 'signature' and SIGN_FONT_FILE:
                    kwargs.update(fontname=SIGN_FONT_NAME, fontfile=SIGN_FONT_FILE)
                elif EDIT_FONT_FILE:
                    kwargs.update(fontname=EDIT_FONT_NAME, fontfile=EDIT_FONT_FILE)
                else:
                    kwargs.update(fontname='tiit' if style == 'signature' else 'helv')

                page.insert_text(fitz.Point(x, baseline), new_text, **kwargs)
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
    # Port 5000 is taken by macOS AirPlay Receiver (ControlCenter), so use 5001.
    print("✅ Server running on http://localhost:5001")
    # debug=False disables the interactive (code-executing) debugger and the reloader.
    # host='127.0.0.1' binds to localhost only, so the server is never exposed on the network.
    app.run(debug=False, host='127.0.0.1', port=5001)
