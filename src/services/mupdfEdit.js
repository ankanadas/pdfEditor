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
import { enumeratePageFonts, extractFontBytes, warmCharsets, stripName } from './mupdfFontEngine.js';

/** Normalise editable-box quirks (nbsp, zero-width, soft-hyphen, control chars) without dropping real
 *  Unicode — every font is embedded full-Unicode (Type0), so curly quotes / em-dash / accents / ₹ all
 *  draw natively. Mirrors edit_ops.py's raw cleaning. */
function normalizeText(s) {
  return String(s)
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')   // nbsp & friends -> space
    .replace(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g, '')           // zero-width / soft hyphen
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');  // control chars (keep \t,\n)
}

// ── byte builder for PDF content streams ──
class Bytes {
  constructor() { this.chunks = []; this.len = 0; }
  _raw(arr) { this.chunks.push(arr); this.len += arr.length; }
  op(str) { const a = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff; this._raw(a); }
  /** A PDF hex string `<…>` of 2-byte glyph ids (Type0/Identity fonts). */
  glyphString(hex) { this.op('<' + hex + '>'); }
  build() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
  get empty() { return this.len === 0; }
}

const f2 = (n) => (Math.round(n * 1000) / 1000).toString();   // compact fixed number for ops

// ── colour helpers ──
function parseColor(str, fallback) {
  if (!str || typeof str !== 'string') return fallback;
  const hex = str.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) return [parseInt(hex[1], 16) / 255, parseInt(hex[2], 16) / 255, parseInt(hex[3], 16) / 255];
  const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  return fallback;
}

