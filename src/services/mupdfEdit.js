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
import { analyzePage, detectSpan, detectAlign } from './mupdfSpans.js';
import { enumeratePageFonts, extractFontBytes, warmCharsets, stripName, latexProfile, standardFamily } from './mupdfFontEngine.js';
import { bundledCandidates, stemForName } from './mupdfFonts.js';

/** Normalise editable-box quirks (nbsp, zero-width, soft-hyphen, control chars) without dropping real
 *  Unicode — every font is embedded full-Unicode (Type0), so curly quotes / em-dash / accents / ₹ all
 *  draw natively. Mirrors edit_ops.py's raw cleaning. */
function normalizeText(s) {
  return String(s)
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')   // nbsp & friends -> space
    .replace(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g, '')           // zero-width / soft hyphen
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');  // control chars (keep \t,\n)
}

// ── WinAnsi encoding — used ONLY by the Base-14 re-emit path (a non-embedded standard font is kept as
// name-only Helvetica/Times/Courier, which is a simple WinAnsi font). Reused + bundled fonts are Type0. ──
const CP1252_HIGH = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91,
  0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98,
  0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
};
/** Map one code point to a WinAnsi byte, or 0x3F ('?') if unrepresentable in WinAnsi. */
function winAnsiByte(cp) {
  if (cp === 0x09) return 0x20;
  if (cp >= 0x20 && cp <= 0x7E) return cp;
  if (cp >= 0xA0 && cp <= 0xFF) return cp;
  return CP1252_HIGH[cp] || 0x3F;
}

