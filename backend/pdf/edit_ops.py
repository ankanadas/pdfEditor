"""Edit orchestration: apply the frontend's text edits + Fabric annotation descriptors
to an open PyMuPDF document, in place. This is the body of the /edit-pdf route, moved
verbatim from app.py (only dedented into a function); behavior is unchanged. The route
keeps request parsing, decode/auth/page-limit and the tobytes/response.
"""
import re
import fitz  # PyMuPDF

from pdf.fonts import (
    _warm_charsets, _resolve_fonts, _span_uses_unreusable_embedded,
    SIGN_FONT_FILE, SIGN_FONT_NAME,
)
from pdf.spans import (
    _find_original_span, _line_uniform_style, _detect_align,
    _span_color, _parse_color, _clamp_opacity,
)
from pdf.images import _insert_image_edit
from pdf.text_runs import _runs_to_segments, _insert_text_runs, _link_rect_for_edit, _clean_tounicode


def apply_edits(doc, data):
    """Apply text edits + annotations to `doc` in place (mutates; returns nothing)."""
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
