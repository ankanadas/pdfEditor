// Plain-text / RTF export of a document's (OCR'd or native) text — with automatic HEADER / FOOTER /
// PAGE-NUMBER stripping, so a scanned book comes out as clean prose instead of "CHAPTER TWO … 47 …
// running head" noise on every page. Pure functions over line records so everything unit-tests.
//
// A line is stripped as furniture when it sits in the TOP or BOTTOM band of the page AND is either
//  (a) a page number (digits / roman numerals / "Page 12 of 90"-shaped), or
//  (b) a RUNNING line: its digit-normalised text recurs in the same band on several pages
//      (a real heading appears once; "LEIGH BARDUGO" on every verso is furniture).
// Body text is NEVER touched: the zone gate keeps mid-page lines out of reach entirely.

const BAND_FRACTION = 0.12;          // top/bottom 12% of the page height counts as the furniture zone
const MIN_REPEATS = 3;               // a banded line must recur on ≥3 pages to be a running head/foot

const PAGE_NUM_RE = /^(?:page\s*)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?$/i;

/** Normalise a line for repetition matching: digits collapse so "Chapter 4 · 47" == "Chapter 4 · 48". */
export function normalizeForRepeat(text) {
  return (text || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Classify furniture lines. `pages` = [{ height, lines: [{ text, top, bottom }] }]. Returns a
 *  parallel array of Sets holding the indices of stripped lines per page. */
export function classifyFurniture(pages) {
  const bandOf = (ln, h) => {
    const mid = (ln.top + ln.bottom) / 2;
    if (mid <= h * BAND_FRACTION) return 'top';
    if (mid >= h * (1 - BAND_FRACTION)) return 'bottom';
    return null;
  };
  // pass 1: count banded normalised lines across pages
  const counts = new Map();
  pages.forEach((pg) => {
    (pg.lines || []).forEach((ln) => {
      const band = bandOf(ln, pg.height);
      if (!band) return;
      const key = band + '|' + normalizeForRepeat(ln.text);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });
  // pass 2: strip page numbers + recurring banded lines
  return pages.map((pg) => {
    const dropped = new Set();
    (pg.lines || []).forEach((ln, i) => {
      const band = bandOf(ln, pg.height);
      if (!band) return;
      const t = (ln.text || '').trim();
      if (PAGE_NUM_RE.test(t)) { dropped.add(i); return; }
      const key = band + '|' + normalizeForRepeat(t);
      if (t && counts.get(key) >= MIN_REPEATS) dropped.add(i);
    });
    return dropped;
  });
}

const SYMBOL_TOKEN = /^[^A-Za-z0-9]+$/;    // a token made purely of punctuation / symbols

/** Drop pure-symbol tokens from a line ("Engineer ~ |" → "Engineer"). Keeps word/number tokens. */
export function cleanNoiseTokens(text) {
  return (text || '').split(/\s+/).filter((w) => w && !SYMBOL_TOKEN.test(w)).join(' ').trim();
}

/** Is this whole line OCR SPECKLE rather than prose? A scanned MAP / dirty scan makes Tesseract emit a
 *  storm of 1–2 char fragments and lone symbols ("ny", "Ja", "~", "§", "37)"), each landing on its own
 *  line — 70%+ of a map's "words". A line is noise when it has NO real word (a 3+-letter token) and is
 *  not a coherent run of several short word tokens. Any line carrying a 3+-letter word is KEPT, so real
 *  prose ("Application for the position of Engineer") is never touched. */
export function isNoiseLine(text) {
  const tokens = (text || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const realWords = tokens.filter((w) => (w.match(/[A-Za-z]/g) || []).length >= 3).length;
  if (realWords >= 1) return false;
  if (/\d{3,}/.test(text || '')) return false;   // a contiguous digit RUN = ZIP / id / year / number, not speckle
  const letters = ((text || '').match(/[A-Za-z]/g) || []).length;
  if (tokens.length >= 4 && letters >= tokens.length) return false;   // several short word-tokens = text
  return true;
}

/** Build the export payload. Returns { txt, rtf, strippedCount, denoisedCount }.
 *  opts.strip (default true) = header/footer/page-number furniture removal.
 *  opts.denoise (default false) = drop OCR speckle lines (see isNoiseLine) — on for scanned exports. */
export function buildDocumentText(pages, opts = {}) {
  const strip = opts.strip !== false;
  const denoise = opts.denoise === true;
  const dropped = strip ? classifyFurniture(pages) : pages.map(() => new Set());
  const pageTexts = [];
  let strippedCount = 0, denoisedCount = 0;
  pages.forEach((pg, pi) => {
    const kept = [];
    (pg.lines || []).forEach((ln, i) => {
      if (dropped[pi].has(i)) { strippedCount++; return; }
      let text = (ln.text || '').trim();
      if (!text) return;
      if (denoise) {
        text = cleanNoiseTokens(text);
        if (!text || isNoiseLine(text)) { denoisedCount++; return; }
      }
      kept.push(text);
    });
    pageTexts.push(kept.join('\n'));
  });
  const txt = pageTexts.join('\n\n');
  return { txt, rtf: buildRtf(pageTexts), strippedCount, denoisedCount };
}

/** A complete, valid RTF document (RTF 1.5): proper header, font table, escaped text, \par line
 *  breaks and \page between pages — opens in Word / TextEdit / Pages / Google Docs as-is. */
export function buildRtf(pageTexts) {
  const esc = (s) => s
    .replace(/\\/g, '\\\\').replace(/{/g, '\\{').replace(/}/g, '\\}')
    .replace(/[\u0080-\uffff]/g, (ch) => '\\u' + (ch.charCodeAt(0) > 32767 ? ch.charCodeAt(0) - 65536 : ch.charCodeAt(0)) + '?');
  const body = pageTexts
    .map((pt) => pt.split('\n').map((l) => esc(l) + '\\par').join('\n'))
    .join('\n\\page\n');
  return '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Helvetica;}}\n' +
         '{\\*\\generator Quick PDF Editor}\\f0\\fs24\n' + body + '\n}';
}
