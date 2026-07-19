// Unicode script detection — decides which font an editable line needs so a non-Latin script DISPLAYS
// correctly in the editor (instead of tofu boxes from the Latin-only fallback). Phase 1 of multi-language
// editing: map text -> script key -> a bundled Noto face; the browser then shapes/renders it. Pure functions.
//
// Ranges are written with \u escapes ON PURPOSE (never literal glyphs) — literal range boundaries get
// mangled by tooling; escapes are unambiguous.

// [scriptKey, RegExp over that script's code-point block(s)]. Latin/common (ASCII, digits, punctuation,
// whitespace, symbols) is NEUTRAL — it doesn't force a special font (Noto script faces include Latin), so a
// mixed "Invoice <hindi>" line is driven by its non-Latin part.
const SCRIPTS = [
  ['devanagari', /[ऀ-ॿ]/],
  ['bengali', /[ঀ-৿]/],
  ['gurmukhi', /[਀-੿]/],
  ['gujarati', /[઀-૿]/],
  ['oriya', /[଀-୿]/],
  ['tamil', /[஀-௿]/],
  ['telugu', /[ఀ-౿]/],
  ['kannada', /[ಀ-೿]/],
  ['malayalam', /[ഀ-ൿ]/],
  ['sinhala', /[඀-෿]/],
  ['thai', /[฀-๿]/],
  ['lao', /[຀-໿]/],
  ['myanmar', /[က-႟]/],
  ['khmer', /[ក-៿]/],
  ['arabic', /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/],
  ['hebrew', /[֐-׿יִ-ﭏ]/],
  ['cjk', /[぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]/], // kana + Hangul + Han
  ['cyrillic', /[Ѐ-ԯ]/],
  ['greek', /[Ͱ-Ͽἀ-῿]/],
  ['armenian', /[԰-֏]/],
  ['georgian', /[Ⴀ-ჿ]/],
  ['ethiopic', /[ሀ-፿]/],
];

// Count matches per script (global). Cheap; for the dominant call we tally match counts.
function tally(text) {
  const t = String(text || '');
  const counts = {};
  for (const [key, re] of SCRIPTS) {
    const g = t.match(new RegExp(re.source, 'g'));
    if (g && g.length) counts[key] = g.length;
  }
  return counts;
}

/**
 * The dominant NON-LATIN script of a string, or 'latin' when it carries no non-Latin letters (so a normal
 * English/European line keeps its normal font). Digits, punctuation and whitespace never force a script.
 * When several non-Latin scripts appear (rare), the most-frequent wins — that picks the face for the box.
 */
export function detectScript(text) {
  const counts = tally(text);
  let best = null, n = 0;
  for (const k in counts) if (counts[k] > n) { n = counts[k]; best = k; }
  return best || 'latin';
}

/** The SET of scripts present in a string (for lazy-loading every face a page needs, not just the dominant). */
export function scriptsInText(text) {
  return new Set(Object.keys(tally(text)));
}

/** The script key of ONE character, or null for Latin/common (ASCII, digits, punctuation, whitespace).
 *  Used to split a MIXED run ("टाइम्स QA कृत") into per-script segments so each is shaped/drawn with a
 *  face that actually has its glyphs — shaping a whole mixed run with one script's Noto face renders the
 *  other script's characters as tofu. */
export function scriptOfChar(ch) {
  for (const [key, re] of SCRIPTS) if (re.test(ch)) return key;
  return null;
}

/** True when the text needs a non-Latin face (i.e. the Latin-only editor fonts would tofu it). */
export function isNonLatin(text) {
  return detectScript(text) !== 'latin';
}

// Right-to-left scripts (Phase 2 bidi): the editable box needs dir="rtl" so the caret, character order and
// alignment behave correctly while typing Arabic/Hebrew. Others (incl. Indic/CJK) are left-to-right.
const RTL = new Set(['arabic', 'hebrew']);

/** True when a script key is right-to-left. */
export function isRtlScript(key) { return RTL.has(key); }

/** 'rtl' | 'ltr' for a string, from its dominant script — drives the editable box's `dir`. */
export function textDirection(text) { return RTL.has(detectScript(text)) ? 'rtl' : 'ltr'; }

/**
 * CSS font-family stack for a script key — the bundled Noto face first, then a broad system fallback so the
 * glyphs still show before/without the woff2 (a device may already have a system CJK/Arabic font). Latin
 * returns '' so callers keep their existing font.
 */
export function fontStackForScript(key) {
  if (!key || key === 'latin') return '';
  const noto = {
    devanagari: "'pf-noto-devanagari', 'Noto Sans Devanagari', sans-serif",
    bengali: "'pf-noto-bengali', 'Noto Sans Bengali', sans-serif",
    gurmukhi: "'pf-noto-gurmukhi', 'Noto Sans Gurmukhi', sans-serif",
    gujarati: "'pf-noto-gujarati', 'Noto Sans Gujarati', sans-serif",
    oriya: "'pf-noto-oriya', 'Noto Sans Oriya', sans-serif",
    tamil: "'pf-noto-tamil', 'Noto Sans Tamil', sans-serif",
    telugu: "'pf-noto-telugu', 'Noto Sans Telugu', sans-serif",
    kannada: "'pf-noto-kannada', 'Noto Sans Kannada', sans-serif",
    malayalam: "'pf-noto-malayalam', 'Noto Sans Malayalam', sans-serif",
    sinhala: "'pf-noto-sinhala', 'Noto Sans Sinhala', sans-serif",
    thai: "'pf-noto-thai', 'Noto Sans Thai', sans-serif",
    lao: "'pf-noto-lao', 'Noto Sans Lao', sans-serif",
    myanmar: "'pf-noto-myanmar', 'Noto Sans Myanmar', sans-serif",
    khmer: "'pf-noto-khmer', 'Noto Sans Khmer', sans-serif",
    arabic: "'pf-noto-arabic', 'Noto Sans Arabic', 'Segoe UI', sans-serif",
    hebrew: "'pf-noto-hebrew', 'Noto Sans Hebrew', sans-serif",
    cjk: "'pf-noto-cjk', 'Noto Sans CJK SC', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    cyrillic: '', greek: '',   // covered by the Latin faces already bundled
    armenian: "'pf-noto-armenian', 'Noto Sans Armenian', sans-serif",
    georgian: "'pf-noto-georgian', 'Noto Sans Georgian', sans-serif",
    ethiopic: "'pf-noto-ethiopic', 'Noto Sans Ethiopic', sans-serif",
  };
  return noto[key] || '';
}
