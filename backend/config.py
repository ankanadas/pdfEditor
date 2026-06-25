"""Backend configuration constants (origins, rate limits, size caps).

Pure values only — no Flask object, no side effects beyond reading env vars — so
they can be imported anywhere without pulling in the app. app.py wires these into
the Flask app / CORS / Limiter; behaviour is unchanged from when they lived inline.
"""
import os

# ---- CORS ----------------------------------------------------------------------------
# Only our own frontend (production + local dev) may call this API from a browser.
# Override with the ALLOWED_ORIGINS env var (comma-separated).
_DEFAULT_ORIGINS = (
    "https://quickpdfeditor.com,https://www.quickpdfeditor.com,"
    "http://localhost:9000,http://127.0.0.1:9000"
)
ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",") if o.strip()
]

# ---- Rate limiting (abuse / DoS protection) ------------------------------------------
RATE_DEFAULTS = ["60 per minute", "600 per hour"]
RATE_HEAVY = "30 per minute;300 per hour"  # CPU/memory-heavy PDF endpoints
RATELIMIT_ENABLED = os.environ.get("RATELIMIT_ENABLED", "1") not in ("0", "false", "False")
RATELIMIT_STORAGE_URI = os.environ.get("RATELIMIT_STORAGE_URI", "memory://")

# ---- Size / resource caps ------------------------------------------------------------
# The editor sends the PDF base64-encoded (~1.34x larger), so the raw request cap is set
# above the document limit to fit a MAX_PDF_MB document plus JSON overhead. MAX_PDF_PAGES
# additionally bounds the per-document working set for pathological tiny-page/huge-count files.
MAX_PDF_MB = int(os.environ.get("MAX_PDF_MB", "30"))
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", "500"))
MAX_CONTENT_LENGTH = int(MAX_PDF_MB * 1.4 * 1024 * 1024)
