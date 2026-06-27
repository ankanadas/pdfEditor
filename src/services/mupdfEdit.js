// Phase 1b WASM edit tier — applies the frontend's text edits + Fabric annotations to a PDF entirely
// in the browser via mupdf-wasm. Runs INSIDE the worker (mupdf already loaded). It sits BELOW the
// backend in the save chain, so it only runs when the backend is unavailable; until full font parity
// (Phases 2-3) it DECLINES (throws) on anything it can't do faithfully so the chain falls through to
// the pdf-lib tier — never a silent fidelity loss.
//
// Key advantage over the pdf-lib tier: REPLACE edits use real redaction (true text removal, keeping
// background/line-art) instead of painting a white cover box — so the result is clean for copy/ATS.
// Text re-insert mirrors the pdf-lib tier's layout (bundled WinAnsi fonts, left-anchored, overflow
// scaling, multi-line, runs, rotation, underline). Native annotations use real PDF annotation objects.
//
// Font loading is injected (`loadFont(family,bold,italic) → Promise<mupdf.Font>`) so this module is
// engine-pure and testable in Node — the worker supplies a fetch-based loader (see mupdfFonts.js).
import { analyzePage, detectSpan } from './mupdfSpans.js';

// ── CP1252 / WinAnsi encoding (simple fonts only encode this set, like the pdf-lib StandardFonts) ──
const CP1252_HIGH = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91,
  0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98,
  0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
};
/** Map one code point to a WinAnsi byte, or 0x3F ('?') if unrepresentable. */
function winAnsiByte(cp) {
  if (cp === 0x09) return 0x20;                 // tab → space
  if (cp >= 0x20 && cp <= 0x7E) return cp;       // ASCII
  if (cp >= 0xA0 && cp <= 0xFF) return cp;       // Latin-1 upper
  return CP1252_HIGH[cp] || 0x3F;
}
/** Sanitise to a string of only WinAnsi-encodable chars (matches what we actually draw + measure). */
function sanitizeWinAnsi(s) {
  let out = '';
  for (const ch of String(s)) out += String.fromCharCode(winAnsiByte(ch.codePointAt(0)));
  return out;
}

// ── byte builder: PDF content streams mix ASCII operators with (possibly high-byte) text strings ──
class Bytes {
  constructor() { this.chunks = []; this.len = 0; }
  _raw(arr) { this.chunks.push(arr); this.len += arr.length; }
  op(str) { const a = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff; this._raw(a); }
  /** A PDF literal string `(…)` from already-WinAnsi-sanitised text, escaping ()\ . */
  textString(sanitized) {
    const bytes = [0x28];
    for (const ch of sanitized) {
      const b = ch.charCodeAt(0);
      if (b === 0x28 || b === 0x29 || b === 0x5C) bytes.push(0x5C);
      bytes.push(b);
    }
    bytes.push(0x29);
    this._raw(Uint8Array.from(bytes));
  }
  build() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  get empty() { return this.len === 0; }
}

const f2 = (n) => (Math.round(n * 1000) / 1000).toString();   // compact fixed number for ops

/** Width of a WinAnsi-sanitised string at `size`, in points, via the font's own advances. */
function measure(font, sanitized, size) {
  let w = 0;
  for (const ch of sanitized) {
    try { w += font.advanceGlyph(font.encodeCharacter(ch.charCodeAt(0))); } catch (_) {}
  }
  return w * size;
}

// ── colour helpers ──
function parseColor(str, fallback) {
  if (!str || typeof str !== 'string') return fallback;
  const hex = str.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) return [parseInt(hex[1], 16) / 255, parseInt(hex[2], 16) / 255, parseInt(hex[3], 16) / 255];
  const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  return fallback;
}

/** Append `stream` to a page's /Contents (normalise single-stream → array, then push). */
function appendContents(doc, pageObj, stream) {
  let contents = pageObj.get('Contents');
  if (!contents || contents.isNull()) { pageObj.put('Contents', stream); return; }
  if (contents.isArray()) { contents.push(stream); return; }
  const arr = doc.newArray();
  arr.push(contents);
  arr.push(stream);
  pageObj.put('Contents', arr);
}

