// Bundled-font resolution + lazy loading for the WASM edit tier. Ports the substitution tables from
// backend/pdf/fonts.py: the generic sans/serif/mono trio, the toolbar family map (familiar names →
// legally-distributable open clones), and the LaTeX/TeX fallback faces. Each TTF/OTF is fetched once
// from /assets/edit-fonts/ (only the families an edit needs) and cached as a mupdf.Font.

import { familyKeyFromFont } from '../util/fonts.js';

// Generic family → bundled stem (metric-compatible: Arial/Helvetica, Times, Courier).
const GENERIC = { sans: 'Arimo', serif: 'Tinos', mono: 'Cousine' };

// Catalogue keys that are SERIF / MONO; everything else classForName resolves is sans. Used to pick a
// substitute family from a font's NAME when the glyph-shape guess is unreliable (a broken-cmap subset
// like "Geneva" was mis-detected as serif, so an edited sans line saved in Times).
const SERIF_KEYS = new Set(['times', 'georgia', 'cambria', 'garamond', 'baskerville', 'librebaskerville',
  'palatino', 'merriweather', 'playfair', 'notoserif']);
const MONO_KEYS = new Set(['courier', 'consolas', 'firacode', 'jetbrainsmono', 'ibmplexmono', 'sourcecodepro']);
/** Generic family ('sans'|'serif'|'mono') for a font NAME via the shared catalogue map, or null when the
 *  name isn't a family we recognise (caller keeps its own detection). Mirrors the editor's display font. */
export function classForName(fontName) {
  const k = familyKeyFromFont(fontName);
  if (!k) return null;
  return SERIF_KEYS.has(k) ? 'serif' : MONO_KEYS.has(k) ? 'mono' : 'sans';
}

// Toolbar family key → [bundled stem, generic family]. Open clones of proprietary faces (originals
// never bundled) + open fonts under their real names. The generic family is the last-ditch fallback.
const TOOLBAR = {
  arial: ['Arimo', 'sans'], helvetica: ['Arimo', 'sans'], verdana: ['Arimo', 'sans'],
  tahoma: ['Arimo', 'sans'], trebuchet: ['Arimo', 'sans'],
  times: ['Tinos', 'serif'], georgia: ['Gelasio', 'serif'], cambria: ['Caladea', 'serif'],
  garamond: ['EBGaramond', 'serif'], baskerville: ['LibreBaskerville', 'serif'],
  librebaskerville: ['LibreBaskerville', 'serif'], palatino: ['NotoSerif', 'serif'],
  merriweather: ['Merriweather', 'serif'], playfair: ['PlayfairDisplay', 'serif'], notoserif: ['NotoSerif', 'serif'],
  courier: ['Cousine', 'mono'], consolas: ['Cousine', 'mono'], firacode: ['FiraCode', 'mono'],
  jetbrainsmono: ['JetBrainsMono', 'mono'], sourcecodepro: ['SourceCodePro', 'mono'], ibmplexmono: ['IBMPlexMono', 'mono'],
  calibri: ['Carlito', 'sans'], comicsans: ['ComicNeue', 'sans'], comicneue: ['ComicNeue', 'sans'],
  roboto: ['Roboto', 'sans'], opensans: ['OpenSans', 'sans'], montserrat: ['Montserrat', 'sans'],
  inter: ['Inter', 'sans'], lato: ['Lato', 'sans'], poppins: ['Poppins', 'sans'], nunito: ['Nunito', 'sans'],
  sourcesans: ['SourceSans3', 'sans'], ubuntu: ['Ubuntu', 'sans'], ptsans: ['PTSans', 'sans'],
  brushscript: ['Pacifico', 'sans'], pacifico: ['Pacifico', 'sans'],
  sans: ['Arimo', 'sans'], serif: ['Tinos', 'serif'], mono: ['Cousine', 'mono'],
};

// LaTeX/TeX fallback stems (open Latin Modern / TeX Gyre, .otf) so an edit on a LaTeX line blends in.
const LATEX = {
  cm: { serif: 'LMRoman', sans: 'LMSans', mono: 'LMMono' },
  times: 'TeXGyreTermes', helvetica: 'TeXGyreHeros', courier: 'TeXGyreCursor',
};

// Detected embedded-font name → bundled stem, when it's a family we actually ship (or its proprietary
// twin). Used as the fallback when an embedded font can't be reused, so the substitute is visually
// identical — a doc embedding Carlito we can't re-encode falls back to bundled Carlito, not Arimo.
const NAME_STEMS = [
  ['carlito', 'Carlito'], ['calibri', 'Carlito'], ['caladea', 'Caladea'], ['cambria', 'Caladea'],
  ['gelasio', 'Gelasio'], ['georgia', 'Gelasio'], ['arimo', 'Arimo'], ['tinos', 'Tinos'], ['cousine', 'Cousine'],
  ['ebgaramond', 'EBGaramond'], ['librebaskerville', 'LibreBaskerville'], ['merriweather', 'Merriweather'],
  ['playfair', 'PlayfairDisplay'], ['comicneue', 'ComicNeue'], ['roboto', 'Roboto'], ['lato', 'Lato'],
  ['poppins', 'Poppins'], ['nunito', 'Nunito'], ['montserrat', 'Montserrat'], ['inter', 'Inter'],
  ['ubuntu', 'Ubuntu'], ['firacode', 'FiraCode'], ['jetbrains', 'JetBrainsMono'], ['ibmplex', 'IBMPlexMono'],
  ['notoserif', 'NotoSerif'], ['sourcecode', 'SourceCodePro'], ['sourcesans', 'SourceSans3'],
];
export function stemForName(fontName) {
  const nm = (fontName || '').split('+').pop().toLowerCase().replace(/[\s-]/g, '');
  for (const [k, stem] of NAME_STEMS) if (nm.includes(k)) return stem;
  return null;
}

