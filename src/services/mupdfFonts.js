// Lazy loader for the bundled edit fonts used by the WASM edit tier. Mirrors the backend's
// metric-compatible substitution set: Arimo≈Helvetica (sans), Tinos≈Times (serif), Cousine≈Courier
// (mono), in regular/bold/italic/bold-italic. Each TTF is fetched ONCE from /assets/edit-fonts/ (only
// the families an edit actually needs) and cached as a mupdf.Font for the lifetime of the worker.
// Phase 1b uses these for both width measurement and simple-font (WinAnsi) embedding.

const FONT_FILES = {
  sans:  { regular: 'Arimo-Regular.ttf',   bold: 'Arimo-Bold.ttf',   italic: 'Arimo-Italic.ttf',   boldItalic: 'Arimo-BoldItalic.ttf' },
  serif: { regular: 'Tinos-Regular.ttf',   bold: 'Tinos-Bold.ttf',   italic: 'Tinos-Italic.ttf',   boldItalic: 'Tinos-BoldItalic.ttf' },
  mono:  { regular: 'Cousine-Regular.ttf', bold: 'Cousine-Bold.ttf', italic: 'Cousine-Italic.ttf', boldItalic: 'Cousine-BoldItalic.ttf' },
};

const _cache = new Map();   // filename -> Promise<mupdf.Font>

function variantOf(bold, italic) {
  return bold && italic ? 'boldItalic' : bold ? 'bold' : italic ? 'italic' : 'regular';
}

/**
 * Resolve + cache a bundled edit font.
 * @param mupdf  the loaded mupdf module
 * @param family 'sans' | 'serif' | 'mono' (anything else → sans)
 * @param baseUrl absolute origin to resolve /assets/edit-fonts/ against (worker has no document base)
 * @returns {Promise<Font>}
 */
export function loadEditFont(mupdf, family, bold, italic, baseUrl) {
  const fam = FONT_FILES[family] ? family : 'sans';
  const file = FONT_FILES[fam][variantOf(bold, italic)];
  if (!_cache.has(file)) {
    _cache.set(file, (async () => {
      const url = new URL('/assets/edit-fonts/' + file, baseUrl).href;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`edit font fetch failed (${file}): ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      return new mupdf.Font(file.replace(/\.ttf$/i, ''), bytes);
    })());
  }
  return _cache.get(file);
}