/**
 * Apply edits + annotations to `doc` in place and return the saved bytes (a standalone Uint8Array).
 * @param loadFont async (family,bold,italic) → mupdf.Font (injected; worker fetches, tests read disk)
 * @throws if it encounters an edit it can't do faithfully yet (caller falls through to pdf-lib).
 */
export async function applyEdits(mupdf, doc, data, loadFont) {
  const edits = data.edits || [];
  const annotations = data.annotations || [];

  // Decline (→ pdf-lib) on edit kinds Phase 1b doesn't faithfully support: signature/stamp IMAGES and
  // typed cursive signatures (no script font shipped yet). All-or-nothing keeps output correct.
  for (const e of edits) {
    if (e.kind === 'image' || e.style === 'signature') {
      throw new Error('wasm-edit declined: image/signature edit (deferred to pdf-lib)');
    }
  }

  // Embedded simple fonts, deduped per (family,bold,italic) across the whole doc.
  const embedded = new Map();   // key -> { name, ref, font }
  let seq = 0;
  async function fontFor(family, bold, italic) {
    const key = `${family}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
    if (!embedded.has(key)) {
      const font = await loadFont(family, bold, italic);
      const ref = doc.addSimpleFont(font, 'Latin');
      embedded.set(key, { name: 'WF' + (seq++), ref, font });
    }
    return embedded.get(key);
  }
  const familyOf = (e) => (e.fontFamily === 'serif' || (e.fontFamily == null && e.serif)) ? 'serif'
    : e.fontFamily === 'mono' ? 'mono' : 'sans';

  // Group edits by page.
  const byPage = new Map();
  for (const e of edits) { const p = e.pageIndex | 0; if (!byPage.has(p)) byPage.set(p, []); byPage.get(p).push(e); }

  for (const [pageNum, pageEdits] of byPage) {
    if (pageNum < 0 || pageNum >= doc.countPages()) continue;
    const page = doc.loadPage(pageNum);
    const b = page.getBounds();
    const pw = b[2] - b[0], ph = b[3] - b[1];

    // 0) Detect each replace edit's ORIGINAL span (size/colour/family/weight) BEFORE redaction removes
    //    it, so the replacement matches the original instead of the frontend's geometric guesses.
    const analysis = analyzePage(page);
    for (const e of pageEdits) {
      if (e.redact === false) continue;
      e._span = detectSpan(analysis, +(e.x || 0), +(e.baseline || 0));
    }

    // 1) Redact the original text of REPLACE edits (true removal), keeping images + line-art so a
    //    coloured/shaded cell or border behind the text survives — no white cover box (the win over
    //    pdf-lib). Insert-only edits (added text) set redact:false and aren't redacted.
    const redactRects = [];
    for (const e of pageEdits) {
      if (e.redact === false) continue;
      const x = +(e.x || 0), top = +(e.top || 0), bottom = +(e.bottom || 0), right = +(e.right || x);
      const rect = [Math.max(0, x - 2), Math.max(0, top - 1), Math.min(pw, Math.max(right, x + 2) + 2), Math.min(ph, bottom + 1)];
      const a = page.createAnnotation('Redact');
      a.setRect(rect);
      redactRects.push(rect);
    }
    if (redactRects.length) {
      page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
    }

    const ops = new Bytes();
    const usedFonts = new Set();   // embedded entries to register in this page's Resources

    // 1b) Erase tool: white-out the region (text already redacted above). And underline-cover strips:
    //     because we keep line-art, an existing underline survives redaction — cover it with the line's
    //     background before the fresh underline is drawn (only for underlined / coverUnderline edits).
    for (const e of pageEdits) {
      if (e.kind === 'erase') {
        const x = +(e.x || 0), top = +(e.top || 0), bottom = +(e.bottom || 0), right = +(e.right || x);
        ops.op(`q 1 1 1 rg ${f2(x - 2)} ${f2(ph - bottom - 1)} ${f2((right - x) + 4)} ${f2((bottom - top) + 2)} re f Q\n`);
        continue;
      }
      if (e.redact === false) continue;
      const hasUl = !!e.underline || (e.runs || []).some(ln => (ln || []).some(r => r && r.underline));
      if (!hasUl && !e.coverUnderline) continue;
      const ex = +(e.x || 0), er = +(e.right || ex), eb = +(e.baseline || 0), ebot = +(e.bottom || eb);
      const fs = +(e.fontSize || 12) || 12;
      const yTop = ph - Math.min(ph, Math.max(ebot, eb + fs * 0.30) + 1);
      const yBot = ph - (eb + fs * 0.02);
      const bg = Array.isArray(e.bgColor) && e.bgColor.length >= 3
        ? [e.bgColor[0] / 255, e.bgColor[1] / 255, e.bgColor[2] / 255] : [1, 1, 1];
      ops.op(`q ${f2(bg[0])} ${f2(bg[1])} ${f2(bg[2])} rg ${f2(ex - 1)} ${f2(yTop)} ${f2((er + 1) - (ex - 1))} ${f2(yBot - yTop)} re f Q\n`);
    }

    // 2) Re-insert text. Build a per-line model [[{text,size,bold,italic,underline,color}]…], scale to
    //    fit the available width, then draw each run with its font at the baseline (rotated if asked).
    for (const e of pageEdits) {
      const isInsert = e.redact === false;
      const x = +(e.x || 0), baseline = +(e.baseline || 0);
      const sp = e._span;   // detected original style (replace edits only)
      // Family: an explicit toolbar/family choice wins; else the detected original family; else the
      // frontend's serif guess.
      const family = e.fontFamily != null ? familyOf(e) : (sp ? sp.family : familyOf(e));
      // Size: keep the original's exact size by default (the frontend's geometric guess runs big); an
      // explicit toolbar size change (sizeOverride) or added text uses the frontend size.
      let boxSize = +(e.fontSize || 12) || 12;
      if (sp && sp.size && !e.sizeOverride && !isInsert) boxSize = sp.size;
      // Weight/slant: union the frontend flag with the detected original (only ADDS — never un-bolds a
      // correct line), recovering a bold heading on a non-embedded standard font the frontend missed.
      let wantBold = !!e.bold, wantItalic = !!e.italic;
      if (sp && !isInsert) { wantBold = wantBold || sp.bold; wantItalic = wantItalic || sp.italic; }
      const boxColor = parseColor(e.color, null);
      // Colour: an explicit toolbar colour wins; else the original span's colour (white-on-dark); added
      // text stays black.
      const defColor = boxColor || ((sp && !isInsert) ? sp.color : [0, 0, 0]);
      const boxUnderline = !!e.underline;
      const rot = +(e.rotation || 0) || 0;

      // Line model from runs, else the plain text (insert can be multi-line; replace is one line).
      const hasRuns = Array.isArray(e.runs) && e.runs.length;
      const lineModel = hasRuns
        ? e.runs.map(ln => (ln || []).map(r => ({
            text: sanitizeWinAnsi(r.text || ''), size: r.size || boxSize,
            bold: !!r.bold, italic: !!r.italic, underline: !!r.underline || boxUnderline,
            color: parseColor(r.color, null) || defColor })))
        : (isInsert
            ? String(e.newText || '').split(/\r\n?|\n/).map(l => [{ text: sanitizeWinAnsi(l), size: boxSize, bold: wantBold, italic: wantItalic, underline: boxUnderline, color: defColor }])
            : [[{ text: sanitizeWinAnsi(String(e.newText || '').replace(/[\r\n]+/g, ' ')), size: boxSize, bold: wantBold, italic: wantItalic, underline: boxUnderline, color: defColor }]]);

      if (!lineModel.some(parts => parts.some(r => r.text))) continue;

      // Resolve the font for every run up front (async), keyed by variant.
      for (const parts of lineModel) for (const r of parts) r._f = await fontFor(family, r.bold, r.italic);

      // Overflow: if the widest line exceeds the space to the right margin, scale every run down.
      const avail = pw - x - 4;
      if (avail > 8) {
        let widest = 0;
        for (const parts of lineModel) widest = Math.max(widest, parts.reduce((w, r) => w + measure(r._f, r.text, r.size), 0));
        if (widest > avail) {
          const s = Math.max(0.05, avail / widest);
          for (const parts of lineModel) for (const r of parts) r.size = Math.max(4, r.size * s);
        }
      }

      const rad = rot * Math.PI / 180;
      const cos = Math.cos(-rad), sin = Math.sin(-rad);   // CSS clockwise → PDF (negate)
      let drop = 0, prevMax = null;
      for (const parts of lineModel) {
        const thisMax = Math.max(4, ...parts.map(r => r.size));
        if (prevMax !== null) drop += Math.max(prevMax, thisMax) * 1.2;
        prevMax = thisMax;
        // Line origin (top-left coords) dropped down the page, then flipped to PDF bottom-left.
        const lx = x + (rot ? -drop * Math.sin(rad) : 0);
        const lyTop = baseline + (rot ? drop * Math.cos(rad) : drop);
        let adv = 0;
        for (const r of parts) {
          if (!r.text) continue;
          const px = lx + adv * cos, pyTop = lyTop + adv * sin;
          const py = ph - pyTop;
          const fEntry = r._f;
          const fam = embedded.get(`${family}|${r.bold ? 1 : 0}|${r.italic ? 1 : 0}`);
          usedFonts.add(fam);
          ops.op('q BT /' + fam.name + ' ' + f2(r.size) + ' Tf ' + f2(r.color[0]) + ' ' + f2(r.color[1]) + ' ' + f2(r.color[2]) + ' rg ');
          if (rot) ops.op(`${f2(cos)} ${f2(sin)} ${f2(-sin)} ${f2(cos)} ${f2(px)} ${f2(py)} Tm `);
          else ops.op(`1 0 0 1 ${f2(px)} ${f2(py)} Tm `);
          ops.textString(r.text);
          ops.op(' Tj ET Q\n');
          const w = measure(fEntry, r.text, r.size);
          if (r.underline) {
            const ut = Math.max(0.4, r.size * 0.06);
            const uy = py - r.size * 0.12;
            // underline drawn in the run's own (unrotated) frame for simplicity
            if (!rot) ops.op(`q ${f2(r.color[0])} ${f2(r.color[1])} ${f2(r.color[2])} rg ${f2(px)} ${f2(uy - ut)} ${f2(w)} ${f2(ut)} re f Q\n`);
          }
          adv += w;
        }
      }
    }

    // Register used fonts in the page Resources, then append the content stream.
    if (!ops.empty) {
      const pageObj = page.getObject();
      let res = pageObj.get('Resources');
      if (!res || res.isNull()) { res = doc.newDictionary(); pageObj.put('Resources', res); }
      let fdict = res.get('Font');
      if (!fdict || fdict.isNull()) { fdict = doc.newDictionary(); res.put('Font', fdict); }
      for (const fam of usedFonts) fdict.put(fam.name, fam.ref);
      const stream = doc.addStream(ops.build(), doc.newDictionary());
      appendContents(doc, pageObj, stream);
    }
  }

  // ── Native annotations (highlights, shapes, freehand, tables) ──
  applyAnnotations(mupdf, doc, annotations);

  return doc.saveToBuffer('compress').asUint8Array().slice();
}

function applyAnnotations(mupdf, doc, annotations) {
  for (const ann of annotations) {
    try {
      const pageNum = ann.pageIndex | 0;
      if (pageNum < 0 || pageNum >= doc.countPages()) continue;
      const page = doc.loadPage(pageNum);
      const b = page.getBounds();
      const ph = b[3] - b[1];
      const kind = ann.kind || '';
      const x = +(ann.x || 0), y = +(ann.y || 0), w = +(ann.width || 0), h = +(ann.height || 0);

      if (kind === 'ann-highlight') {
        const top = ph - y - h;
        const rect = [x, top, x + w, ph - y];
        const col = parseColor(ann.fill, [1, 0.84, 0]);
        const a = page.createAnnotation('Highlight');
        a.setQuadPoints([[rect[0], rect[1], rect[2], rect[1], rect[0], rect[3], rect[2], rect[3]]]);
        a.setColor(col);
        a.setOpacity(+(ann.opacity ?? 0.4));
        a.update();

      } else if (kind === 'ann-rect') {
        const a = page.createAnnotation('Square');
        a.setRect([x, ph - y - h, x + w, ph - y]);
        a.setColor(parseColor(ann.stroke, [0, 0, 0]));
        a.setBorderWidth(Math.max(0.5, +(ann.strokeWidth || 1)));
        a.update();

      } else if (kind === 'ann-ellipse') {
        const rx = +(ann.rx || 0), ry = +(ann.ry || 0);
        const cy = ph - +(ann.y || 0);
        const a = page.createAnnotation('Circle');
        a.setRect([x - rx, cy - ry, x + rx, cy + ry]);
        a.setColor(parseColor(ann.stroke, [0, 0, 0]));
        a.setBorderWidth(Math.max(0.5, +(ann.strokeWidth || 1)));
        a.update();

      } else if (kind === 'ann-line') {
        const a = page.createAnnotation('Line');
        a.setLine([+(ann.x1 || 0), ph - +(ann.y1 || 0)], [+(ann.x2 || 0), ph - +(ann.y2 || 0)]);
        a.setColor(parseColor(ann.stroke, [0, 0, 0]));
        a.setBorderWidth(Math.max(0.5, +(ann.strokeWidth || 1)));
        a.update();

      } else if (kind === 'ann-path') {
        const pts = (ann.points || []).filter(p => Array.isArray(p) && p.length >= 2);
        if (pts.length >= 2) {
          const a = page.createAnnotation('Ink');
          a.clearInkList();
          a.addInkListStroke();
          for (const p of pts) a.addInkListStrokeVertex([+p[0], ph - +p[1]]);
          a.setColor(parseColor(ann.stroke, [1, 0.84, 0]));
          a.setBorderWidth(Math.max(0.5, +(ann.strokeWidth || 2)));
          if (ann.isHighlight) a.setOpacity(+(ann.opacity ?? 0.4));
          a.update();
        }

      } else if (kind === 'ann-table') {
        // No native table annotation — stroke the grid as a content stream (rows+1 + cols+1 lines).
        const rows = Math.max(1, ann.rows | 0 || 3), cols = Math.max(1, ann.cols | 0 || 3);
        const col = parseColor(ann.stroke, [0.18, 0.23, 0.36]);
        const sw = +(ann.strokeWidth || 1) || 1;
        const top = ph - y - h;                 // bottom-left origin: lines drawn in PDF space
        const ops = new Bytes();
        ops.op(`q ${f2(col[0])} ${f2(col[1])} ${f2(col[2])} RG ${f2(sw)} w\n`);
        for (let r = 0; r <= rows; r++) { const yy = (ph - top) - h * r / rows; ops.op(`${f2(x)} ${f2(yy)} m ${f2(x + w)} ${f2(yy)} l S\n`); }
        for (let c = 0; c <= cols; c++) { const xx = x + w * c / cols; ops.op(`${f2(xx)} ${f2(ph - top)} m ${f2(xx)} ${f2(ph - top - h)} l S\n`); }
        ops.op('Q\n');
        const pageObj = page.getObject();
        appendContents(doc, pageObj, doc.addStream(ops.build(), doc.newDictionary()));
      }
    } catch (err) {
      // A single bad annotation must not abort the whole save (matches the backend's per-annot guard).
      console.warn('wasm annotation draw error', ann && ann.kind, err && err.message);
    }
  }
}
