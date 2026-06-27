// Bundled-font resolution + lazy loading for the WASM edit tier. Ports the substitution tables from
// backend/pdf/fonts.py: the generic sans/serif/mono trio, the toolbar family map (familiar names →
// legally-distributable open clones), and the LaTeX/TeX fallback faces. Each TTF/OTF is fetched once
// from /assets/edit-fonts/ (only the families an edit needs) and cached as a mupdf.Font.

// Generic family → bundled stem (metric-compatible: Arial/Helvetica, Times, Courier).
const GENERIC = { sans: 'Arimo', serif: 'Tinos', mono: 'Cousine' };

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

/** Load the first candidate filename that fetches successfully, cached. */
export async function loadBundledFont(mupdf, candidates, baseUrl) {
  let lastErr;
  for (const file of candidates) {
    try { return await fetchFont(mupdf, file, baseUrl); }
    catch (e) { lastErr = e; _cache.delete(file); }
  }
  throw lastErr || new Error('no bundled font candidate loaded');
}