const VARIANT = (b, i) => (b && i ? 'BoldItalic' : b ? 'Bold' : i ? 'Italic' : 'Regular');
// In-family fallback chain so a stem shipping fewer weights stays in its own face, not a substitute.
const CHAIN = { BoldItalic: ['BoldItalic', 'Bold', 'Italic', 'Regular'], Bold: ['Bold', 'Regular'], Italic: ['Italic', 'Regular'], Regular: ['Regular'] };

function files(stem, bold, italic, ext) {
  return CHAIN[VARIANT(bold, italic)].map((v) => `${stem}-${v}.${ext}`);
}

/**
 * Ordered candidate filenames for an edit's bundled font. `spec`:
 *   { key }   explicit toolbar family (Arial/Calibri/Georgia/…)
 *   { latex } a LaTeX profile { shape, family } (Computer Modern / TeX Gyre)
 *   { family } generic 'sans'|'serif'|'mono'
 * Falls back to the generic trio when a toolbar stem isn't shipped.
 */
export function bundledCandidates(spec, bold, italic) {
  if (spec && spec.stem) {
    return files(spec.stem, bold, italic, 'ttf').concat(files(GENERIC[spec.family] || 'Arimo', bold, italic, 'ttf'));
  }
  if (spec && spec.latex) {
    const { shape, family } = spec.latex;
    const stem = shape === 'cm' ? LATEX.cm[family] || LATEX.cm.serif : LATEX[shape];
    if (stem) return files(stem, bold, italic, 'otf').concat(files(GENERIC[family] || 'Tinos', bold, italic, 'ttf'));
  }
  if (spec && spec.key && TOOLBAR[spec.key]) {
    const [stem, fam] = TOOLBAR[spec.key];
    return files(stem, bold, italic, 'ttf').concat(files(GENERIC[fam], bold, italic, 'ttf'));
  }
  const fam = (spec && GENERIC[spec.family]) ? spec.family : 'sans';
  return files(GENERIC[fam], bold, italic, 'ttf');
}

const _cache = new Map();   // filename -> Promise<mupdf.Font>

function fetchFont(mupdf, file, baseUrl) {
  if (!_cache.has(file)) {
    _cache.set(file, (async () => {
      const resp = await fetch(new URL('/assets/edit-fonts/' + file, baseUrl).href);
      if (!resp.ok) throw new Error(`edit font fetch failed (${file}): ${resp.status}`);
      return new mupdf.Font(file.replace(/\.(ttf|otf)$/i, ''), new Uint8Array(await resp.arrayBuffer()));
    })());
  }
  return _cache.get(file);
}

// OFFLINE fallback: the bundled faces are fetched from /assets/edit-fonts/ on demand, so with no network
// (and nothing yet cached) every candidate fetch fails. Rather than let that ABORT the whole WASM save —
// which drops it to the pdf-lib tier that loses the original colour (white→black) and partial styling — we
// degrade to mupdf's BUILT-IN Base-14 face (no network). The save then still succeeds with colour + layout
// + partial styling intact; only the bundled font FAMILY falls back to a standard (Helvetica/Times/Courier).
function builtinFor(candidates) {
  const last = candidates[candidates.length - 1] || '';      // bundledCandidates always ends with the generic trio
  const fam = /Tinos/i.test(last) ? 'serif' : /Cousine/i.test(last) ? 'mono' : 'sans';
  const v = candidates[0] || '';
  const bold = /Bold/i.test(v), ital = /Italic|Oblique/i.test(v);
  const B14 = {
    sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
    serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
    mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
  };
  return B14[fam][(bold ? 1 : 0) + (ital ? 2 : 0)];
}

/** Load the first candidate filename that fetches successfully (cached); offline, degrade to a built-in. */
export async function loadBundledFont(mupdf, candidates, baseUrl) {
  let lastErr;
  for (const file of candidates) {
    try { return await fetchFont(mupdf, file, baseUrl); }
    catch (e) { lastErr = e; _cache.delete(file); }
  }
  // Every fetch failed (offline / asset missing) → use a built-in standard so the save doesn't abort.
  try { return new mupdf.Font(builtinFor(candidates)); }
  catch (_) { throw lastErr || new Error('no bundled font candidate loaded'); }
}
