// Column-aware reading order for OCR'd (scanned) pages — pure geometry, no DOM.
//
// Row-sorted line order interleaves the columns of a multi-column scan (paper, notice, magazine):
// col1-row1, col2-row1, col1-row2… so selection, copy and keyboard navigation jump back and forth
// across the gutter. Order the lines the way a human reads instead: a FULL-WIDTH line (a title, a
// header, a footer band) splits the page into vertical sections; within a section the lines cluster
// into COLUMNS by horizontal overlap, columns read left→right, each column top→bottom. Single-column
// sections come out in plain top-to-bottom order, so ordinary pages are unaffected.
//
// Classic recursive XY-cut style layout analysis, implemented from scratch for our line rects
// ({left, right, top, bottom}); applied only to scan overlays (the caller gates on OCR pages).

const FULL_WIDTH_FRACTION = 0.6;    // a line spanning ≥60% of the content width is a section band
const COLUMN_OVERLAP_FRACTION = 0.3; // lines whose spans overlap ≥30% of the narrower span share a column

/** Order `lines` (objects with left/right/top/bottom) into reading order. Returns a NEW array. */
export function orderLinesForReading(lines, pageWidth) {
  if (!Array.isArray(lines) || lines.length <= 2) return lines ? lines.slice() : [];
  // Content width beats raw page width: a scan with wide margins (or a small map inset) would
  // otherwise never see a "full-width" band. Use the union of the lines' own extent.
  const minL = Math.min(...lines.map((l) => l.left));
  const maxR = Math.max(...lines.map((l) => l.right));
  const contentW = Math.max(1, Math.min(pageWidth || maxR, maxR) - minL);

  const byTop = lines.slice().sort((a, b) => (a.top - b.top) || (a.left - b.left));
  const isBand = (l) => (l.right - l.left) >= contentW * FULL_WIDTH_FRACTION;

  // Walk top→bottom splitting into [band | section(non-band lines)] runs.
  const out = [];
  let section = [];
  const flushSection = () => {
    if (!section.length) return;
    out.push(...orderSection(section));
    section = [];
  };
  for (const l of byTop) {
    if (isBand(l)) { flushSection(); out.push(l); }
    else section.push(l);
  }
  flushSection();
  return out;
}

/** Cluster a section's lines into columns by horizontal overlap; read columns L→R, each top→bottom. */
function orderSection(lines) {
  const columns = [];   // { left, right, lines[] }
  for (const l of lines.slice().sort((a, b) => a.left - b.left)) {
    let home = null;
    for (const c of columns) {
      const overlap = Math.min(c.right, l.right) - Math.max(c.left, l.left);
      const narrower = Math.max(1, Math.min(c.right - c.left, l.right - l.left));
      if (overlap >= narrower * COLUMN_OVERLAP_FRACTION) { home = c; break; }
    }
    if (home) {
      home.lines.push(l);
      home.left = Math.min(home.left, l.left);
      home.right = Math.max(home.right, l.right);
    } else {
      columns.push({ left: l.left, right: l.right, lines: [l] });
    }
  }
  // Growing spans can make columns collide (a wide line bridging two narrow ones) — merge overlaps.
  columns.sort((a, b) => a.left - b.left);
  const merged = [];
  for (const c of columns) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const overlap = Math.min(prev.right, c.right) - Math.max(prev.left, c.left);
      const narrower = Math.max(1, Math.min(prev.right - prev.left, c.right - c.left));
      if (overlap >= narrower * COLUMN_OVERLAP_FRACTION) {
        prev.lines.push(...c.lines);
        prev.right = Math.max(prev.right, c.right);
        continue;
      }
    }
    merged.push(c);
  }
  const ordered = [];
  for (const c of merged) ordered.push(...c.lines.sort((a, b) => (a.top - b.top) || (a.left - b.left)));
  return ordered;
}
