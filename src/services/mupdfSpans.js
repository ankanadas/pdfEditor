// Span / style detection for the WASM edit tier — the JS port of backend/pdf/spans.py. Reads the
// ORIGINAL page (before redaction) so a replacement reuses the real font size, colour, family and
// weight/slant instead of the frontend's geometric guesses. mupdf's structured text already splits a
// line on every font/style change, so each JSON "line" ≈ a PyMuPDF span.

// Family-name hints — a clear family name in the font basename is more reliable than the embedded
// serif flag (some open Calibri/Arial clones, e.g. Carlito/Arimo, carry a stray serif flag).
const SERIF_HINTS = ['times', 'serif', 'georgia', 'garamond', 'roman', 'minion', 'charter', 'tinos',
  'caladea', 'cambria', 'gelasio', 'baskerville', 'merriweather', 'playfair', 'notoserif', 'ptserif',
  'librebaskerville', 'palatino', 'liberation serif'];
const SANS_HINTS = ['helvetica', 'arial', 'verdana', 'tahoma', 'segoe', 'calibri', 'roboto', 'opensans',
  'open sans', 'montserrat', 'noto sans', 'notosans', 'dejavu sans', 'liberation sans', 'gill', 'futura',
  'myriad', 'arimo', 'carlito', 'cousine', 'lato', 'nunito', 'ubuntu', 'poppins', 'sourcesans', 'ptsans',
  'trebuchet', 'comic neue', 'comicneue', 'comic sans', 'comicsans'];
const MONO_HINTS = ['courier', 'mono', 'consol', 'cousine', 'firacode', 'fira code', 'jetbrains',
  'ibmplex', 'ibm plex', 'sourcecode', 'source code'];

const hit = (name, list) => list.some((k) => name.includes(k));

/** (family, bold, italic) from a structured-text font + name, mirroring spans.py _span_style. */
function styleOf(font) {
  const nm = (font.name || '').split('+').pop().toLowerCase();
  const weight = (font.weight || '').toLowerCase();
  const style = (font.style || '').toLowerCase();
  const fam = (font.family || '').toLowerCase();
  const nameSans = hit(nm, SANS_HINTS), nameSerif = hit(nm, SERIF_HINTS), nameMono = hit(nm, MONO_HINTS);
  const mono = nameMono || fam === 'monospace';
  const serif = !mono && (nameSerif || (fam === 'serif' && !nameSans));
  const bold = weight === 'bold' || /bold|black|heavy|semi.?bold|demi.?bold|medium/.test(nm);   // Medium/Semibold → bold on save (I-94 labels)
  const italic = style.includes('italic') || /italic|oblique/.test(nm);
  return { family: mono ? 'mono' : serif ? 'serif' : 'sans', bold, italic };
}

/**
 * Analyse a page into a flat span list (geometry + style + size) plus a char-origin colour map.
 * Done once per page, BEFORE redaction.
 */
export function analyzePage(page) {
  const json = JSON.parse(page.toStructuredText('preserve-whitespace,preserve-spans').asJSON());
  const spans = [];
  for (const blk of json.blocks || []) {
    for (const ln of blk.lines || []) {
      if (!ln.font || !ln.bbox) continue;
      const text = ln.text || '';
      const st = styleOf(ln.font);
      spans.push({
        ox: ln.x, oy: ln.y,                      // baseline origin
        bbox: ln.bbox,                            // {x,y,w,h} top-left
        size: +ln.font.size || 0,
        fontName: ln.font.name || '',             // for embedded-font reuse lookup
        text,                                     // original text — metric-matching an unreusable font's substitute
        hasText: text.trim().length > 0,
        ...st,
      });
    }
  }
  // Per-char colours + EFFECTIVE size (the JSON line carries neither reliably). The structured-text
  // `line.font.size` is truncated for LaTeX/Type1 fonts (reports 10 for a real 10.909 Tf → re-inserted
  // text comes out ~9% too small next to the unchanged lines); the walk's per-char size is the true
  // rendered size (matches fitz / the Tf), so detectSpan prefers it.
  const colors = [];
  try {
    page.toStructuredText('preserve-whitespace').walk({
      onChar(_c, origin, _font, _size, _quad, color) {
        if (origin) colors.push({ x: origin[0], y: origin[1], rgb: normColor(color), size: +_size || 0 });
      },
    });
  } catch (_) {}
  return { spans, colors };
}