const rectsIntersect = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
const sameRect = (a, b) => Math.abs(a[0] - b[0]) < 1.5 && Math.abs(a[1] - b[1]) < 1.5 && Math.abs(a[2] - b[2]) < 1.5 && Math.abs(a[3] - b[3]) < 1.5;

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

  // ── Font options ──────────────────────────────────────────────────────────────────────────────
  // Each option = { kind:'simple'|'cid', name, ref, mfont, charset }. Per character we pick the
  // document's OWN embedded font (real outlines) when it drew that character, else a bundled
  // metric-compatible substitute (the catch-all, charset:null). Mirrors fonts.py _resolve_fonts/_pick_font.
  let seq = 0;
  const simpleCache = new Map();   // 'family|b|i'   -> {kind:'simple',name,ref,mfont,charset:null}
  const cidCache = new Map();      // strippedName   -> {kind:'cid',...} | null  (per-doc, reused across pages)
  let _charsets = null;
  const charsets = () => (_charsets || (_charsets = warmCharsets(doc)));

  /** Bundled substitute, embedded full-Unicode (Type0/Identity) — the catch-all. */
  async function bundledOption(family, bold, italic) {
    const key = `${family}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
    if (!simpleCache.has(key)) {
      const mfont = await loadFont(family, bold, italic);
      const ref = doc.addFont(mfont);
      simpleCache.set(key, { name: 'WF' + (seq++), ref, mfont, charset: null });
    }
    return simpleCache.get(key);
  }

  /** Reuse the original line's OWN embedded TrueType (real outlines) — Type0/Identity, drawn by GID. */
  function reusedOption(span, pageFonts) {
    if (!span || !span.fontName) return null;
    const key = stripName(span.fontName);
    if (cidCache.has(key)) return cidCache.get(key);
    let opt = null;
    const info = pageFonts.get(key);
    if (info && info.reusable && info.ff) {
      const bytes = extractFontBytes(info.ff);
      if (bytes) {
        try {
          const mfont = new mupdf.Font(key, bytes);
          const ref = doc.addFont(mfont);
          opt = { kind: 'cid', name: 'RF' + (seq++), ref, mfont, charset: charsets().get(key) || new Set() };
        } catch (_) { opt = null; }
      }
    }
    cidCache.set(key, opt);
    return opt;
  }

  /** Pick the option to draw one code point with (reused-embedded if it drew it, else catch-all). */
  function pickOption(cp, opts) {
    if (cp === 0x20) { for (const o of opts) if (o.charset === null) return o; return opts[opts.length - 1]; }
    const ch = String.fromCodePoint(cp);
    for (const o of opts) {
      if (o.charset === null) return o;                                   // catch-all (always last)
      if (o.charset.has(ch)) { try { if (o.mfont.encodeCharacter(cp) !== 0) return o; } catch (_) {} }
    }
    return opts[opts.length - 1];
  }

  // Per-character draw unit (every font is Type0/Identity): a 4-hex glyph id + the glyph advance.
  function unitFor(opt, cp) {
    let g = 0; try { g = opt.mfont.encodeCharacter(cp) & 0xffff; } catch (_) {}
    let adv = 0; try { adv = opt.mfont.advanceGlyph(g); } catch (_) {}
    return { hex: g.toString(16).padStart(4, '0'), adv };
  }
  function measureRun(text, opts, size) {
    let w = 0;
    for (const ch of text) { const cp = ch.codePointAt(0); w += unitFor(pickOption(cp, opts), cp).adv; }
    return w * size;
  }
  /** Split text into maximal same-font segments, each with its hex glyph-id string. */
  function segmentByFont(text, opts) {
    const segs = [];
    let cur = null;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const o = pickOption(cp, opts);
      if (!cur || cur.opt !== o) { cur = { opt: o, units: [] }; segs.push(cur); }
      cur.units.push(unitFor(o, cp));
    }
    for (const s of segs) s.hex = s.units.map(u => u.hex).join('');
    return segs;
  }
  const measureSeg = (seg, size) => seg.units.reduce((w, u) => w + u.adv, 0) * size;

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
    const pageFonts = enumeratePageFonts(page);   // for embedded-font reuse lookup
    for (const e of pageEdits) {
      if (e.redact === false) continue;
      e._span = detectSpan(analysis, +(e.x || 0), +(e.baseline || 0));
    }

    // Capture external hyperlinks BEFORE redaction — applyRedactions drops links overlapping an
    // edited line, so we re-add the dropped ones after re-inserting (keeps an edited footer/email
    // clickable). Mirrors edit_ops.py saved_links.
    let savedLinks = [];
    try {
      savedLinks = page.getLinks()
        .filter((l) => { try { return l.isExternal() && l.getURI(); } catch (_) { return false; } })
        .map((l) => ({ rect: l.getBounds(), uri: l.getURI() }));
    } catch (_) {}

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

      // Foradian rupee convention: some Indian-bill Type1 fonts put ₹ in the grave-accent slot, so it
      // extracts/edits as a backtick. On a REPLACE of such an (unreusable, embedded) line, map ` → ₹ so
      // the symbol survives when redrawn with the now-full-Unicode fallback. Scoped to those fonts only.
      const graveRupee = !isInsert && sp && (() => {
        const i = pageFonts.get(stripName(sp.fontName || ''));
        return i && i.ff && !i.reusable;
      })();
      const prep = (t) => { const n = normalizeText(t || ''); return graveRupee ? n.replace(/`/g, '₹') : n; };

      // Line model from runs, else the plain text (insert can be multi-line; replace is one line).
      const hasRuns = Array.isArray(e.runs) && e.runs.length;
      const lineModel = hasRuns
        ? e.runs.map(ln => (ln || []).map(r => ({
            text: prep(r.text), size: r.size || boxSize,
            bold: !!r.bold, italic: !!r.italic, underline: !!r.underline || boxUnderline,
            color: parseColor(r.color, null) || defColor })))
        : (isInsert
            ? prep(e.newText).split(/\r\n?|\n/).map(l => [{ text: l, size: boxSize, bold: wantBold, italic: wantItalic, underline: boxUnderline, color: defColor }])
            : [[{ text: prep(e.newText).replace(/[\r\n]+/g, ' '), size: boxSize, bold: wantBold, italic: wantItalic, underline: boxUnderline, color: defColor }]]);

      if (!lineModel.some(parts => parts.some(r => r.text))) continue;

      // Reuse the original line's OWN embedded font (real outlines) for the characters it drew; the
      // bundled substitute is the per-run catch-all. Reuse only when the run's weight/slant matches the
      // detected original (so an italic run on a non-italic original still gets a proper italic).
      const reused = (!isInsert && sp) ? reusedOption(sp, pageFonts) : null;
      for (const parts of lineModel) for (const r of parts) {
        const bundled = await bundledOption(family, r.bold, r.italic);
        const useReused = reused && sp && r.bold === sp.bold && r.italic === sp.italic;
        r._opts = useReused ? [reused, bundled] : [bundled];
      }

      // Overflow: if the widest line exceeds the space to the right margin, scale every run down.
      const avail = pw - x - 4;
      if (avail > 8) {
        let widest = 0;
        for (const parts of lineModel) widest = Math.max(widest, parts.reduce((w, r) => w + measureRun(r.text, r._opts, r.size), 0));
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
          // Split the run into maximal same-font segments (per-character pick), drawing each with the
          // right encoding: a hex glyph-id string for a reused Type0 font, a WinAnsi literal otherwise.
          for (const seg of segmentByFont(r.text, r._opts)) {
            usedFonts.add(seg.opt);
            const px = lx + adv * cos, pyTop = lyTop + adv * sin;
            const py = ph - pyTop;
            ops.op('q BT /' + seg.opt.name + ' ' + f2(r.size) + ' Tf ' + f2(r.color[0]) + ' ' + f2(r.color[1]) + ' ' + f2(r.color[2]) + ' rg ');
            ops.op(rot ? `${f2(cos)} ${f2(sin)} ${f2(-sin)} ${f2(cos)} ${f2(px)} ${f2(py)} Tm ` : `1 0 0 1 ${f2(px)} ${f2(py)} Tm `);
            ops.glyphString(seg.hex);
            ops.op(' Tj ET Q\n');
            const w = measureSeg(seg, r.size);
            if (r.underline && !rot) {
              const ut = Math.max(0.4, r.size * 0.06), uy = py - r.size * 0.12;
              ops.op(`q ${f2(r.color[0])} ${f2(r.color[1])} ${f2(r.color[2])} rg ${f2(px)} ${f2(uy - ut)} ${f2(w)} ${f2(ut)} re f Q\n`);
            }
            adv += w;
          }
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

    // Hyperlinks: place user-added links over their edited text, then restore any saved link that
    // redaction dropped (overlapped a redacted rect, isn't a user-managed area, and isn't still present).
    const managedRects = [];
    for (const e of pageEdits) {
      const link = e.link && typeof e.link === 'object' ? e.link : null;
      if (link && link.uri && !e.linkRemoved) {
        const lr = [+(e.x || 0), +(e.top || 0), +(e.right || e.x || 0), +(e.bottom || e.top || 0)];
        managedRects.push(lr);
        try { page.createLink(lr, link.uri); } catch (_) {}
      }
    }
    if (savedLinks.length && redactRects.length) {
      let current = [];
      try { current = page.getLinks().map((l) => l.getBounds()); } catch (_) {}
      for (const s of savedLinks) {
        if (!redactRects.some((rr) => rectsIntersect(s.rect, rr))) continue;   // wasn't in a redacted area
        if (managedRects.some((m) => rectsIntersect(s.rect, m))) continue;     // user manages this area
        if (current.some((c) => sameRect(c, s.rect))) continue;               // survived redaction
        try { page.createLink(s.rect, s.uri); } catch (_) {}
      }
    }
  }

  // ── Native annotations (highlights, shapes, freehand, tables) ──
  applyAnnotations(mupdf, doc, annotations);

  // Subset every embedded font down to the glyphs actually used (we embed full TTFs for Unicode
  // coverage), so the output stays small. Best-effort — never fail the save over it.
  try { doc.subsetFonts(); } catch (_) {}
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