// ── byte builder for PDF content streams ──
class Bytes {
  constructor() { this.chunks = []; this.len = 0; }
  _raw(arr) { this.chunks.push(arr); this.len += arr.length; }
  op(str) { const a = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff; this._raw(a); }
  /** A PDF hex string `<…>` of 2-byte glyph ids (Type0/Identity fonts). */
  glyphString(hex) { this.op('<' + hex + '>'); }
  /** A PDF literal string `(…)` of WinAnsi bytes (Base-14 simple fonts), escaping ()\ . */
  textString(bytes) {
    const out = [0x28];
    for (const b of bytes) { if (b === 0x28 || b === 0x29 || b === 0x5C) out.push(0x5C); out.push(b); }
    out.push(0x29);
    this._raw(Uint8Array.from(out));
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

// Added text in a standard-equivalent family → the Base-14 standard font (name-only), so adding bold
// text looks IDENTICAL to editing a standard line bold (both Helvetica-Bold), not Helvetica vs Arimo.
// ONLY the TRUE Base-14 standards belong here (they're spec-guaranteed name-only in every viewer). A
// NON-standard family — proprietary (Calibri/Georgia/Roboto…) OR a Windows sans/mono we don't truly have
// (Verdana/Tahoma/Trebuchet/Consolas) — keeps its bundled OPEN clone instead: a consistent embedded face
// renders the same everywhere, vs a name-only Base-14 substitute that varies per viewer.
const ADD_B14 = { sans: 'sans', serif: 'serif', mono: 'mono', arial: 'sans', helvetica: 'sans',
  times: 'serif', courier: 'mono' };

// ── colour helpers ── accepts what the frontend actually sends: an [r,g,b] ARRAY (0-255 or already
// 0-1) OR a '#rrggbb' / 'rgb()/rgba()' string. (Mirrors backend _parse_color. The array form is the
// one Add-text / the toolbar colour picker uses — missing it made coloured added text save as black.)
function parseColor(c, fallback) {
  if (c == null) return fallback;
  if (Array.isArray(c) && c.length >= 3) {
    let [r, g, b] = c.map(Number);
    if ([r, g, b].some(Number.isNaN)) return fallback;
    if (Math.max(r, g, b) > 1.0001) { r /= 255; g /= 255; b /= 255; }  // 0-255 ints → 0-1
    return [r, g, b];
  }
  if (typeof c === 'string') {
    const hex = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (hex) return [parseInt(hex[1], 16) / 255, parseInt(hex[2], 16) / 255, parseInt(hex[3], 16) / 255];
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (m) return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
  }
  return fallback;
}

// ToUnicode repair (port of text_runs.py _clean_tounicode): the engine writes inter-word spaces into a
// font's ToUnicode CMap as U+00A0 (nbsp), and the hyphen as U+00AD (soft hyphen) — both render fine but
// make the edited text COPY/EXTRACT/SEARCH as "unreadable unicode" (e.g. "To\xa0Whom\xa0It"). Rewrite
// those bfchar/bfrange DESTINATIONS back to plain space / hyphen. Length-preserving (4 hex → 4 hex).
// CRITICAL: we patch each CMap STREAM OBJECT in place via readStream()/writeStream() — NOT a whole-file
// byte pass. saveToBuffer('decompress') does NOT expose CMap streams as plaintext (they stay flate-coded),
// so the old byte approach was a silent no-op; the object API decompresses on read and re-stores on write.
function cleanCMapText(s) {
  // Length-preserving. CRITICAL: consume EVERY pair/triple (not just the 00a0 ones) so we never mis-align
  // a SOURCE code as a destination — matching only the 00a0 ones shifts the regex onto a following source
  // and corrupts unrelated mappings (the roboto-gibberish bug).
  const fixDst = (dst) => { const d = dst.toLowerCase(); return d === '00a0' ? '0020' : d === '00ad' ? '002d' : dst; };
  s = s.replace(/beginbfchar[\s\S]*?endbfchar/g, (blk) =>          // bfchar:  <src> <dst>  → fix dst
    blk.replace(/(<[0-9a-fA-F]+>)(\s*)<([0-9a-fA-F]{4})>/g, (m, src, ws, dst) => `${src}${ws}<${fixDst(dst)}>`));
  s = s.replace(/beginbfrange[\s\S]*?endbfrange/g, (blk) =>        // bfrange: <lo> <hi> <dst>  → fix dst
    blk.replace(/(<[0-9a-fA-F]+>)(\s*)(<[0-9a-fA-F]+>)(\s*)<([0-9a-fA-F]{4})>/g, (m, lo, w1, hi, w2, dst) => `${lo}${w1}${hi}${w2}<${fixDst(dst)}>`));
  return s;
}
function repairToUnicode(doc) {
  const dec = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };   // latin1
  const enc = (s) => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 0xff; return o; };
  const seen = new Set();
  const patchFont = (fontDict) => {
    if (!fontDict || fontDict.isNull()) return;
    const tu = fontDict.get('ToUnicode');
    if (!tu || tu.isNull() || !(tu.isStream && tu.isStream())) return;
    let key; try { key = tu.toString(); } catch (_) { key = null; }
    if (key) { if (seen.has(key)) return; seen.add(key); }
    let s; try { s = dec(tu.readStream().asUint8Array()); } catch (_) { return; }
    if (s.indexOf('beginbfchar') < 0 && s.indexOf('beginbfrange') < 0) return;
    const c = cleanCMapText(s);
    if (c !== s) { try { tu.writeStream(enc(c)); } catch (_) {} }
  };
  const n = doc.countPages();
  for (let p = 0; p < n; p++) {
    let res; try { res = doc.loadPage(p).getObject().get('Resources'); } catch (_) { continue; }
    if (!res || res.isNull()) continue;
    const fonts = res.get('Font');
    if (!fonts || fonts.isNull()) continue;
    try { fonts.forEach((val) => patchFont(val)); } catch (_) {}
  }
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

  // Fonts are embedded LAZILY — `embed(opt)` runs addFont/addSimpleFont only when a glyph actually uses
  // the option, so an option we build but never draw with (e.g. the bundled catch-all when the original
  // is fully reused) never bloats the output with an unused font.
  function embed(opt) {
    if (opt.ref == null) opt.ref = opt.simple ? doc.addSimpleFont(opt.mfont, 'Latin') : doc.addFont(opt.mfont);
    return opt;
  }

