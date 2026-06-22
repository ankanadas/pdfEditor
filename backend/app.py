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

from config import (
    ALLOWED_ORIGINS, RATE_DEFAULTS, RATE_HEAVY, RATELIMIT_ENABLED,
    RATELIMIT_STORAGE_URI, MAX_PDF_MB, MAX_PDF_PAGES, MAX_CONTENT_LENGTH,
)
from pdf.io import (
    _open_authenticated, PDF_MAGIC, _looks_like_pdf, _decode_pdf_or_400,
)
from pdf.images import _insert_image_edit
from pdf.spans import (
    _find_original_span, _span_color, _parse_color, _clamp_opacity,
    _SERIF_NAME_HINTS, _SANS_NAME_HINTS, _span_style, _line_uniform_style, _detect_align,
)
from pdf.fonts import (
    _FONTS_DIR, _bundled, _SANS_FILES, _SERIF_FILES, _BUILTIN, _BASE14_BY_FAMILY,
    _standard_family, _base14_draws, _SIGN_FONT_CANDIDATES, _find_font, _edit_font_kwargs,
    SIGN_FONT_FILE, SIGN_FONT_NAME, _vfiles, _TOOLBAR_FONTS, _toolbar_font_cache,
    _toolbar_font_option, _font_xrefs_for, _LATEX_FONT_RE, _is_latex_subset_font, _LATEX_FILES,
    _LATEX_BOLD_HINTS, _LATEX_ITALIC_HINTS, _latex_font_profile, _latex_fallback_kwargs,
    _is_embedded_type1, _span_uses_unreusable_embedded, _font_is_embedded, _embedded_xrefs,
    _font_charset, _warm_charsets, _install_embedded_font, _resolve_fonts, _pick_font,
)
from pdf.text_runs import (
    _TOUNI_FIX, _BFCHAR_BLOCK, _BFCHAR_PAIR, _clean_tounicode, _clean_text,
    _runs_to_segments, _insert_text_runs, _link_rect_for_edit,
)
from pdf.edit_ops import apply_edits

app = Flask(__name__)

# Behind Render's TLS-terminating proxy: trust one X-Forwarded-For / -Proto hop so
# request.remote_addr (the rate-limit key) is the real client, not the proxy. Locally
# there is no proxy header, so this is a no-op in development.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)

# ---- CORS ----------------------------------------------------------------------------
# Only our own frontend (production + local dev) may call this API from a browser (origins
# in config.ALLOWED_ORIGINS). NOTE: CORS is enforced by the browser — it stops other sites'
# pages from using fetch() against us; it is NOT a server-side firewall (curl / server
# scripts ignore it). Abuse throttling is the rate limiter's job, below.
CORS(
    app,
    resources={r"/*": {"origins": ALLOWED_ORIGINS}},
    methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
    max_age=86400,
)

# ---- Rate limiting (abuse / DoS protection) ------------------------------------------
# Per-client-IP limits (numbers in config.RATE_*). Storage defaults to in-memory, which lives
# inside ONE process and resets on restart. The default deploy runs a single gunicorn worker
# (see render.yaml), so in-memory counting is EXACT there. Scaling to N workers/instances makes
# each count independently (real limit ~N x); set RATELIMIT_STORAGE_URI to a Redis URL to share
# counts. RATELIMIT_ENABLED=0 is an ops kill-switch.
app.config["RATELIMIT_ENABLED"] = RATELIMIT_ENABLED

limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=RATE_DEFAULTS,
    storage_uri=RATELIMIT_STORAGE_URI,
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

# Defense-in-depth file-size limit (the frontend also blocks oversized files); caps live in
# config.MAX_*. A base64 PDF is held whole in RAM, decoded to bytes, then PyMuPDF's working set
# is a further multiple of that, so the cap is kept modest to leave headroom on a 512 MB instance.
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH


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


def _page_limit_response(doc):
    """A JSON 413 response if the document has more pages than we allow, else None.

    Bounds PyMuPDF's working memory on the 512 MB Render free tier: a pathological
    tiny-page / huge-count PDF can slip under the byte-size cap yet still blow up RAM
    once every page is processed. Callers return this and close the doc when it fires."""
    n = doc.page_count
    if n > MAX_PDF_PAGES:
        return jsonify({"error": f"Too many pages ({n}). Maximum is {MAX_PDF_PAGES} pages."}), 413
    return None


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

        apply_edits(doc, data)

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
