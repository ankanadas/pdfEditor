// Canvas helpers — pure pixel/geometry ops (no app state). Extracted verbatim from
// PDFEditorApp (was _readRegion / sampleLineColors / trimCanvas / _roundRectPath).

/** Read a w×h region of a source canvas back as RGBA pixel data (robust CPU readback). */
export function readRegion(srcCanvas, x, y, w, h) {
  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, w); tmp.height = Math.max(1, h);
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(srcCanvas, x, y, w, h, 0, 0, w, h);
  return tctx.getImageData(0, 0, w, h).data;
}

/** Sample a text line's background + ink colours from the rendered page canvas. */
export function sampleLineColors(pv, line) {
  try {
    const cw = pv.canvas.width, ch = pv.canvas.height;
    const lh = Math.max(1, line.bottom - line.top);
    const padX = Math.max(6, Math.round(lh * 0.5));   // sample a margin to the sides...
    const padY = Math.max(4, Math.round(lh * 0.35));  // ...and just above / below the text
    const ex0 = Math.max(0, Math.floor(line.left) - padX);
    const ey0 = Math.max(0, Math.floor(line.top) - padY);
    const ex1 = Math.min(cw, Math.ceil(line.right) + padX);
    const ey1 = Math.min(ch, Math.ceil(line.bottom) + padY);
    const w = Math.max(1, ex1 - ex0), h = Math.max(1, ey1 - ey0);
    const data = readRegion(pv.canvas, ex0, ey0, w, h);   // robust readback (CPU canvas)
    // The original text box, in this region's local coordinates.
    const ix0 = Math.floor(line.left) - ex0, iy0 = Math.floor(line.top) - ey0;
    const ix1 = Math.ceil(line.right) - ex0, iy1 = Math.ceil(line.bottom) - ey0;
    const key = (i) => ((data[i] & 0xF0) << 16) | ((data[i + 1] & 0xF0) << 8) | (data[i + 2] & 0xF0);

    const padC = new Map(), padRep = new Map(), inC = new Map(), inRep = new Map();
    for (let py = 0; py < h; py++) {
      const inRow = py >= iy0 && py < iy1;
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4;
        if (data[i + 3] < 128) continue;
        const k = key(i);
        if (inRow && px >= ix0 && px < ix1) {        // inside the text box
          inC.set(k, (inC.get(k) || 0) + 1);
          if (!inRep.has(k)) inRep.set(k, [data[i], data[i + 1], data[i + 2]]);
        } else {                                     // padding = background
          padC.set(k, (padC.get(k) || 0) + 1);
          if (!padRep.has(k)) padRep.set(k, [data[i], data[i + 1], data[i + 2]]);
        }
      }
    }
    // Background = modal colour of the padding (fall back to the box's modal if no padding).
    let bg = null, bgN = -1;
    for (const [k, n] of padC) { if (n > bgN) { bgN = n; bg = padRep.get(k); } }
    if (!bg) { for (const [k, n] of inC) { if (n > bgN) { bgN = n; bg = inRep.get(k); } } }

    // Text = the inside-box colour most distinct from the background. The plain MODAL far-colour
    // skews to the anti-aliased grey EDGES of thin glyphs (Computer Modern / LaTeX body text),
    // which made an edited line look greyed-out in the editor; among the well-represented
    // far-from-bg colours, take the one FARTHEST from the background — the actual ink.
    const far = (c) => !bg || (Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 70);
    let maxFar = 0;
    for (const [k, n] of inC) { if (far(inRep.get(k)) && n > maxFar) maxFar = n; }
    const fromBg = (c) => bg ? (Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2])) : (765 - (c[0] + c[1] + c[2]));
    let text = null, bestDist = -1;
    for (const [k, n] of inC) {
      const c = inRep.get(k);
      if (far(c) && n >= 0.2 * maxFar && fromBg(c) > bestDist) { bestDist = fromBg(c); text = c; }
    }

    return { bg, text };
  } catch (e) {
    console.warn('[QPE] sampleLineColors getImageData failed (canvas tainted?) — falling back', e);
    return { bg: null, text: null };   // e.g. a tainted canvas — caller falls back
  }
}

/** Crop a canvas to its non-transparent content; returns a trimmed PNG data URL + size. */
export function trimCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 12) {
        found = true;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return null;
  const pad = 8;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const tw = maxX - minX + 1, th = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = tw; out.height = th;
  out.getContext('2d').drawImage(canvas, minX, minY, tw, th, 0, 0, tw, th);
  return { dataUrl: out.toDataURL('image/png'), w: tw, h: th };
}

/** Trace a rounded-rectangle path (fallback for canvases without ctx.roundRect). */
export function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