  /** Bundled substitute, embedded full-Unicode (Type0/Identity) — the catch-all. `spec` selects the
   *  family: an explicit toolbar key, a LaTeX profile, or the generic sans/serif/mono. */
  async function bundledOption(spec, bold, italic) {
    const candidates = bundledCandidates(spec, bold, italic);
    const key = candidates[0] + '|' + (bold ? 1 : 0) + '|' + (italic ? 1 : 0);
    if (!simpleCache.has(key)) {
      const mfont = await loadFont(candidates);
      simpleCache.set(key, { name: 'WF' + (seq++), ref: null, simple: false, mfont, charset: null });
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
          opt = { kind: 'cid', name: 'RF' + (seq++), ref: null, simple: false, mfont, charset: charsets().get(key) || new Set() };
        } catch (_) { opt = null; }
      }
    }
    cidCache.set(key, opt);
    return opt;
  }

  // Base-14 re-emit: a NON-embedded standard font (Helvetica/Times/Courier) is kept under its own name
  // (name-only, not embedded) so a 'Helvetica-Bold' heading saves back as Helvetica-Bold — NOT a
  // substituted, embedded Arial. It's a simple WinAnsi font (mirrors fonts.py level-2 Base-14 re-emit).
  const B14 = {
    sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
    serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
    mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
  };
  function base14Option(family, bold, italic) {
    const name = (B14[family] || B14.sans)[(bold ? 1 : 0) + (italic ? 2 : 0)];
    const key = 'b14:' + name;
    if (!simpleCache.has(key)) {
      const mfont = new mupdf.Font(name);
      simpleCache.set(key, { kind: 'simple', winAnsi: true, simple: true, name: 'WF' + (seq++), ref: null, mfont, charset: null });
    }
    return simpleCache.get(key);
  }

  /** Pick the option to draw one code point with. Order: reused-embedded (drew it AND has the glyph) →
   *  Base-14 (WinAnsi) → bundled catch-all (Type0, full Unicode). The encodeCharacter≠0 guard means a
   *  reused subset font keeps a character (incl. space) only when it really has that glyph — so we never
   *  embed a bundled substitute just to draw a space the original font could draw itself. */
  function pickOption(cp, opts) {
    const ch = String.fromCodePoint(cp);
    for (const o of opts) {
      if (o.charset !== null) {                                            // reused embedded (has a charset)
        if (o.charset.has(ch)) { try { if (o.mfont.encodeCharacter(cp) !== 0) return o; } catch (_) {} }
      } else if (o.winAnsi) {                                             // Base-14 (WinAnsi only)
        if (cp === 0x3F || winAnsiByte(cp) !== 0x3F) return o;
      } else {
        return o;                                                         // bundled catch-all (Type0)
      }
    }
    return opts[opts.length - 1];
  }

  // Per-character draw unit: WinAnsi byte for a Base-14 simple font, else a 4-hex glyph id (Type0).
  function unitFor(opt, cp) {
    if (opt.winAnsi) {
      const b = winAnsiByte(cp);
      let adv = 0; try { adv = opt.mfont.advanceGlyph(opt.mfont.encodeCharacter(b)); } catch (_) {}
      return { byte: b, adv };
    }
    let g = 0; try { g = opt.mfont.encodeCharacter(cp) & 0xffff; } catch (_) {}
    let adv = 0; try { adv = opt.mfont.advanceGlyph(g); } catch (_) {}
    return { hex: g.toString(16).padStart(4, '0'), adv };
  }
  function measureRun(text, opts, size) {
    let w = 0;
    for (const ch of text) { const cp = ch.codePointAt(0); w += unitFor(pickOption(cp, opts), cp).adv; }
    return w * size;
  }
  /** Split text into maximal same-font segments; each carries either a hex glyph string or WinAnsi bytes. */
  function segmentByFont(text, opts) {
    const segs = [];
    let cur = null;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const o = pickOption(cp, opts);
      if (!cur || cur.opt !== o) { cur = { opt: o, units: [] }; segs.push(cur); }
      cur.units.push(unitFor(o, cp));
    }
    for (const s of segs) {
      if (s.opt.winAnsi) s.bytes = s.units.map(u => u.byte);
      else s.hex = s.units.map(u => u.hex).join('');
    }
    return segs;
  }
  const measureSeg = (seg, size) => seg.units.reduce((w, u) => w + u.adv, 0) * size;

  // Group edits by page.
  const byPage = new Map();
  for (const e of edits) { const p = e.pageIndex | 0; if (!byPage.has(p)) byPage.set(p, []); byPage.get(p).push(e); }

  // Warm every font's drawn-character set from the ORIGINAL doc NOW — BEFORE any page is redacted.
  // Redaction removes an edited line's text, so building charsets afterwards would make the line's OWN
  // glyphs look undrawable by their own font and scatter them to the bundled substitute (the
  // "edited footer word turns to Arial" bug). Only needed when there's a replace edit.
  if (edits.some((e) => e.redact !== false && e.kind !== 'image')) charsets();

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
    const usedEgs = new Map();     // opacity → { name, dict } ExtGStates to register in this page
    let egsSeq = 0;
    // An ExtGState that sets fill+stroke alpha, so semi-transparent ("faded") edited/added text renders
    // translucent (the toolbar opacity control). Deduped per opacity value per page.
    const egsFor = (op) => {
      let e = usedEgs.get(op);
      if (!e) {
        const d = doc.newDictionary();
        d.put('Type', doc.newName('ExtGState'));
        d.put('ca', doc.newReal ? doc.newReal(op) : op);
        d.put('CA', doc.newReal ? doc.newReal(op) : op);
        e = { name: 'GS' + (egsSeq++), dict: d };
        usedEgs.set(op, e);
      }
      return e;
    };

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
      // Bundled-font selection: an explicit toolbar family (Arial/Calibri/Georgia/…) wins; else a LaTeX
      // original blends with the matching open LaTeX face (Latin Modern / TeX Gyre); else the generic
      // family (detected from the original, or the frontend's serif/mono guess).
      let bundleSpec;
      if (e.fontFamily != null) {
        bundleSpec = { key: String(e.fontFamily).toLowerCase() };
      } else {
        const lp = (!isInsert && sp && sp.fontName) ? latexProfile(sp.fontName) : null;
        // If the original embedded font is a family we ship (e.g. Carlito/Caladea), substitute the SAME
        // bundled face when we can't reuse it — visually identical, not a generic Arimo/Tinos.
        const stem = (!isInsert && sp && sp.fontName) ? stemForName(sp.fontName) : null;
        const family = sp ? sp.family : (e.serif ? 'serif' : 'sans');
        bundleSpec = lp ? { latex: lp } : stem ? { stem, family } : { family };
      }
      // Size: keep the original's exact size by default (the frontend's geometric guess runs big); an
      // explicit toolbar size change (sizeOverride) or added text uses the frontend size.
      let boxSize = +(e.fontSize || 12) || 12;
      if (sp && sp.size && !e.sizeOverride && !isInsert) boxSize = sp.size;
      // Weight/slant: union the frontend flag with the detected original (only ADDS — never un-bolds a
      // correct line), recovering a bold heading on a non-embedded standard font the frontend missed.
      let wantBold = !!e.bold, wantItalic = !!e.italic;
      // Union with the detected original ONLY recovers a weight/slant the frontend MISSED — never when the
      // user explicitly set it (boldSet/italicSet), so turning a bold/italic line OFF actually sticks.
      if (sp && !isInsert) {
        if (!e.boldSet) wantBold = wantBold || sp.bold;
        if (!e.italicSet) wantItalic = wantItalic || sp.italic;
      }
      const boxOpacity = (typeof e.opacity === 'number' && e.opacity >= 0 && e.opacity < 1) ? e.opacity : 1;
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
            link: (typeof r.link === 'string' && r.link) ? r.link : null,
            fontFamily: (typeof r.fontFamily === 'string' && r.fontFamily) ? r.fontFamily : null,   // partial font change
            color: parseColor(r.color, null) || defColor })))
        : (isInsert
            ? prep(e.newText).split(/\r\n?|\n/).map(l => [{ text: l, size: boxSize, bold: wantBold, italic: wantItalic, underline: boxUnderline, color: defColor }])
            : [[{ text: prep(e.newText).replace(/[\r\n]+/g, ' '), size: boxSize, bold: wantBold, italic: wantItalic, underline: boxUnderline, color: defColor }]]);

      if (!lineModel.some(parts => parts.some(r => r.text))) continue;

      // Primary font for a REPLACE edit: (1) reuse the original's OWN embedded outlines for the chars it
      // drew, else (2) for a NON-embedded standard font with no toolbar override, re-emit Base-14 under
      // its own name (keeps Helvetica as Helvetica, not a substituted Arial). The bundled Type0 substitute
      // is always the per-run catch-all (full Unicode).
      const reused = (!isInsert && sp) ? reusedOption(sp, pageFonts) : null;
      let b14Family = null;
      if (e.fontFamily != null) {
        // EXPLICIT toolbar family that IS a Base-14 standard (Helvetica/Arial→sans, Times→serif,
        // Courier→mono) re-emits the standard font NAME-ONLY — NOT the bundled Arimo/Tinos clone. Without
        // this, picking "Helvetica" from the font picker embeds Arimo, so a save→reopen→pick-Helvetica→save
        // round-trip silently degrades the line to an embedded Arial. A non-standard pick (Georgia,
        // Roboto, …) has no Base-14 equivalent → bundled clone (b14Family stays null). Applies to BOTH
        // editing an existing line and added text (add-bold == edit-bold == Helvetica-Bold).
        b14Family = ADD_B14[String(e.fontFamily).toLowerCase()] || null;
      } else if (isInsert) {
        b14Family = ADD_B14.sans;                                     // added text, no explicit family → Helvetica
      } else if (sp && !reused) {
        const fam = standardFamily(sp.fontName);
        const info = pageFonts.get(stripName(sp.fontName || ''));
        b14Family = (fam && (!info || !info.ff)) ? fam : null;        // editing a non-embedded standard font
      }
      for (const parts of lineModel) for (const r of parts) {
        // A per-run font (partial font change on PART of a line) overrides the box font for THIS run only:
        // derive its own spec/Base-14/reuse exactly like the box-level explicit-family path.
        let rSpec = bundleSpec, rB14 = b14Family, rReused = reused, rExplicit = e.fontFamily != null;
        if (r.fontFamily) { rSpec = { key: String(r.fontFamily).toLowerCase() }; rB14 = ADD_B14[String(r.fontFamily).toLowerCase()] || null; rReused = null; rExplicit = true; }
        const bundled = await bundledOption(rSpec, r.bold, r.italic);
        const opts = [];
        // Reuse the original embedded font only when the user did NOT pick a toolbar font — an explicit
        // family choice (box- or run-level) must win, so it gets the chosen face, not the reused original.
        if (rReused && sp && !rExplicit && r.bold === sp.bold && r.italic === sp.italic) opts.push(rReused);
        else if (rB14) opts.push(base14Option(rB14, r.bold, r.italic));
        opts.push(bundled);
        r._opts = opts;
      }

      // Per-line widths (used for overflow scaling AND alignment re-anchoring).
      const lineWidth = (parts) => parts.reduce((w, r) => w + measureRun(r.text, r._opts, r.size), 0);
      let widths = lineModel.map(lineWidth);
      let widest = Math.max(0, ...widths);
      // Overflow: if the widest line exceeds the space to the right margin, scale every run down.
      const availW = pw - x - 4;
      if (availW > 8 && widest > availW) {
        const s = Math.max(0.05, availW / widest);
        for (const parts of lineModel) for (const r of parts) r.size = Math.max(4, r.size * s);
        widths = lineModel.map(lineWidth);
        widest = Math.max(0, ...widths);
      }

      // Alignment: keep a right-/centre-aligned line anchored when the replacement length differs. An
      // explicit toolbar align wins; else (replace only) detect it from the page layout; else left. A
      // REPLACE re-anchors within the original line box (x .. right); an ADDED box within its widest line.
      const editRight = +(e.right || x);
      const align = (e.align === 'left' || e.align === 'center' || e.align === 'right') ? e.align
        : (!isInsert && sp) ? detectAlign(analysis, x, editRight) : 'left';
      const alignAvail = isInsert ? widest : Math.max(0, editRight - x);

      const rad = rot * Math.PI / 180;
      const cos = Math.cos(-rad), sin = Math.sin(-rad);   // CSS clockwise → PDF (negate)
      // Per-run hyperlink areas: a partial link (a linked run inside a box) gets its OWN clickable rect
      // measured from the drawn glyphs (top-origin), merging contiguous same-uri runs. Mirrors edit_ops.py.
      const runLinkSpans = [];
      let drop = 0, prevMax = null;
      lineModel.forEach((parts, idx) => {
        const thisMax = Math.max(4, ...parts.map(r => r.size));
        if (prevMax !== null) drop += Math.max(prevMax, thisMax) * 1.2;
        prevMax = thisMax;
        // Line origin (top-left), shifted for alignment, then dropped down the page and flipped to PDF.
        const off = align === 'right' ? (alignAvail - widths[idx]) : align === 'center' ? (alignAvail - widths[idx]) / 2 : 0;
        const ax = x + Math.max(0, off);
        const lx = ax + (rot ? -drop * Math.sin(rad) : 0);
        const lyTop = baseline + (rot ? drop * Math.cos(rad) : drop);
        let cur = null;   // [uri, x0, x1, top, bottom] — merge contiguous same-uri runs on this line
        const flush = () => { if (cur) { runLinkSpans.push({ rect: [cur[1], cur[3], cur[2], cur[4]], uri: cur[0] }); cur = null; } };
        let adv = 0;
        for (const r of parts) {
          if (!r.text) continue;
          // Split the run into maximal same-font segments (per-character pick), drawing each with the
          // right encoding: a hex glyph-id string for a reused Type0 font, a WinAnsi literal otherwise.
          for (const seg of segmentByFont(r.text, r._opts)) {
            usedFonts.add(embed(seg.opt));   // embed the font into the doc only now that a glyph uses it
            // Advance each run along the rotated baseline. The text matrix advances glyphs by
            // (adv·cos, adv·sin) in PDF (y-up) space, so in this TOP-origin (y-down) space the run's y
            // moves by -adv·sin. Using +adv·sin scattered the runs ~2·adv·sin apart — a partial-styled
            // ROTATED line (multiple Tj runs) broke into separated words; a single Tj was unaffected.
            const px = lx + adv * cos, pyTop = lyTop - adv * sin;
            const py = ph - pyTop;
            const egs = boxOpacity < 1 ? egsFor(boxOpacity) : null;
            ops.op('q ' + (egs ? '/' + egs.name + ' gs ' : '') + 'BT /' + seg.opt.name + ' ' + f2(r.size) + ' Tf ' + f2(r.color[0]) + ' ' + f2(r.color[1]) + ' ' + f2(r.color[2]) + ' rg ');
            ops.op(rot ? `${f2(cos)} ${f2(sin)} ${f2(-sin)} ${f2(cos)} ${f2(px)} ${f2(py)} Tm ` : `1 0 0 1 ${f2(px)} ${f2(py)} Tm `);
            if (seg.opt.winAnsi) ops.textString(seg.bytes); else ops.glyphString(seg.hex);
            ops.op(' Tj ET Q\n');
            const w = measureSeg(seg, r.size);
            if (r.underline && !rot) {
              // Stroke a LINE just below the baseline (matches the backend's draw_line: width size*0.055,
              // offset size*0.12) so it's a "line" drawing item, not a filled rect.
              const uw = Math.max(0.4, r.size * 0.055), uy = py - r.size * 0.12;
              ops.op(`q ${f2(r.color[0])} ${f2(r.color[1])} ${f2(r.color[2])} RG ${f2(uw)} w ${f2(px)} ${f2(uy)} m ${f2(px + w)} ${f2(uy)} l S Q\n`);
            }
            if (r.link && !rot) {     // accumulate the clickable area for a partially-linked run (top-origin)
              const lt = pyTop - r.size * 0.8, lb = pyTop + r.size * 0.3;
              if (cur && cur[0] === r.link) { cur[2] = px + w; cur[3] = Math.min(cur[3], lt); cur[4] = Math.max(cur[4], lb); }
              else { flush(); cur = [r.link, px, px + w, lt, lb]; }
            } else if (cur) { flush(); }
            adv += w;
          }
        }
        flush();
      });
      e._runLinkSpans = runLinkSpans;
      // Whole-object clickable rect (top-origin), computed only when this edit carries/removes a link.
      // Existing line → its captured bbox; added text → measured from the drawn block (mirrors
      // text_runs.py _link_rect_for_edit) so the link tracks the TEXT, not the full-width container box.
      if (e.link || e.linkRemoved) {
        if (!isInsert) {
          const top = +(e.top || 0), bottom = +(e.bottom || 0), right = +(e.right || x);
          e._linkRect = [Math.max(0, x - 1), Math.max(0, top - 1), Math.max(right, x + 4) + 1, bottom + 1];
        } else {
          const nLines = Math.max(1, lineModel.filter(parts => parts.some(r => r.text)).length);
          const lineH = boxSize * 1.2;
          e._linkRect = [x, baseline - boxSize * 0.8, x + Math.max(widest, 4), baseline + (nLines - 1) * lineH + boxSize * 0.3];
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
      // Register the alpha ExtGStates referenced by `/GSx gs` (semi-transparent text), else mupdf throws
      // "cannot find ExtGState resource" and the gs is dropped → text renders fully opaque.
      if (usedEgs.size) {
        let egd = res.get('ExtGState');
        if (!egd || egd.isNull()) { egd = doc.newDictionary(); res.put('ExtGState', egd); }
        for (const eg of usedEgs.values()) egd.put(eg.name, doc.addObject(eg.dict));
      }
      const stream = doc.addStream(ops.build(), doc.newDictionary());
      appendContents(doc, pageObj, stream);
    }

    // Hyperlinks (port of edit_ops.py step 3): per-run partial links, then whole-object link/removal
    // (dropping any stale link over the area first), then restore any saved link redaction dropped.
    const managedRects = [];
    for (const e of pageEdits) {
      // 3a) Per-run links — a hyperlink over PART of a box (the selected word).
      for (const sp of (e._runLinkSpans || [])) {
        managedRects.push(sp.rect);
        try { page.createLink(sp.rect, sp.uri); } catch (_) {}
      }
      // 3b) Whole-object link or removal (rect measured from the drawn text, not the container box).
      const r = e._linkRect;
      if (!r) continue;
      managedRects.push(r);
      const link = e.link && typeof e.link === 'object' ? e.link : null;
      const uri = link && typeof link.uri === 'string' ? link.uri : null;
      try {                                  // drop any stale link over this area first (URL change / removal)
        const stale = page.getLinks().filter((l) => { try { return l.isExternal() && l.getURI() && rectsIntersect(l.getBounds(), r); } catch (_) { return false; } });
        for (const l of stale) { try { page.deleteLink(l); } catch (_) {} }
      } catch (_) {}
      if (uri && !e.linkRemoved) { try { page.createLink(r, uri); } catch (_) {} }
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
  // Repair the fonts' ToUnicode (nbsp/soft-hyphen → space/hyphen) in place so the edited text copies/
  // extracts/searches as clean ASCII. Best-effort — never fail the save over it.
  try { repairToUnicode(doc); } catch (_) {}
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
