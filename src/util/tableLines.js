// Table / grid line detection for the "readable PDF" reconstruction. Pure pixel analysis over a page
// canvas: find the long, THIN horizontal & vertical dark runs that make up table borders, grid lines and
// dividers, then merge adjacent runs into single rules with a thickness. The caller overlays crisp native
// vector lines (pdf-lib drawLine) at these positions so grids become mathematically sharp and scalable.
//
// Guards against false rules from text: a rule must be LONG (a big fraction of the page) AND THIN (a merged
// band only a few px tall/wide — a filled/bold region is not a rule). Returned coords are CANVAS PIXELS.

/** Detect horizontal & vertical rules in a canvas. Returns { horizontal:[{x0,x1,y,thick}], vertical:[...] }. */
export function detectTableLines(canvas, opts = {}) {
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return { horizontal: [], vertical: [] };
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let data;
  try { data = ctx.getImageData(0, 0, W, H).data; } catch (_) { return { horizontal: [], vertical: [] }; }
  // Adaptive threshold: a "line" pixel is one notably DARKER than the page BACKGROUND, so faint GREY
  // rules count — not only near-black borders. Estimate the bg as a high percentile of a coarse grid
  // (the bright majority), then a line pixel is ≥ ~150 (of r+g+b) below it. Clamped so a light-shaded
  // page can't turn its whole background into "lines".
  let darkSum = opts.darkSum;
  if (!darkSum) {
    const samp = [];
    for (let y = 0; y < H; y += 13) for (let x = 0; x < W; x += 13) { const i = (y * W + x) * 4; if (data[i + 3] > 100) samp.push(data[i] + data[i + 1] + data[i + 2]); }
    samp.sort((a, b) => a - b);
    const bg = samp.length ? samp[Math.floor(samp.length * 0.72)] : 720;   // ~72nd pctile ≈ background
    darkSum = Math.max(300, Math.min(660, bg - 150));
  }
  const dark = (x, y) => { const i = (y * W + x) * 4; return data[i + 3] > 100 && (data[i] + data[i + 1] + data[i + 2]) < darkSum; };
  const minH = Math.max(40, Math.round(W * (opts.minFrac || 0.25)));   // horiz rule spans ≥25% page width
  const minV = Math.max(40, Math.round(H * (opts.minFrac || 0.25)));
  const maxThick = opts.maxThick || 6;                          // a rule is at most this many px thick

  // --- raw long runs per row (horizontal) / per column (vertical) ---
  const hRaw = [], vRaw = [];
  for (let y = 0; y < H; y++) {
    let run = 0, x0 = 0;
    for (let x = 0; x <= W; x++) {
      if (x < W && dark(x, y)) { if (!run) x0 = x; run++; }
      else { if (run >= minH) hRaw.push({ y, x0, x1: x - 1 }); run = 0; }
    }
  }
  for (let x = 0; x < W; x++) {
    let run = 0, y0 = 0;
    for (let y = 0; y <= H; y++) {
      if (y < H && dark(x, y)) { if (!run) y0 = y; run++; }
      else { if (run >= minV) vRaw.push({ x, y0, y1: y - 1 }); run = 0; }
    }
  }

  // --- merge runs on adjacent rows/cols (that overlap along their length) into one thick rule ---
  const mergeH = () => {
    hRaw.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const out = [];
    for (const r of hRaw) {
      const m = out.find((o) => Math.abs(o.y2 - r.y) <= 2 && Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 0);
      if (m) { m.y2 = r.y; m.x0 = Math.min(m.x0, r.x0); m.x1 = Math.max(m.x1, r.x1); }
      else out.push({ y: r.y, y2: r.y, x0: r.x0, x1: r.x1 });
    }
    return out.filter((o) => (o.y2 - o.y) < maxThick)
      .map((o) => ({ x0: o.x0, x1: o.x1, y: Math.round((o.y + o.y2) / 2), thick: (o.y2 - o.y) + 1 }));
  };
  const mergeV = () => {
    vRaw.sort((a, b) => a.x - b.x || a.y0 - b.y0);
    const out = [];
    for (const r of vRaw) {
      const m = out.find((o) => Math.abs(o.x2 - r.x) <= 2 && Math.min(o.y1, r.y1) - Math.max(o.y0, r.y0) > 0);
      if (m) { m.x2 = r.x; m.y0 = Math.min(m.y0, r.y0); m.y1 = Math.max(m.y1, r.y1); }
      else out.push({ x: r.x, x2: r.x, y0: r.y0, y1: r.y1 });
    }
    return out.filter((o) => (o.x2 - o.x) < maxThick)
      .map((o) => ({ y0: o.y0, y1: o.y1, x: Math.round((o.x + o.x2) / 2), thick: (o.x2 - o.x) + 1 }));
  };

  return { horizontal: mergeH(), vertical: mergeV() };
}
