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
import { bundledCandidates, stemForName, classForName } from './mupdfFonts.js';
import { shapeRun, splitByShapingScript } from '../util/shaping.js';

/** Normalise editable-box quirks (nbsp, zero-width, soft-hyphen, control chars) without dropping real
 *  Unicode — every font is embedded full-Unicode (Type0), so curly quotes / em-dash / accents / ₹ all
 *  draw natively. Mirrors edit_ops.py's raw cleaning. */
function normalizeText(s) {
  return String(s)
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')   // nbsp & friends -> space
    .replace(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/g, '')           // zero-width / soft hyphen
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');  // control chars (keep \t,\n)
}

// ── WinAnsi encoding — used by every SIMPLE font path: Base-14 re-emit (non-embedded standard kept
// name-only), reused embedded TrueType, and the bundled clone — all draw a WinAnsi-encodable line as a
// simple font so Chrome rasterises it identically; only genuinely non-WinAnsi glyphs fall to Type0. ──
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

const strBytes = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; };

/** Append `stream` to a page's /Contents (normalise single-stream → array, then push).
 *  CRITICAL: the FIRST time we touch a page we wrap its ORIGINAL content in a balanced `q … Q`. A page
 *  may leave a residual CTM set — e.g. content that opens with `0.75 0 0 -0.75 0 792 cm` (scale + vertical
 *  FLIP) and never `q`/`Q`s it — and because /Contents streams are concatenated, our appended text would
 *  inherit that transform and render upside-down / shrunk (the Notice-LCA regression). The leading `q`
 *  saves the page's default (identity) space and the trailing `Q` restores it before our stream draws, so
 *  our text is always placed in page space — exactly what the PyMuPDF backend did. `guarded` dedupes the
 *  wrap to once per page (text edit + table annotation may both append). */
