"""Low-level PDF I/O: open/authenticate, page-limit guard, and base64 PDF validation.

Moved verbatim from app.py — behavior is unchanged. jsonify is only invoked while a
request/app context is active (these helpers are always called from within a route).
"""
import base64
import fitz  # PyMuPDF
from flask import jsonify


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
