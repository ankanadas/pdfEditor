// HarfBuzz text shaping for COMPLEX scripts on SAVE (Phase 3, Indic/Arabic/…). The save engine draws Type0
// text as 1 codepoint → 1 glyph (its `encodeCharacter` is a plain cmap lookup, no shaping) — correct for
// Latin/CJK, but WRONG for scripts that need conjuncts (Devanagari स्त), reordering, or contextual joining
// (Arabic). This module lazy-loads harfbuzzjs (~400 KB wasm) + the script's Noto TTF, shapes the run, and
// returns the SHAPED glyph-id sequence so the engine can draw the real letterforms and still embed the font.
//
// Runs in the mupdf edit worker, alongside the font embed. The SAME TTF is shaped here and embedded there
// (loaded from /assets/edit-fonts/), so the glyph ids line up.

// Scripts that genuinely need shaping (their 1:1 draw is wrong) → the bundled save TTF that covers them.
// (CJK, Latin, Cyrillic, Greek are NOT here — they draw correctly 1:1 and go through the normal path.)
const SHAPE_FONT = {
  devanagari: 'NotoSansDevanagari.ttf', bengali: 'NotoSansBengali.ttf', gujarati: 'NotoSansGujarati.ttf',
  gurmukhi: 'NotoSansGurmukhi.ttf', tamil: 'NotoSansTamil.ttf', telugu: 'NotoSansTelugu.ttf',
  kannada: 'NotoSansKannada.ttf', malayalam: 'NotoSansMalayalam.ttf', oriya: 'NotoSansOriya.ttf',
  arabic: 'NotoSansArabic.ttf', hebrew: 'NotoSansHebrew.ttf', thai: 'NotoSansThai.ttf',
};

/** True when a script key needs HarfBuzz shaping to draw correctly (vs the engine's 1:1 path). */
export function needsShaping(script) { return Object.prototype.hasOwnProperty.call(SHAPE_FONT, script); }

let _hbP = null;
const _bytesCache = new Map();   // file -> Promise<Uint8Array>

function getHB() { if (!_hbP) _hbP = import('harfbuzzjs'); return _hbP; }
function getBytes(file, baseUrl) {
  if (!_bytesCache.has(file)) {
    _bytesCache.set(file, (async () => {
      const resp = await fetch(new URL('/assets/edit-fonts/' + file, baseUrl).href);
      if (!resp.ok) throw new Error('font ' + file + ' ' + resp.status);
      return new Uint8Array(await resp.arrayBuffer());
    })());
  }
  return _bytesCache.get(file);
}

/**
 * Shape `text` for `script`. Returns { file, glyphs } — `file` is the TTF the caller must embed, `glyphs` is
 * the shaped sequence `[{ gid, xAdvance, xOffset, yOffset }]` in a 1000-unit em (PDF text space). Returns
 * null when the script isn't a shaping script, the font/HB can't load, or shaping fails (caller then falls
 * back to the flatten tier — never draws wrong glyphs).
 */
export async function shapeRun(script, text, baseUrl) {
  const file = SHAPE_FONT[script];
  if (!file || !text) return null;
  try {
    const { Blob, Face, Font, Buffer, shape } = await getHB();
    const bytes = await getBytes(file, baseUrl);
    // HarfBuzz wants a standalone ArrayBuffer copy of the exact font bytes.
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const blob = new Blob(ab);
    const face = new Face(blob, 0);
    const font = new Font(face);
    const upem = face.upem || 1000;
    const buf = new Buffer();
    buf.addText(text);
    buf.guessSegmentProperties();   // infer script/direction/language from the text
    shape(font, buf);
    const gi = buf.getGlyphInfos(), gp = buf.getGlyphPositions();
    const k = 1000 / upem;
    const glyphs = gi.map((g, i) => ({
      gid: g.codepoint, xAdvance: gp[i].xAdvance * k, xOffset: gp[i].xOffset * k, yOffset: gp[i].yOffset * k,
    }));
    try { buf.destroy(); font.destroy(); face.destroy(); blob.destroy(); } catch (_) {}
    return glyphs.length ? { file, glyphs } : null;
  } catch (_) { return null; }
}