// mupdf's StructuredText walk reports a Color as an array of components in 0..1 (NOT a packed int):
// 1 = gray, 3 = RGB, 4 = CMYK. Normalise to an [r,g,b] triple.
export function normColor(c) {
  if (!Array.isArray(c) || !c.length) return [0, 0, 0];
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 4) { const [cy, m, y, k] = c; return [(1 - cy) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]; }
  return [c[0], c[1], c[2]];
}

/**
 * The original span closest to (x, baseline) — captured before redaction. Returns the detected
 * { size, family, bold, italic, color } or null if nothing is within range (matches _find_original_span,
 * threshold 25). Mirrors edit_ops step 0 + _span_color.
 */
/**
 * Best-effort alignment of the edited LINE so a replacement of a different length keeps it: 'right'
 * for a right-aligned column (several rows ending at the same x while starting at varying x — e.g.
 * résumé dates), 'center' for a line centred + indented from both margins, else 'left'. Conservative.
 * Ported from spans.py _detect_align. lineLeft/lineRight are the edit's own line box.
 */
export function detectAlign(analysis, lineLeft, lineRight) {
  // Collapse spans into one [left,right] per text line (by baseline) — far less noisy than raw spans.
  const byY = new Map();
  for (const s of analysis.spans) {
    if (!s.hasText) continue;
    const key = Math.round(s.oy);
    let g = byY.get(key);
    if (!g) { g = { left: Infinity, right: -Infinity }; byY.set(key, g); }
    g.left = Math.min(g.left, s.bbox.x);
    g.right = Math.max(g.right, s.bbox.x + s.bbox.w);
  }
  const lines = [...byY.values()];
  if (lines.length < 3) return 'left';
  const marginLeft = Math.min(...lines.map((l) => l.left));
  const contentRight = Math.max(...lines.map((l) => l.right));
  if (contentRight - marginLeft > 1 && (lineRight - lineLeft) > 0.6 * (contentRight - marginLeft)) return 'left'; // full-width/justified
  if (lines.filter((l) => Math.abs(l.left - lineLeft) < 1.5).length >= 3) return 'left';                          // shares a common left margin
  const indent = lineLeft - marginLeft;
  const sameRight = lines.filter((l) => Math.abs(l.right - lineRight) < 1.5);
  if (sameRight.length >= 2 && indent > 30) {
    const lSpread = Math.max(...sameRight.map((l) => l.left)) - Math.min(...sameRight.map((l) => l.left));
    const rSpread = Math.max(...sameRight.map((l) => l.right)) - Math.min(...sameRight.map((l) => l.right));
    if (lSpread > rSpread + 1.0) return 'right';
  }
  const center = (lineLeft + lineRight) / 2;
  if (Math.abs(center - (marginLeft + contentRight) / 2) < 8 && indent > 25 && (contentRight - lineRight) > 25) return 'center';
  return 'left';
}

export function detectSpan(analysis, x, baseline) {
  let best = null, bestD = 1e9;
  for (const s of analysis.spans) {
    const d = Math.abs(s.ox - x) + Math.abs(s.oy - baseline);
    if (d < bestD) { bestD = d; best = s; }
  }
  if (!best || bestD >= 25) return null;
  // Nearest char origin → colour AND effective size (the walk size is the true rendered size; the JSON
  // line size is truncated for some Type1/LaTeX fonts — see analyzePage).
  let color = [0, 0, 0], cD = 1e9, charSize = 0;
  for (const c of analysis.colors) {
    const d = Math.abs(c.x - best.ox) + Math.abs(c.y - best.oy);
    if (d < cD) { cD = d; color = c.rgb; charSize = c.size || 0; }
  }
  // Use the walk size only when it's meaningfully LARGER than the JSON size (the truncation case); never
  // let a stray mis-matched char shrink a correctly-detected size.
  const size = (charSize > best.size + 0.2) ? charSize : best.size;
  return { size, family: best.family, bold: best.bold, italic: best.italic, color, fontName: best.fontName,
    // Original text + drawn width, so a SUBSTITUTE font (unreusable original) can be horizontally
    // scaled to occupy the same footprint the original font did (see mupdfEdit metric match).
    text: best.text || '', width: (best.bbox && +best.bbox.w) || 0 };
}
