"""Text-run insertion + helpers: clean input text, fix the ToUnicode CMap, turn the
frontend per-run style model into segments, draw multi-font runs (with shrink-to-fit,
alignment re-anchor, opacity, underline), and compute a hyperlink rect.

Moved verbatim from app.py — behavior is unchanged.
"""
import re
import fitz  # PyMuPDF

from pdf.fonts import _pick_font
from pdf.spans import _parse_color


# ToUnicode destinations to repair: nbsp -> space, soft-hyphen -> hyphen. These are NOT in the text
# we draw (input is cleaned to ASCII) — they are artifacts of how PyMuPDF/the reused font build the
# ToUnicode CMap, and only corrupt the *text layer* (copy/extract), not the rendering.
_TOUNI_FIX = {b'00a0': b'0020', b'00ad': b'002d'}
_BFCHAR_BLOCK = re.compile(rb'beginbfchar(.*?)endbfchar', re.S)
_BFCHAR_PAIR = re.compile(rb'(<[0-9a-fA-F]{4,}>)\s*<([0-9a-fA-F]{4})>')


def _clean_tounicode(doc):
    """PyMuPDF's insert_text writes inter-word spaces into the ToUnicode CMap as U+00A0 (nbsp), and a
    reused LaTeX/Computer-Modern font maps its hyphen glyph to U+00AD (soft hyphen). Both render fine
    but make an edited line's TEXT LAYER copy/extract as 'unreadable unicode'. Rewrite those bfchar
    destinations back to plain space / hyphen so selected text is clean ASCII. Only touches bfchar
    destinations (the 2nd code of each pair); bfrange and source codes are left untouched."""
    def fix_block(bm):
        def fix_pair(pm):
            dst = pm.group(2).lower()
            return pm.group(1) + b' <' + _TOUNI_FIX[dst] + b'>' if dst in _TOUNI_FIX else pm.group(0)
        return b'beginbfchar' + _BFCHAR_PAIR.sub(fix_pair, bm.group(1)) + b'endbfchar'
    for x in range(1, doc.xref_length()):
        if not doc.xref_is_stream(x):
            continue
        try:
            s = doc.xref_stream(x)
        except Exception:
            continue
        if not s or b'beginbfchar' not in s:
            continue
        ns = _BFCHAR_BLOCK.sub(fix_block, s)
        if ns != s:
            try:
                doc.update_stream(x, ns)
            except Exception:
                pass


def _clean_text(s):
    """Drop stray characters a browser's editable box introduces (nbsp, zero-width, soft hyphen,
    control chars) so they don't save as a missing-glyph box. Keeps tabs; spaces are preserved."""
    s = s or ''
    s = re.sub(r'[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]', ' ', s)
    s = re.sub(r'[\u200b\u200c\u200d\u2060\ufeff\u00ad]', '', s)
    s = re.sub(r'[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]', '', s)  # keeps \t
    return s


def _runs_to_segments(runs, base_size, base_bold, base_italic):
    """Turn the frontend per-run style model (lines -> [{text, size, bold, italic, underline, color}])
    into cleaned [[(text, size, bold, italic, underline, color), ...], ...]. `color` is (r,g,b) 0..1 or
    None. Returns None when there are no runs, so the caller uses the plain single-style path."""
    if not runs:
        return None
    out = []
    for line in runs:
        parts = []
        for r in (line or []):
            t = _clean_text(r.get('text', '')) if isinstance(r, dict) else ''
            if not t:
                continue
            try:
                sz = float(r.get('size') or base_size)
            except (TypeError, ValueError):
                sz = base_size
            b = bool(r.get('bold')) if 'bold' in r else base_bold
            it = bool(r.get('italic')) if 'italic' in r else base_italic
            ul = bool(r.get('underline'))
            col = _parse_color(r.get('color'))
            lk = r.get('link')
            if isinstance(lk, dict):
                lk = lk.get('uri')
            lk = lk if isinstance(lk, str) and lk.strip() else None
            parts.append((t, max(4.0, min(400.0, sz)), b, it, ul, col, lk))
        out.append(parts)
    return out if any(parts for parts in out) else None


