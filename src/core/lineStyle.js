// Line-style detection — underline detection, cover-strip state, build/read per-line style runs.
// Assembled onto PDFEditorApp.prototype (mixin); verbatim from app.js (this = the app).
import { readRegion } from '../util/canvas.js';
import { rgbCss, rgbToHex, hexToRgb } from '../util/color.js';

export const LineStyleMethods = {
  /**
   * Classify the source strip used to hide a text line: 'clean' (uniform background close to the
   * cell's own colour — safe to stretch), 'dirty' (a border / rule / adjacent glyph passes through,
   * so stretching it would paint a dark "shadow" band — fill solid instead) or 'unknown' (pixel
   * readback unavailable — keep the legacy drawImage behaviour). Coordinates are device pixels.
   */
  _coverStripState(ctx, x, y, w, h, bg) {
    if (!bg) return 'unknown';                       // no sampled bg (readback failed earlier) -> legacy
    let d;
    try { d = ctx.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))).data; }
    catch (e) { return 'unknown'; }
    const bgL = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    let sum = 0, n = 0; const vals = [];
    for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; vals.push(l); sum += l; n++; }
    if (!n) return 'unknown';
    const mean = sum / n;
    let q = 0; for (const l of vals) q += (l - mean) * (l - mean);
    const std = Math.sqrt(q / n);
    // Not uniform (a line/glyph runs through it) OR materially darker than the cell's own background.
    if (std > 24 || mean < bgL - 22) return 'dirty';
    return 'clean';
  },
  /**
   * Detect a drawn underline under each item of a line by probing the rendered canvas (PDF.js draws
   * underlines as a thin line, not a font attribute, so they aren't in the text items). Reads ONE
   * strip just below the line's baseline, then per item looks for a long, THIN, contiguous run of ink
   * spanning most of the item's width — an underline — while rejecting glyph descenders (short runs)
   * and solid fills/shading (ink across many rows). Sets it.underline; returns true if any item is
   * underlined. Must run on the CLEAN canvas, before the line is covered. Best-effort: any failure
   * (e.g. a tainted canvas) just leaves underlines undetected.
   *
   * Crucially it rejects a horizontal RULE/DIVIDER that merely passes under the text: a real underline
   * ends with the text, but a page divider/section rule/table border continues past the text on the
   * left and/or right. The strip is read with a margin on each side, and any candidate rule row that
   * still has ink in that outside margin is treated as a divider, NOT an underline — so editing a
   * heading sitting just above a divider never mistakes the divider for an underline (which would make
   * the save cover-and-redraw it at the new text width and visibly break the line).
   */
  _detectLineUnderlines(pv, line, bg) {
    try {
      const items = (line.items || []).filter(it => (it.text || '').trim());
      if (!items.length) return false;
      const cw = pv.canvas.width, ch = pv.canvas.height;
      const H = Math.max(6, line.fontSizePx || (line.bottom - line.top));
      const y0 = Math.max(0, Math.floor(line.baseline + H * 0.04));
      const y1 = Math.min(ch, Math.ceil(line.baseline + H * 0.34));
      const margin = Math.max(16, Math.round(H));        // room to see a rule extending past the text
      const x0 = Math.max(0, Math.floor(line.left) - margin);
      const x1 = Math.min(cw, Math.ceil(line.right) + margin);
      const w = x1 - x0, h = y1 - y0;
      if (w < 4 || h < 2) return false;
      const data = readRegion(pv.canvas, x0, y0, w, h);
      const isInk = (i) => {
        if (data[i + 3] < 128) return false;
        if (!bg) return (data[i] + data[i + 1] + data[i + 2]) < 600;       // dark on assumed-light bg
        return (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2])) > 100;
      };
      const rowInk = (py, from, to) => { for (let px = from; px < to; px++) { if (isInk((py * w + px) * 4)) return true; } return false; };
      let any = false;
      for (const it of items) {
        const c0 = Math.max(0, Math.floor(it.left) - x0);
        const c1 = Math.min(w, Math.ceil(it.right) - x0);
        const iw = c1 - c0;
        if (iw < 6) { it.underline = false; continue; }
        // Columns just OUTSIDE the item, where a divider (but not an underline) would still have ink.
        const lFrom = Math.max(0, c0 - margin), lTo = Math.max(0, c0 - 3);
        const rFrom = Math.min(w, c1 + 3), rTo = Math.min(w, c1 + margin);
        let lineRows = 0, inkRows = 0;
        for (let py = 0; py < h; py++) {
          let run = 0, best = 0, inkCols = 0;
          for (let px = c0; px < c1; px++) {
            const i = (py * w + px) * 4;
            if (isInk(i)) { run++; inkCols++; if (run > best) best = run; } else run = 0;
          }
          if (inkCols > 0) inkRows++;
          if (best >= 0.55 * iw) {
            // A near-full-width rule that ALSO has ink in the outside margin is a divider/border, not
            // this text's underline — don't count it.
            const extendsOut = (lTo > lFrom && rowInk(py, lFrom, lTo)) || (rTo > rFrom && rowInk(py, rFrom, rTo));
            if (!extendsOut) lineRows++;
          }
        }
        // Underline = a thin rule (1..4 rows of near-full-width ink), NOT a solid fill (ink in most rows).
        it.underline = lineRows >= 1 && lineRows <= 4 && inkRows <= Math.max(4, h * 0.6);
        if (it.underline) any = true;
      }
      return any;
    } catch (e) {
      return false;
    }
  },
  /**
   * Group a line's items into contiguous style RUNS [{text,bold,italic,underline}] so a mixed line
   * (a bold label + a regular tail, a partly-underlined line) keeps each run's own style when the
   * line is edited and re-saved. Whitespace-only items extend the current run (a space carries no
   * style of its own). Stored on line.styleRuns only when the line genuinely mixes styles AND the
   * runs reconstruct line.text exactly — otherwise left unset so the simple whole-line path (which
   * already preserves a uniform style) runs unchanged. No behaviour change for single-style lines.
   */
  /** Null any per-run face PDF.js did NOT register as a usable @font-face. A NON-EMBEDDED standard font
   *  extracts a loadedName like "g_d0_f5" but actually RENDERS through a substitute ("g_d0_sf4"); putting
   *  g_d0_f5 in the editor's font stack falls back to Arial, so the UNTOUCHED words "change font". Such
   *  runs drop the override and inherit the box's (correct) family — exactly like a non-split line.
   *  EMBEDDED faces (which ARE registered) keep their own face for per-run weight/family fidelity. Shared
   *  by the on-load run builder AND the live partial-style path so both behave identically. */
  _dropUnregisteredRunFaces(runs) {
    try {
      const loaded = new Set();
      document.fonts.forEach((f) => loaded.add((f.family || '').replace(/["']/g, '')));
      for (const r of (runs || [])) if (r.font && !loaded.has(r.font)) r.font = null;
    } catch (_) { /* document.fonts unavailable — keep faces as-is */ }
    return runs;
  },
  _buildLineStyleRuns(line) {
    const items = (line.items || []);
    if (items.length < 1) return;
    const runs = [];
    let prevRight = null, endsSpace = true;          // start "true" so no leading synth space
    const colEq = (a, b) => (!a && !b) || !!(a && b && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 24);
    const append = (text, st) => {
      const last = runs[runs.length - 1];
      if (!st && last) { last.text += text; }        // a blank item joins the current run
      // Split a new run when ANY of weight/slant/underline, the PDF.js face, OR the ink COLOUR changes —
      // so a reopened line keeps its per-word font AND colour (a partial edit), not one flattened style.
      else if (last && last.bold === st.b && last.italic === st.i && last.underline === st.u &&
               (last.font || null) === (st.f || null) && colEq(last.color, st.col)) { last.text += text; if (!last.font && st.f) last.font = st.f; }
      // Carry each run's OWN PDF.js font face (e.g. the line's Calibri-Bold for the bold run, Calibri for
      // the regular run) so the editor paints each run with its real weight — NOT one baked face for the
      // whole box (which made the regular runs look bold) NOR a single faux-bold clone (too light for the
      // bold runs). See _lineRunSpanHTML.
      else runs.push({ text, bold: st ? st.b : false, italic: st ? st.i : false, underline: st ? st.u : false, font: st ? st.f : null, color: st ? st.col || null : null });
      if (text) endsSpace = /\s$/.test(text);
    };
    for (const it of items) {
      const t = it.text || '';
      if (!t) continue;
      if (!t.trim()) { append(t, null); prevRight = it.right; continue; }
      // Mirror groupTextItemsByLine: synthesise a space across a positional gap so the runs join back
      // to the same text the simple path would produce (and the safety check below passes).
      if (runs.length && prevRight != null && !endsSpace && !/^\s/.test(t) &&
          (it.left - prevRight) > (it.height || 0) * 0.18) {
        runs[runs.length - 1].text += ' '; endsSpace = true;
      }
      append(t, { b: !!it.bold, i: !!it.italic, u: !!it.underline, f: it.fontName, col: it.color || null });
      prevRight = it.right;
    }
    // Need ≥2 distinct styles to be worth a per-run model (weight/slant/underline, face, OR colour).
    const ckey = (c) => c ? `${c[0] >> 3},${c[1] >> 3},${c[2] >> 3}` : '';   // quantise to ignore AA noise
    const distinct = new Set(runs.map(r => `${r.bold}|${r.italic}|${r.underline}|${r.font || ''}|${ckey(r.color)}`));
    if (runs.length < 2 || distinct.size < 2) return;
    this._dropUnregisteredRunFaces(runs);
    // Safety: the runs must reproduce the line's (normalised) text exactly, else fall back to the
    // simple path rather than risk corrupting the line.
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (norm(runs.map(r => r.text).join('')) !== norm(line.text)) return;
    line.styleRuns = runs;
  },
  /** One styled <span> (data-* markers + inline CSS) for a mixed existing-line run. `serif` picks the
   *  fallback family. Each run is painted with its OWN PDF.js face (r.font) so a bold run uses the real
   *  Calibri-Bold (heavy, like the page) and a regular run the real Calibri — not one baked face for the
   *  whole box (regular runs looked bold) nor a single faux-bold clone (bold runs looked too light). */
  _lineRunSpanHTML(r, serif) {
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // SINGLE quotes for the family names — this string is interpolated into style="…", so double quotes
    // would close the attribute early (the run would silently fall back to the box's faux-bold clone).
    const fb = serif ? "'Times New Roman', Times, serif" : 'Arial, Helvetica, sans-serif';
    const css = [`font-weight:${r.bold ? 'bold' : 'normal'}`, `font-style:${r.italic ? 'italic' : 'normal'}`];
    // A per-run font FAMILY (partial font change) wins over the page face; else the run's own face (r.font).
    if (r.family) { const fam = this._familyCss(r.family).replace(/"/g, "'"); css.push(`font-family:${fam}`); }
    else if (r.font) css.push(`font-family:'${r.font}', ${fb}`);
    if (r.color) css.push(`color:${rgbCss(r.color)}`);             // per-run colour (partial colour change)
    if (r.underline) css.push('text-decoration:underline');
    const attrs = `data-bold="${r.bold ? 1 : 0}" data-italic="${r.italic ? 1 : 0}"${r.underline ? ' data-underline="1"' : ''}` +
      `${r.family ? ` data-family="${esc(r.family)}"` : ''}${r.color ? ` data-color="${rgbToHex(r.color)}"` : ''}${r.link ? ` data-link="${esc(r.link)}"` : ''}`;
    const cls = r.link ? ' class="tt-has-link"' : '';
    return `<span${cls} ${attrs} style="${css.join(';')}">${esc(r.text)}</span>`;
  },
  /**
   * Read a focused existing-line box back into a single line of style runs [{text,bold,italic,
   * underline}], walking text nodes and inheriting each span's data-* markers. Returns null when the
   * box has no styled spans (a plain, single-style line) so the caller keeps the simple whole-line
   * path. Per-run text is cleaned the same way as the plain path, so the runs join back to newText.
   */
  _readLineRuns(div) {
    if (!div || !div.querySelector('span[data-bold],span[data-italic],span[data-underline]')) return null;
    const runs = [];
    const same = (a, b) => a.bold === b.bold && a.italic === b.italic && a.underline === b.underline &&
      (a.family || null) === (b.family || null) && JSON.stringify(a.color || null) === JSON.stringify(b.color || null) && (a.link || null) === (b.link || null);
    const push = (text, st) => {
      if (!text) return;
      const last = runs[runs.length - 1];
      if (last && same(last, st)) { last.text += text; if (!last.font && st.font) last.font = st.font; }
      else runs.push({ text, bold: st.bold, italic: st.italic, underline: st.underline, font: st.font || null, family: st.family || null, color: st.color || null, link: st.link || null });
    };
    const walk = (node, inh) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) { push(child.nodeValue, inh); return; }
        if (child.nodeType !== Node.ELEMENT_NODE || child.tagName === 'BR') return;
        const st = { ...inh };
        if (child.hasAttribute && child.hasAttribute('data-bold')) st.bold = child.getAttribute('data-bold') === '1';
        else if (child.style && (child.style.fontWeight === 'bold' || parseInt(child.style.fontWeight, 10) >= 600)) st.bold = true;
        if (child.hasAttribute && child.hasAttribute('data-italic')) st.italic = child.getAttribute('data-italic') === '1';
        else if (child.style && child.style.fontStyle === 'italic') st.italic = true;
        if (child.hasAttribute && child.hasAttribute('data-underline')) st.underline = child.getAttribute('data-underline') === '1';
        else if (child.style && /underline/.test(child.style.textDecoration || '')) st.underline = true;
        // Carry the run's OWN face (PDF.js loadedName) through an edit so each run keeps its real weight.
        const ff = child.style && child.style.fontFamily;
        if (ff) { const tok = ff.split(',')[0].replace(/["']/g, '').trim(); if (tok) st.font = tok; }
        // Carry a partial font/colour change through an edit (data-* markers).
        if (child.hasAttribute && child.hasAttribute('data-family')) st.family = child.getAttribute('data-family') || null;
        if (child.hasAttribute && child.hasAttribute('data-color')) { try { st.color = hexToRgb(child.getAttribute('data-color')); } catch (_) {} }
        if (child.hasAttribute && child.hasAttribute('data-link')) st.link = child.getAttribute('data-link') || null;
        walk(child, st);
      });
    };
    walk(div, { bold: false, italic: false, underline: false });
    const cleaned = runs.map(r => ({ ...r, text: this.cleanEditableText(r.text) })).filter(r => r.text.length);
    return cleaned.length ? cleaned : null;
  },
};