function appendContents(doc, pageObj, stream, key, guarded) {
  let contents = pageObj.get('Contents');
  if (!contents || contents.isNull()) { pageObj.put('Contents', stream); return; }
  if (guarded && key != null && !guarded.has(key)) {
    guarded.add(key);
    const arr = doc.newArray();
    arr.push(doc.addStream(strBytes('q\n'), doc.newDictionary()));
    if (contents.isArray()) contents.forEach((v) => arr.push(v)); else arr.push(contents);
    arr.push(doc.addStream(strBytes('\nQ\n'), doc.newDictionary()));
    arr.push(stream);
    pageObj.put('Contents', arr);
    return;
  }
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
export async function applyEdits(mupdf, doc, data, loadFont, baseUrl) {
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
  const shapeOpts = new Map();     // Noto TTF file  -> shaped-part font option (one embed per face per doc)
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

  // ── CJK (Chinese/Japanese/Korean) — real selectable non-Latin SAVE (Phase 3, NON-SHAPING scripts only) ──
  // The bundled substitutes are Latin(+Cyrillic/Greek), so a CJK glyph tripped the flatten guard. CJK is
  // 1 char = 1 glyph (no shaping), so we load Noto Sans SC / JP / KR (Han / kana / Hangul) ON DEMAND and
  // offer them as extra Type0 options BEFORE the Latin catch-all: a CJK edit then embeds as REAL selectable
  // text (encodeCharacter 1:1 → GID). Indic/Arabic are deliberately NOT handled here — their conjunct/joining
  // shaping the 1:1 path can't produce, so they still flatten (correct appearance).
  const CJK_FILES = ['NotoSansSC.ttf', 'NotoSansJP.ttf', 'NotoSansKR.ttf'];
  const isCjkCp = (cp) => (cp >= 0x3040 && cp <= 0x30FF) || (cp >= 0x3130 && cp <= 0x318F)
    || (cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF)
    || (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xF900 && cp <= 0xFAFF);
  const hasCjk = (text) => { for (const ch of text || '') if (isCjkCp(ch.codePointAt(0))) return true; return false; };
  let _cjkOpts = null;
  async function cjkOptions() {
    if (_cjkOpts) return _cjkOpts;
    _cjkOpts = [];
    for (const file of CJK_FILES) {
      try {
        const mfont = await loadFont([file]);
        // only keep a font that really covers CJK (a Latin offline-fallback would just waste a slot)
        let ok = false; try { ok = mfont.encodeCharacter(0x4E16) !== 0 || mfont.encodeCharacter(0x3053) !== 0 || mfont.encodeCharacter(0xAC00) !== 0; } catch (_) {}
        if (ok) _cjkOpts.push({ name: 'CJK' + (seq++), ref: null, simple: false, cjk: true, mfont, charset: null });
      } catch (_) {}
    }
    return _cjkOpts;
  }

  /** A SIMPLE WinAnsi sibling of a bundled option (shares its loaded face). Drawn for the WinAnsi-encodable
   *  glyphs of re-inserted text so Chrome/PDFium rasterises them like a simple font — NOT the faint
   *  Type0/CIDFontType2 the bundled catch-all produces (the "edited line looks lighter" bug, present on any
   *  doc whose font isn't reusable: LaTeX/Computer-Modern, Type1 subsets, embedded non-reusable, password
   *  docs). The bundled Type0 option stays behind it as the full-Unicode catch-all for genuinely non-WinAnsi
   *  glyphs (CJK/exotic). Lazily attached so it only embeds when a glyph actually uses it. */
  function bundledSimpleOption(bundled) {
    if (!bundled._simple) {
      bundled._simple = { kind: 'simple', simple: true, winAnsi: true, simpleCmap: true,
        name: 'WS' + (seq++), ref: null, mfont: bundled.mfont, charset: null };
    }
    return bundled._simple;
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
          // Name the re-embed with the ORIGINAL BaseFont's case (subset prefix stripped, case
          // KEPT): pdf.js name-sniffs BaseFont against CASE-SENSITIVE standard-font tables when
          // it rebuilds the webfont on a reload of the saved file — a lowercased name
          // ("calibri-bold") misses and takes a glyph-mapping path that renders some capitals
          // (e.g. F) with the WRONG (regular-weight) glyph. The lowercase `key` stays the cache key.
          const properName = String(info.base || key).split('+').pop() || key;
          const mfont = new mupdf.Font(properName, bytes);
          const cs = charsets().get(key) || new Set();
          // If EVERY glyph the original drew is WinAnsi-encodable, re-embed the reuse as a SIMPLE WinAnsi
          // TrueType (same outlines). Chrome/PDFium then rasterises the edited line IDENTICALLY to the
          // original simple font — no faint "lighter" shift that a Type0/CIDFontType2 re-embed produces.
          // A single non-WinAnsi glyph (CJK / exotic symbol) keeps the Type0/Identity path so it can still
          // be addressed by glyph id. (Advance for CP1252-high chars uses the real codepoint — see unitFor.)
          const winAnsiOnly = cs.size > 0 && [...cs].every((c) => { const cp = c.codePointAt(0); return cp === 0x3F || winAnsiByte(cp) !== 0x3F; });
          opt = winAnsiOnly
            ? { kind: 'simple', name: 'RS' + (seq++), ref: null, simple: true, winAnsi: true, simpleCmap: true, mfont, charset: cs }
            : { kind: 'cid', name: 'RF' + (seq++), ref: null, simple: false, mfont, charset: cs };
        } catch (_) { opt = null; }
      }
    }
    cidCache.set(key, opt);
    return opt;
  }

  /** Reuse the page's OWN sibling weight of the span's family for a run whose bold/italic differ
   *  from the primary span — e.g. a plain run inside a Calibri-Bold line reuses the embedded
   *  "Calibri" instead of falling to the bundled clone (Carlito). Purely name-derived (Office-style
   *  "<Family>", "<Family>-Bold", "-Italic", "-BoldItalic"); a miss keeps the existing clone path. */
  function siblingReusedOption(span, bold, italic, pageFonts) {
    const base = stripName(span && span.fontName || '');
    if (!base) return null;
    const root = base.replace(/[-,]?(bolditalic|bold-?oblique|bold|italic|oblique|regular)$/, '').replace(/[-,]+$/, '');
    if (!root) return null;
    const suffix = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : '';
    const candidates = suffix ? [`${root}-${suffix}`, `${root},${suffix}`, root + suffix] : [root];
    for (const key of candidates) {
      if (pageFonts.has(key)) {
        const o = reusedOption({ fontName: key }, pageFonts);
        if (o) return o;
      }
    }
    return null;
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
      } else if (o.cjk) {                                                 // CJK Noto (Han/kana/Hangul) — has-glyph
        try { if (o.mfont.encodeCharacter(cp) !== 0) return o; } catch (_) {}
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
      // A simple font backed by a REAL loaded face (reused original OR bundled clone) resolves its advance
      // from the real CODEPOINT via the face's own cmap (`simpleCmap`); the drawn byte stays WinAnsi (the
      // font dict's WinAnsiEncoding maps it back to the glyph). A Base-14 built-in font is keyed by the byte
      // itself. They differ only for CP1252-high (0x80–0x9F) bytes.
      const enc = opt.simpleCmap ? cp : b;
      let adv = 0; try { adv = opt.mfont.advanceGlyph(opt.mfont.encodeCharacter(enc)); } catch (_) {}
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
  // A MIXED-script run is drawn as an ordered list of PARTS (see the shaping step in the opts phase):
  // each complex-script part is ONE Type0 segment of its SHAPED glyph-id sequence (advances from HarfBuzz —
  // the same face the doc embeds, so they agree with the /W), and each plain part goes through the normal
  // per-character font pick. Shaping the WHOLE run with one script's face rendered the other script's
  // characters as tofu ("परीक्षाQA" → "परीक्षा▯▯" — Noto Devanagari has no Q/A glyphs).
  const runSegments = (r) => {
    if (!r._shapedParts) return segmentByFont(r.text, r._opts);
    return r._shapedParts.flatMap((p) => p.shaped
      ? [{
          opt: p.opt,
          hex: p.shaped.glyphs.map((x) => (x.gid & 0xffff).toString(16).padStart(4, '0')).join(''),
          units: p.shaped.glyphs.map((x) => ({ adv: x.xAdvance / 1000 })),
          actual: p.text,          // /ActualText Unicode for THIS shaped part (per-segment, not per-run)
        }]
      : segmentByFont(p.text, r._opts));
  };
  // Run width for layout (line width, alignment, overflow) — shaped advances for shaped parts, per-character
  // measure for the rest.
  const runWidth = (r, size) => r._shapedParts
    ? r._shapedParts.reduce((w, p) => w + (p.shaped
        ? p.shaped.glyphs.reduce((a, x) => a + x.xAdvance / 1000, 0) * size
        : measureRun(p.text, r._opts, size)), 0)
    : measureRun(r.text, r._opts, size);
  // UTF-16BE hex for /ActualText. A SHAPED run is drawn by GLYPH id (ligated / reordered), so a viewer's
  // glyph→Unicode (ToUnicode) reverse of a ligature/reordered glyph is wrong — /ActualText gives copy/search
  // the ORIGINAL text so shaped Indic/Arabic stays correctly selectable.
  const utf16beHex = (s) => { let h = 'FEFF'; for (const ch of s) { let cp = ch.codePointAt(0); if (cp > 0xFFFF) { cp -= 0x10000; h += (0xD800 + (cp >> 10)).toString(16).padStart(4, '0') + (0xDC00 + (cp & 0x3FF)).toString(16).padStart(4, '0'); } else h += cp.toString(16).padStart(4, '0'); } return h.toUpperCase(); };

  // Pages whose original /Contents we've wrapped in a balanced q/Q (so our appended text isn't flipped/
  // scaled by a residual page CTM). Shared with applyAnnotations so a table-only page is guarded too.
  const guardedPages = new Set();

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
    // Glyph baselines on this page (with x-extent), collected ONCE, to clamp each redaction rect so
    // it can't reach a tightly-spaced NEIGHBOUR line. applyRedactions removes EVERY glyph the rect
    // intersects, and the rect's full em-height band (top-1 … bottom+1) is taller than the line gap
    // on dense docs (paystubs, offer letters) — so it used to catch the line above/below in the same
    // column and silently delete that unedited text. Clamping to the mid-point between baselines
    // keeps each rect inside its own row. Best-effort: any failure just leaves the rect unclamped.
    const pageGlyphs = [];
    try {
      page.toStructuredText('preserve-whitespace').walk({
        onChar(_c, origin, _font, size) {
          const sz = +size || 0;
          if (origin) pageGlyphs.push({ by: +origin[1], x0: +origin[0], x1: +origin[0] + sz * 0.62, sz });
        },
      });
    } catch (_) { /* clamp is best-effort */ }
    // Median glyph size on the page — the TYPICAL line height. A searchable scan's hidden OCR boxes are
    // unreliable: one word can carry a box ~2× the real height, and once edited its coverScan cover then
    // balloons over the line BELOW and hides it (a bottom URL got clipped this way). Used to clamp such an
    // outlier cover back to a normal line height.
    const _gsz = pageGlyphs.map((g) => g.sz).filter((s) => s > 0).sort((a, b) => a - b);
    const medGlyph = _gsz.length ? _gsz[_gsz.length >> 1] : 0;

    const redactRects = [];
    for (const e of pageEdits) {
      if (e.redact === false) continue;
      const x = +(e.x || 0), top = +(e.top || 0), bottom = +(e.bottom || 0), right = +(e.right || x);
      // ROTATED run: redact the AABB of the ACTUAL rotated glyphs. The horizontal x..right / top..bottom
      // box below misses steeply-rotated text — at 90° it is a thin horizontal band while the glyphs run
      // vertically, so the original survived the redaction (and a MOVED rotated line left a half-cut
      // original behind). Anchor (x, baseline); length (right-x) along the rotation direction; ± the em
      // box across. No neighbour clamp (rotated runs are isolated; the horizontal clamp would wrongly
      // shrink this box). Uses e.x/e.baseline = the ORIGINAL position, so a moved line clears its source.
      if (e.rotation && Math.abs(e.rotation) > 0.5) {
        const bl0 = +(e.baseline != null ? e.baseline : (top + bottom) / 2);
        const fs0 = +(e.fontSize || (bottom - top) || 10);
        const rad = e.rotation * Math.PI / 180;                 // y-down clockwise (CSS), matches the draw
        const dx = Math.cos(rad), dy = Math.sin(rad), nx = -Math.sin(rad), ny = Math.cos(rad);
        const L = Math.max(right - x, fs0 * 0.6);
        const xs = [], ys = [];
        for (const t of [0, L]) for (const s of [-fs0, fs0 * 0.35]) { xs.push(x + t * dx + s * nx); ys.push(bl0 + t * dy + s * ny); }
        const rr = [Math.max(0, Math.min(...xs) - 1), Math.max(0, Math.min(...ys) - 1), Math.min(pw, Math.max(...xs) + 1), Math.min(ph, Math.max(...ys) + 1)];
        page.createAnnotation('Redact').setRect(rr);
        redactRects.push(rr);
        continue;
      }
      const rx0 = Math.max(0, x - 2), rx1 = Math.min(pw, Math.max(right, x + 2) + 2);
      let rTop = Math.max(0, top - 1), rBot = Math.min(ph, bottom + 1);
      const bl = +(e.baseline != null ? e.baseline : (top + bottom) / 2);
      const fs = +(e.fontSize || (bottom - top) || 10);
      // Clamp against neighbour lines that share this line's x-span. Clamp to the neighbour's actual
      // glyph EDGE (from its own size), not the baseline mid-point: a line BELOW has tall caps/
      // ascenders (~0.78·size above its baseline) that reach past a mid-point, so a mid-point clamp
      // still deleted it. mupdf only needs the rect to INTERSECT this line's glyphs (all near the
      // baseline) to remove them, so pulling the edge in a touch never leaves this line behind.
      // mupdf's redaction uses each glyph's FONT-METRIC box (ascent ≈ 1·size above the baseline,
      // descent ≈ 0.3·size below) and drops the whole text run a glyph belongs to — so the rect must
      // clear the neighbour's font box entirely, not just its ink. This line's own glyphs sit on the
      // baseline, so pulling the edge in still removes them (their run is caught by the x-height band).
      for (const g of pageGlyphs) {
        if (g.x1 <= rx0 || g.x0 >= rx1) continue;                       // no horizontal overlap
        const d = g.by - bl, gs = g.sz || fs;
        if (d < -0.4 * fs) rTop = Math.max(rTop, g.by + 0.32 * gs + 0.4); // ABOVE: below its descenders
        else if (d > 0.4 * fs) rBot = Math.min(rBot, g.by - 1.0 * gs - 0.4); // BELOW: above its ascenders
      }
      // Never let the band invert or vanish; keep at least a thin strip on the baseline so this
      // line's own run is still caught.
      if (rBot <= rTop) { rTop = bl - fs * 0.2; rBot = bl + fs * 0.1; }
      const rect = [rx0, rTop, rx1, rBot];
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
      // An OCR line's original "text" is ink inside the SCAN IMAGE — redaction removes no image ink,
      // so an edited / deleted / moved OCR line must COVER the printed original with the line's
      // sampled background first (else the replacement overlaps the old glyphs on the scan). Uses the
      // ORIGINAL rect (e.x/top/bottom/right) — a moved line draws at +dx/dy and its source is cleared.
      // `coverScan` is the same need on a SCANNED-HYBRID page (native text layer over a full-page scan):
      // redaction clears the text-layer run but the baked scan glyphs remain, so cover them the same way.
      if (e.ocr || e.coverScan) {
        const ox = +(e.x || 0); let otop = +(e.top || 0), obot = +(e.bottom || 0); const orr = +(e.right || ox);
        // Clamp an OUTLIER scan box (a bad hidden-OCR box ~2× the real line height, whose BOTTOM often
        // drifts down onto the next line) to a normal height measured from its TOP — the printed glyph
        // sits near the top of such a box, so top-anchoring keeps the cover on this line and off the line
        // BELOW (a bottom URL got hidden this way). The baseline can't be trusted here (it drifts too).
        if (e.coverScan && medGlyph > 0 && (obot - otop) > medGlyph * 1.7) obot = otop + medGlyph * 1.35;
        const obg = Array.isArray(e.bgColor) && e.bgColor.length >= 3
          ? [e.bgColor[0] / 255, e.bgColor[1] / 255, e.bgColor[2] / 255] : [1, 1, 1];
        // A SCANNED text-layer's hidden boxes tend to UNDER-cover the printed ink (the OCR box runs a
        // touch narrower/shorter than the glyphs), so a tight cover leaves a sliver of the original
        // showing — the trailing glyph + its link underline. Pad the coverScan rect by a fraction of the
        // line height (bounded, so it can't reach a neighbour); a real OCR overlay box is tight → 2px.
        const lh = Math.abs(obot - otop) || 12;
        const hp = e.coverScan ? Math.max(2, lh * 0.5) : 2;
        const vp = e.coverScan ? Math.max(1, lh * 0.12) : 1;
        ops.op(`q ${f2(obg[0])} ${f2(obg[1])} ${f2(obg[2])} rg ${f2(ox - hp)} ${f2(ph - obot - vp)} ${f2((orr - ox) + hp * 2)} ${f2((obot - otop) + vp * 2)} re f Q\n`);
      }
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
      // A MOVED line (drag / arrow-nudge): redaction above used the ORIGINAL rect (e.x/top/bottom),
      // but every drawn artefact — text runs, underline, link rects — originates from (x, baseline),
      // so offsetting them here places the whole line at its new spot in the output.
      const mdx = +(e.dx) || 0, mdy = +(e.dy) || 0;
      const x = +(e.x || 0) + mdx;
      let baseline = +(e.baseline || 0) + mdy;
      // An OUTLIER scan box's stored baseline drifts DOWN onto the next line; re-seat the replacement a
      // cap-height below the box TOP so it lands on THIS line (matches the top-anchored cover above).
      if (e.coverScan && medGlyph > 0 && (+(e.bottom || 0) - +(e.top || 0)) > medGlyph * 1.7) baseline = +(e.top || 0) + medGlyph * 0.82 + mdy;
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
        // Prefer the family implied by the original font's NAME (Geneva->sans, Times->serif) over mupdf's
        // glyph-shape guess in sp.family, which misreads a broken-cmap subset — the cause of a SANS line
        // (Geneva) saving in SERIF Tinos and looking smaller than its unedited neighbours. Matches the
        // editor's display-font resolution; a name we don't recognise keeps the detected family.
        const nameFam = (!isInsert && sp && sp.fontName) ? classForName(sp.fontName) : null;
        const family = nameFam || (sp ? sp.family : (e.serif ? 'serif' : 'sans'));
        bundleSpec = lp ? { latex: lp } : stem ? { stem, family } : { family };
      }
      // Size: keep the original's exact size by default (the frontend's geometric guess runs big); an
      // explicit toolbar size change (sizeOverride) or added text uses the frontend size.
      let boxSize = +(e.fontSize || 12) || 12;
      if (sp && sp.size && !e.sizeOverride && !isInsert) boxSize = sp.size;
      // A searchable scan's hidden text run can report a WRONG (oversized ~2×) font size — clamp only a
      // clear outlier on a scan-backdrop edit so the replacement doesn't render huge; normal / heading-
      // sized lines (≤ 1.7× the page's typical glyph) keep their exact size.
      if (e.coverScan && medGlyph > 0 && boxSize > medGlyph * 1.7) boxSize = medGlyph * 1.2;
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
            raise: +(r.raise) || 0,                       // superscript baseline raise (pts, up)
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
        // A run whose weight/slant DIFFERS from the primary span (mixed line) reuses the page's own
        // sibling face of the same family (Calibri-Bold line -> plain run reuses embedded Calibri)
        // instead of dropping to the bundled clone.
        const weightMatch = sp && r.bold === sp.bold && r.italic === sp.italic;
        const runReused = (sp && !rExplicit)
          ? (weightMatch ? rReused : siblingReusedOption(sp, r.bold, r.italic, pageFonts))
          : null;
        if (runReused) opts.push(runReused);
        else if (rB14) opts.push(base14Option(rB14, r.bold, r.italic));
        opts.push(bundledSimpleOption(bundled));   // WinAnsi-encodable glyphs → simple WinAnsi (Chrome-identical)
        // CJK edit → offer the loaded Han/kana/Hangul Noto faces BEFORE the Latin catch-all so those glyphs
        // embed as REAL selectable text (Phase 3) instead of tripping the flatten guard below.
        if (hasCjk(r.text)) { for (const c of await cjkOptions()) opts.push(c); }
        opts.push(bundled);                         // genuinely non-WinAnsi → Type0 full-Unicode catch-all
        r._opts = opts;
        // COMPLEX-SCRIPT SHAPING (Phase 3): Indic (Devanagari…) / Arabic edited text needs HarfBuzz shaping —
        // conjuncts / reordering / contextual joining that the engine's 1:1 codepoint→glyph path can't do.
        // The run is SPLIT BY SCRIPT first (a mixed "टाइम्स QA कृत" has Latin inside): each complex part is
        // shaped with its script's Noto face and stashed as a shaped glyph-id part; plain parts keep the
        // normal per-char font pick. Shaping the whole mixed run with one face drew the other script's
        // chars as .notdef tofu. On ANY shaping failure the whole run falls through to the un-embeddable
        // guard → the flatten tier (never draws wrong glyphs).
        if (baseUrl && splitByShapingScript(r.text || '').some((p) => p.script)) {
          try {
            const parts = splitByShapingScript(r.text || '');
            const built = [];
            for (const part of parts) {
              if (!part.script) { built.push({ text: part.text }); continue; }
              const shaped = await shapeRun(part.script, part.text, baseUrl);
              if (!shaped || !shaped.glyphs.length) { built.length = 0; break; }    // any part fails → whole run to the guard
              let opt = shapeOpts.get(shaped.file);
              if (!opt) { opt = { name: 'SH' + (seq++), ref: null, simple: false, mfont: await loadFont([shaped.file]), charset: null }; shapeOpts.set(shaped.file, opt); }
              built.push({ text: part.text, shaped, opt });
            }
            if (built.length) r._shapedParts = built;
          } catch (_) {}
          if (r._shapedParts) {
            // Guard only the PLAIN parts (Latin/digits inside the mixed run) — shaped parts embed their face.
            const plain = r._shapedParts.filter((p) => !p.shaped).map((p) => p.text).join('');
            for (const ch of plain) {
              const cp = ch.codePointAt(0);
              if (cp <= 0x20) continue;
              const o = pickOption(cp, opts);
              if (o.charset === null && !o.winAnsi) {
                let g = 0; try { g = o.mfont.encodeCharacter(cp); } catch (_) {}
                if (!g) throw new Error('QPE_NEEDS_FLATTEN: edited text has glyphs no embeddable font covers (U+' + cp.toString(16).toUpperCase() + ')');
              }
            }
            continue;   // shaped OK → the whole-run guard below is not needed
          }
        }
        // UN-EMBEDDABLE TEXT GUARD: the bundled substitutes are LATIN faces (+ Cyrillic/Greek), and a
        // document's own CID/CJK font can't be re-encoded by codepoint — so non-Latin edited text
        // (Chinese/Japanese/Arabic/Indic/Thai…) would resolve to the catch-all's .notdef glyph and save
        // as "tofu" boxes (□) in every viewer. Detect that here and DECLINE, so the save chain drops to
        // the flatten tier, which rasterises the page through the browser's OWN fonts (full script
        // coverage) — the user's text survives as a printable image instead of boxes.
        for (const ch of r.text || '') {
          const cp = ch.codePointAt(0);
          if (cp <= 0x20) continue;
          const o = pickOption(cp, opts);
          if (o.charset === null && !o.winAnsi) {          // fell through to the bundled Type0 catch-all
            let g = 0; try { g = o.mfont.encodeCharacter(cp); } catch (_) {}
            if (!g) throw new Error('QPE_NEEDS_FLATTEN: edited text has glyphs no embeddable font covers (U+' + cp.toString(16).toUpperCase() + ')');
          }
        }
      }

      // METRIC MATCH — an UNREUSABLE original font (broken-cmap subset like this doc's Geneva) falls to
      // a bundled substitute whose advances can differ (Arimo runs ~8% narrower than Geneva), so the
      // SAME 10pt replacement ends visibly short of the original right edge and reads as "the edited
      // line shrank". Do what Acrobat's metric-matched substitutes do: horizontally scale the text (Tz)
      // by originalSpanWidth / substituteWidth(SAME original text) — a pure font-metric ratio,
      // independent of what the user typed. Gated: replace only, no explicit toolbar family, reuse
      // unavailable; ~1 ratios (Base-14 re-emits, LaTeX twins) fall in the dead-zone and emit nothing.
      let tz = 1;
      if (!isInsert && sp && sp.text && sp.width > 10 && !reused && e.fontFamily == null) {
        const probeRun = lineModel.flat().find(r => r.text && r._opts);
        const probe = prep(sp.text);
        if (probeRun && probe.trim()) {
          const natural = measureRun(probe, probeRun._opts, sp.size || boxSize);
          if (natural > 10) tz = Math.min(1.25, Math.max(0.9, sp.width / natural));
          if (Math.abs(tz - 1) < 0.02) tz = 1;
        }
      }
      // Per-line widths (used for overflow scaling AND alignment re-anchoring) — in DRAWN (Tz-scaled) units.
      const lineWidth = (parts) => parts.reduce((w, r) => w + runWidth(r, r.size), 0) * tz;
      let widths = lineModel.map(lineWidth);
      let widest = Math.max(0, ...widths);
      // Overflow: if the widest line exceeds the space to the right margin, scale every run down.
      const availW = pw - x - 4;
      if (availW > 8 && widest > availW) {
        const s = Math.max(0.05, availW / widest);
        for (const parts of lineModel) for (const r of parts) { r.size = Math.max(4, r.size * s); if (r.raise) r.raise *= s; }
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
          for (const seg of runSegments(r)) {
            usedFonts.add(embed(seg.opt));   // embed the font into the doc only now that a glyph uses it
            // Advance each run along the rotated baseline. The text matrix advances glyphs by
            // (adv·cos, adv·sin) in PDF (y-up) space, so in this TOP-origin (y-down) space the run's y
            // moves by -adv·sin. Using +adv·sin scattered the runs ~2·adv·sin apart — a partial-styled
            // ROTATED line (multiple Tj runs) broke into separated words; a single Tj was unaffected.
            // A SUPERSCRIPT run additionally rises along the rotated up-vector (top-origin: up = -y).
            const raise = r.raise || 0;
            const px = lx + adv * cos + (rot ? raise * Math.sin(rad) : 0);
            const pyTop = lyTop - adv * sin - (rot ? raise * Math.cos(rad) : raise);
            const py = ph - pyTop;
            const egs = boxOpacity < 1 ? egsFor(boxOpacity) : null;
            // SHAPED segment → wrap in an /ActualText marked-content span so copy/search recover the real
            // Unicode even though the drawn glyphs are ligated/reordered (their glyph→Unicode reverse is
            // unreliable). Per SEGMENT, not per run — a mixed run's plain (Latin) segments need no wrap.
            const actual = seg.actual ? `/Span <</ActualText <${utf16beHex(seg.actual)}>>> BDC ` : '';
            ops.op('q ' + (egs ? '/' + egs.name + ' gs ' : '') + actual + 'BT /' + seg.opt.name + ' ' + f2(r.size) + ' Tf '
              + (tz !== 1 ? f2(tz * 100) + ' Tz ' : '')     // metric-match horizontal scale (see above)
              + (e.invisible ? '3 Tr ' : '')                // searchable-PDF layer: glyphs select/search but paint nothing
              + f2(r.color[0]) + ' ' + f2(r.color[1]) + ' ' + f2(r.color[2]) + ' rg ');
            ops.op(rot ? `${f2(cos)} ${f2(sin)} ${f2(-sin)} ${f2(cos)} ${f2(px)} ${f2(py)} Tm ` : `1 0 0 1 ${f2(px)} ${f2(py)} Tm `);
            if (seg.opt.winAnsi) ops.textString(seg.bytes); else ops.glyphString(seg.hex);
            ops.op(' Tj ET ' + (seg.actual ? 'EMC ' : '') + 'Q\n');
            const w = measureSeg(seg, r.size) * tz;   // drawn width (Tz-scaled) — advance/underline/link agree
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
          const top = +(e.top || 0) + mdy, bottom = +(e.bottom || 0) + mdy;
          const right = (e.right != null ? +e.right : +(e.x || 0)) + mdx;
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
      appendContents(doc, pageObj, stream, pageNum, guardedPages);
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
  applyAnnotations(mupdf, doc, annotations, guardedPages);

  // Subset every embedded font down to the glyphs actually used (we embed full TTFs for Unicode
  // coverage), so the output stays small. Best-effort — never fail the save over it.
  try { doc.subsetFonts(); } catch (_) {}
  // Repair the fonts' ToUnicode (nbsp/soft-hyphen → space/hyphen) in place so the edited text copies/
  // extracts/searches as clean ASCII. Best-effort — never fail the save over it.
  try { repairToUnicode(doc); } catch (_) {}
  return doc.saveToBuffer('compress').asUint8Array().slice();
}

function applyAnnotations(mupdf, doc, annotations, guardedPages) {
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
        appendContents(doc, pageObj, doc.addStream(ops.build(), doc.newDictionary()), pageNum, guardedPages);
      }
    } catch (err) {
      // A single bad annotation must not abort the whole save (matches the backend's per-annot guard).
      console.warn('wasm annotation draw error', ann && ann.kind, err && err.message);
    }
  }
}