def _insert_text_runs(page, x, baseline, text, size, options, avail, morph=None, color=(0, 0, 0),
                      anchor=None, opacity=1.0, underline=False, measure_only=False):
    """Draw `text` at (x, baseline), switching font per run so every character uses a font that
    contains it. Groups consecutive same-font characters, shrinks to fit `avail` width, then
    inserts each run, advancing x by its measured width. `morph` (a (fixpoint, Matrix) pair)
    rotates the drawn text about a pivot — used for rotated "Add text" boxes. `anchor`
    (align, box_left, box_right) re-anchors a right-/centre-aligned replacement so a shorter/longer
    edit keeps the line's alignment instead of always starting at the left. `opacity` (0..1) and
    `underline` come from the floating toolbar. `measure_only` returns the drawn width without
    drawing (used to lay out a multi-line added-text box for alignment)."""
    runs, cur, cur_opt = [], [], None
    for ch in text:
        # Keep a space within the current run only when that run's font can actually draw one (most
        # fonts). If it can't (a Computer Modern / LaTeX subset font has no space glyph), fall through
        # to _pick_font so the space is drawn with a space-capable font instead of a � (.notdef) box.
        if ch == ' ' and cur_opt is not None and cur_opt[1].has_glyph(0x20):
            cur.append(ch)
            continue
        opt = _pick_font(ch, options)
        if cur_opt is None or opt[0].get('fontname') != cur_opt[0].get('fontname'):
            if cur:
                runs.append((cur_opt, ''.join(cur)))
            cur, cur_opt = [], opt
        cur.append(ch)
    if cur:
        runs.append((cur_opt, ''.join(cur)))

    total = sum(opt[1].text_length(s, fontsize=size) for opt, s in runs)
    if total > avail > 8:
        size = max(4.0, size * avail / total)
        total = sum(opt[1].text_length(s, fontsize=size) for opt, s in runs)   # after shrink
    if measure_only:
        return total

    cx = x
    if anchor:
        align, box_left, box_right = anchor
        if align == 'right':
            cx = max(box_left, box_right - total)
        elif align == 'center':
            cx = max(box_left, (box_left + box_right) / 2 - total / 2)
    start = cx
    extra = {'morph': morph} if morph else {}
    if opacity is not None and opacity < 1.0:
        extra['fill_opacity'] = opacity
    for opt, s in runs:
        kwargs, font = opt
        page.insert_text(fitz.Point(cx, baseline), s, fontsize=size, color=color, **kwargs, **extra)
        cx += font.text_length(s, fontsize=size)
    if underline and cx > start:
        # A line just below the baseline spanning the drawn text; honour rotation + opacity via Shape.
        uy = baseline + size * 0.12
        sh = page.new_shape()
        sh.draw_line(fitz.Point(start, uy), fitz.Point(cx, uy))
        fin = dict(color=color, width=max(0.4, size * 0.055),
                   stroke_opacity=(opacity if opacity is not None else 1.0))
        if morph:
            fin['morph'] = morph
        sh.finish(**fin)
        sh.commit()
    return cx - start          # drawn advance width (lets a caller chain segments on one line)


def _link_rect_for_edit(edit, size, text_lines, font):
    """Clickable-area rect (PDF points, top-origin) for an edit carrying a hyperlink. An existing-text
    edit uses the line's own bbox; added text is measured from the drawn block (x/baseline + text
    width/height). Used to place a LINK_URI annotation over the final text position."""
    x = float(edit.get('x', 0))
    if edit.get('redact', True):                      # existing line -> its captured bbox
        top = float(edit.get('top', 0)); right = float(edit.get('right', x)); bottom = float(edit.get('bottom', top))
        return fitz.Rect(max(0, x - 1), max(0, top - 1), max(right, x + 4) + 1, bottom + 1)
    baseline = float(edit.get('baseline', 0))         # added text -> measure the drawn text block
    lines = [ln for ln in (text_lines or []) if ln.strip()]
    try:
        w = max((font.text_length(ln, fontsize=size) for ln in lines), default=size)
    except Exception:
        w = max((0.5 * size * len(ln) for ln in lines), default=size)
    line_h = size * 1.2
    top = baseline - size * 0.8
    bottom = baseline + (max(1, len(lines)) - 1) * line_h + size * 0.3
    return fitz.Rect(x, top, x + max(w, 4), bottom)
