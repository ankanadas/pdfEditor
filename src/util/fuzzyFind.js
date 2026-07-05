// Client-side fuzzy find for the PDF text layer. Dependency-free (no fuse.js — the offline bundle
// stays lean): normalises the text anomalies PDFs actually produce (ligatures via NFKC, curly
// quotes/dashes, NBSP, soft hyphens, collapsed whitespace runs), then finds approximate substring
// matches with an edit-distance budget scaled to the query length. Pure functions, no DOM.

const FOLD = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '−': '-',
  ' ': ' ',
};

/**
 * Normalise `s` for matching. Returns { norm, map } where map[i] is the index in the ORIGINAL
 * string of the character that produced norm[i], so match offsets translate back exactly.
 * Whitespace runs collapse to one space (mapped to the run's first char); soft hyphens vanish.
 * `keepCase` skips the case fold (Match-case searches) — every other PDF normalisation
 * (ligatures, curly quotes, dashes, NBSP) still applies.
 */
export function normalizeWithMap(s, keepCase = false) {
  let norm = '';
  const map = [];
  let ws = -1;                                   // original index of a pending whitespace run
  for (let i = 0; i < s.length; i++) {
    const raw = s[i];
    if (raw === '­') continue;              // soft hyphen: PDF line-break artefact
    const nfkc = (FOLD[raw] || raw).normalize('NFKC');
    const folded = keepCase ? nfkc : nfkc.toLowerCase();
    for (const c of folded) {
      if (/\s/.test(c)) { if (norm && ws < 0) ws = i; continue; }
      if (ws >= 0) { norm += ' '; map.push(ws); ws = -1; }
      norm += c; map.push(i);
    }
  }
  return { norm, map };
}

/** Edit budget for a query length: exact under 4 chars, 1 typo under 8, else 2. */
export function editBudget(len) {
  return len >= 8 ? 2 : len >= 4 ? 1 : 0;
}

// Fuzzy scanning is O(len(text) × len(query)); lines are short, but guard pathological inputs.
const FUZZY_TEXT_CAP = 5000;

/**
 * Approximate matches of `query` in `text`. Returns non-overlapping matches in text order:
 * [{ start, end, dist }] with start/end as ORIGINAL-string offsets (end exclusive) and dist the
 * edit distance (0 = exact after normalisation). Exact matches always win over fuzzy overlaps.
 * opts.matchCase: compare case-SENSITIVELY ("exact match case" — a case difference is a miss,
 * not a fuzzy hit, so callers should pass maxEdits=0 alongside it; the search UI does).
 */
export function findInText(text, query, maxEdits, opts = {}) {
  const keepCase = !!opts.matchCase;
  const { norm, map } = normalizeWithMap(String(text ?? ''), keepCase);
  const q = normalizeWithMap(String(query ?? ''), keepCase).norm;
  if (!q || !norm) return [];
  const E = maxEdits == null ? editBudget(q.length) : maxEdits;

  const found = [];
  for (let at = norm.indexOf(q); at >= 0; at = norm.indexOf(q, at + 1)) {
    found.push({ s: at, e: at + q.length, dist: 0 });
  }

  if (E > 0 && norm.length <= FUZZY_TEXT_CAP) {
    // Approximate-substring DP with a free start anywhere in the haystack: D[i][j] is the best
    // distance matching the first i query chars ending at haystack position j; S carries the
    // start position that distance came from, so each end position knows its own match start.
    const m = q.length, n = norm.length;
    let prev = new Array(n + 1).fill(0);
    let prevS = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = new Array(n + 1);
      const curS = new Array(n + 1);
      cur[0] = i; curS[0] = 0;
      for (let j = 1; j <= n; j++) {
        let d = prev[j - 1] + (q[i - 1] === norm[j - 1] ? 0 : 1);   // substitute / match
        let st = prevS[j - 1];
        if (prev[j] + 1 < d) { d = prev[j] + 1; st = prevS[j]; }    // query char unmatched
        if (cur[j - 1] + 1 < d) { d = cur[j - 1] + 1; st = curS[j - 1]; } // extra text char
        cur[j] = d; curS[j] = st;
      }
      prev = cur; prevS = curS;
    }
    for (let j = 1; j <= n; j++) {
      // local best: skip positions where extending by one more char does at least as well
      if (prev[j] <= E && prev[j] > 0 && (j === n || prev[j] < prev[j + 1] || norm[j] === ' ')) {
        found.push({ s: prevS[j], e: j, dist: prev[j] });
      }
    }
  }

  // Best-first (exact before fuzzy, then leftmost, then longest), keep non-overlapping.
  found.sort((a, b) => a.dist - b.dist || a.s - b.s || (b.e - b.s) - (a.e - a.s));
  const taken = [];
  for (const f of found) {
    if (f.e <= f.s) continue;
    if (taken.some((t) => f.s < t.e && f.e > t.s)) continue;
    taken.push(f);
  }
  taken.sort((a, b) => a.s - b.s);

  const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
  return taken.map((f) => {
    let { s, e } = f;
    while (s < e && norm[s] === ' ') s++;          // never anchor a match on a synthetic space
    while (e > s && norm[e - 1] === ' ') e--;
    return { s, e, dist: f.dist };
  }).filter((f) => {
    if (f.e <= f.s) return false;
    // A FUZZY (edit-distance) match must sit on WORD BOUNDARIES on both ends. Without this an
    // approximate match lands INSIDE a longer word — query "JOIN" matched "ROIN" within "GROIN",
    // "POIN" within "SPOIN" — so searching an exact word read as if it silently dropped letters.
    // Exact matches (dist 0) still match substrings anywhere, like Ctrl+F ("join" inside "adjoin").
    if (f.dist > 0 && (isWordChar(norm[f.s - 1]) || isWordChar(norm[f.e]))) return false;
    return true;
  }).map((f) => ({ start: map[f.s], end: map[f.e - 1] + 1, dist: f.dist }));
}
