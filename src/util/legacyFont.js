// Detect a page whose text comes from a LEGACY non-Unicode Indic font (Kruti Dev / APS-DV / DevLys /
// Chanakya / Priyanka …). These fonts map Devanagari GLYPHS onto Latin codepoints, so the page DRAWS
// correctly but its extracted text is accented-Latin + symbol garbage ("ÙetLe keâe@efchšerMeve") that no
// editable box can render (the font resolves to a sans-serif fallback). On such a page the editor should
// skip the editable boxes/cover strips and just show the (correct) canvas render — view + annotate only.
//
// The item's fontName is a PDF.js internal id (g_d0_f15) and the family resolves to a fallback, so the
// real font name isn't available — detect from the TEXT, CHAR-weighted (a TOC page dilutes an item count
// with clean leader-dots and page numbers). Two fingerprints a glyph-on-Latin font leaves that normal and
// European text do NOT: (1) accented / Extended-Latin chars, AND (2) UPPERCASE mid-word (the font
// case-encodes glyphs: "etLe", "DeOÙe"). Real English ≈ 0 on both; French/Spanish carry (1) but ≈ 0 of
// (2), so they stay well under the threshold; a real UNICODE Devanagari/Arabic/CJK PDF lives in its own
// block with no accented Latin, so it is never flagged and stays fully editable.

/** @returns {boolean} true when a page shows BOTH legacy glyph-on-Latin fingerprints. */
export function isLegacyGarbledPage(items) {
  const txt = (items || []).filter((t) => t && (t.text || '').trim());
  if (txt.length < 8) return false;
  let acc = 0, up = 0, tot = 0;
  for (const t of txt) {
    const s = (t.text || '').replace(/\s/g, '');
    tot += s.length;
    acc += (s.match(/[À-ɏ]/g) || []).length;               // accented / Extended Latin
    up += (s.match(/[a-zà-ÿ][A-ZÀ-Þ]/g) || []).length;     // lowercase → UPPERCASE within a word
  }
  if (!tot) return false;
  // BOTH fingerprints must be present. A glyph-on-Latin Indic font emits accented Latin AND mid-word
  // uppercase (it case-encodes glyphs). European text (French/Spanish/German) is accent-dense but has ~no
  // mid-word uppercase — so requiring the uppercase signal too keeps it EDITABLE. English has neither;
  // real Unicode Devanagari/Arabic/CJK carries no accented Latin. Real 2396 pages clear both comfortably.
  return acc / tot > 0.015 && up / tot > 0.02;
}
