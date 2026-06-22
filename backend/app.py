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
