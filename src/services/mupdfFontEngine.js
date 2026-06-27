// Font engine for the WASM edit tier — the JS port of the reuse/exclusion parts of backend/pdf/fonts.py.
// Lets an edited line keep the document's OWN embedded outlines (real Calibri/Arial/…) instead of always
// dropping to a bundled metric-compatible substitute. Reuse is via extract FontFile2 → new mupdf.Font →
// doc.addFont (Type0/Identity), drawn by glyph-id; mupdf auto-generates a ToUnicode CMap so the result
// stays selectable/ATS-clean (verified). Only TrueType embeds are reused; Type1/CFF/LaTeX subsets are
// excluded (they mis-map in strict viewers — the "gibberish only after save" bug) and fall to bundled.

export const stripName = (n) => (n || '').split('+').pop().toLowerCase();

// LaTeX/TeX subset fonts (Computer Modern CMR/CMBX…, Latin Modern LMR…): non-standard TeX encoding,
// unreliable to reuse. Excluded → redrawn with a fallback (open LaTeX face is Phase 3).
const LATEX_RE = /^(cm|lm)[a-z]{1,6}\d/;
export const isLatexSubset = (base) => LATEX_RE.test(stripName(base));

const asName = (o) => { try { return o && o.asName ? o.asName() : ''; } catch (_) { return ''; } };

/** Family ('sans'|'serif'|'mono') if `base` is one of the 14 standard PDF TEXT fonts (Helvetica/Arial,
 *  Times, Courier), else null. Symbol/ZapfDingbats excluded. Mirrors fonts.py _standard_family. */
export function standardFamily(base) {
  const nm = stripName(base);
  if (nm.startsWith('helvetica') || nm.startsWith('arial')) return 'sans';
  if (nm.startsWith('times') || nm.includes('times new roman')) return 'serif';
  if (nm.startsWith('courier')) return 'mono';
  return null;
}

const LX_BOLD = ['cmbx', 'cmb', 'bx', 'bold', 'black', 'heavy', 'semibold'];
const LX_ITALIC = ['cmti', 'cmsl', 'cmmi', 'cmssi', 'cmitt', 'cmsltt', 'italic', 'oblique', 'slanted'];

/**
 * LaTeX/TeX family profile { shape, family, bold, italic } or null. Recognises Computer Modern,
 * Latin Modern, TeX Gyre and the classic mathptmx/helvet/courier substitutes (incl. subset names).
 * Picks the open fallback face shape (cm/times/helvetica/courier) + family (serif/sans/mono).
 * Ported from fonts.py _latex_font_profile.
 */
export function latexProfile(base) {
  const raw = stripName(base);
  const nm = raw.replace(/[\s-]/g, '');
  const cmLm = LATEX_RE.test(raw) || nm.includes('latinmodern') || nm.includes('computermodern')
    || /^(lmroman|lmsans|lmmono)/.test(nm);
  const times = ['texgyretermes', 'termes', 'nimbusrom', 'pagella', 'bonum', 'schola'].some((k) => nm.includes(k));
  const helv = ['texgyreheros', 'heros', 'nimbussans', 'adventor'].some((k) => nm.includes(k));
  const cour = ['texgyrecursor', 'cursor', 'nimbusmono'].some((k) => nm.includes(k));
  if (!(cmLm || times || helv || cour)) return null;
  const bold = LX_BOLD.some((k) => nm.includes(k));
  const italic = LX_ITALIC.some((k) => nm.includes(k));
  if (times) return { shape: 'times', family: 'serif', bold, italic };
  if (helv) return { shape: 'helvetica', family: 'sans', bold, italic };
  if (cour) return { shape: 'courier', family: 'mono', bold, italic };
  const family = ['cmss', 'lmsans', 'lmss'].some((k) => nm.includes(k)) ? 'sans'
    : ['cmtt', 'cmitt', 'cmsltt', 'lmmono', 'lmtt'].some((k) => nm.includes(k)) ? 'mono' : 'serif';
  return { shape: 'cm', family, bold, italic };
}

/**
 * Enumerate a page's fonts → Map(strippedBaseName → { base, subtype, reusable, ff, isCID }).
 * `reusable` = embedded TrueType (FontFile2) that isn't a LaTeX subset; `ff` is the font-file stream
 * PDFObject to extract from. Reads inherited Resources so fonts on a parent node are seen.
 */
export function enumeratePageFonts(page) {
  const map = new Map();
  try {
    const pobj = page.getObject();
    const res = pobj.getInheritable('Resources');
    if (!res || res.isNull()) return map;
    const fonts = res.get('Font');
    if (!fonts || fonts.isNull()) return map;
    fonts.forEach((val) => {
      try {
        const subtype = asName(val.get('Subtype'));
        const base = asName(val.get('BaseFont'));
        if (!base) return;
        let fd = null, isCID = false;
        if (subtype === 'Type0') {
          isCID = true;
          const df = val.get('DescendantFonts');
          const d0 = df && df.isArray && df.isArray() ? df.get(0) : df;
          fd = d0 && d0.get ? d0.get('FontDescriptor') : null;
        } else {
          fd = val.get('FontDescriptor');
        }
        let ffKey = null, ff = null;
        if (fd && !fd.isNull()) {
          for (const k of ['FontFile2', 'FontFile3', 'FontFile']) {
            const s = fd.get(k);
            if (s && !s.isNull()) { ffKey = k; ff = s; break; }
          }
        }
        const reusable = ffKey === 'FontFile2' && !isLatexSubset(base);   // TrueType only
        const key = stripName(base);
        if (!map.has(key)) map.set(key, { base, subtype, reusable, ff, isCID });
      } catch (_) {}
    });
  } catch (_) {}
  return map;
}

/** Raw bytes of an embedded font-file stream (FontFile2), or null. */
export function extractFontBytes(ff) {
  try {
    const buf = ff.readStream();
    const u = buf.asUint8Array ? buf.asUint8Array() : new Uint8Array(buf);
    return u && u.length > 4 ? u.slice() : null;
  } catch (_) { return null; }
}

/**
 * Drawn-character set per font, from the ORIGINAL document (all pages), BEFORE any redaction. This is
 * the only reliable test of what a subset embedded font can actually render (a drawn glyph has an
 * outline; the cmap over-claims). Mirrors fonts.py _warm_charsets. Map(strippedFontName → Set<char>).
 */
export function warmCharsets(doc) {
  const map = new Map();
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    let st;
    try { st = JSON.parse(doc.loadPage(i).toStructuredText().asJSON()); } catch (_) { continue; }
    for (const blk of st.blocks || []) {
      for (const ln of blk.lines || []) {
        if (!ln.font || !ln.text) continue;
        const key = stripName(ln.font.name);
        let set = map.get(key);
        if (!set) { set = new Set(); map.set(key, set); }
        for (const ch of ln.text) set.add(ch);
      }
    }
  }
  return map;
}
