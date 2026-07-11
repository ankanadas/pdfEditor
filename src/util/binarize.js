// Otsu binarization pre-pass for OCR — dirty scans (yellowed book pages, faded photocopies, grey
// receipts) recognize far better as crisp black-on-white. Pure histogram math on raw pixel arrays so
// it unit-tests without a canvas; `binarizeForOcr` is the thin canvas wrapper the OCR pipeline uses.
//
// GUARDED, not unconditional:
//  - photo-like pages (continuous tones — a book cover, a map) are left alone: Otsu's separability
//    metric is low when the histogram isn't bimodal, and thresholding a photo shreds it into speckle
//    junk that pollutes recognition;
//  - already-crisp scans (near-white background, near-black ink) are left alone too — no benefit,
//    zero risk of behaviour change for every fixture and document that OCR'd fine before.

/** 256-bin luminance histogram of RGBA pixel data. */
export function luminanceHistogram(data) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    // integer Rec.601 luma — fast and stable across engines
    hist[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++;
  }
  return hist;
}

/**
 * Otsu threshold + the stats the gate needs.
 * Returns { threshold, separability, darkFrac, fgMean, bgMean, total }.
 *  - separability = betweenClassVariance(t*) / totalVariance  (≈1 bimodal document, ≈0 flat/photo)
 *  - darkFrac     = fraction of pixels at/below the threshold (the "ink" class)
 */
export function otsuStats(hist) {
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  if (!total) return { threshold: 128, separability: 0, darkFrac: 0, fgMean: 0, bgMean: 255, total: 0 };
  const mean = sum / total;
  let totalVar = 0;
  for (let i = 0; i < 256; i++) totalVar += hist[i] * (i - mean) * (i - mean);
  totalVar /= total;

  let wB = 0, sumB = 0, best = 0, threshold = 128, fgMean = 0, bgMean = 255;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; threshold = t; fgMean = mB; bgMean = mF; }
  }
  const separability = totalVar > 0 ? (best / (total * total)) / totalVar : 0;
  let dark = 0;
  for (let t = 0; t <= threshold; t++) dark += hist[t];
  return { threshold, separability, darkFrac: dark / total, fgMean, bgMean, total };
}

/** The gate: binarize only a DOCUMENT-shaped page (bimodal, text-like ink fraction) that is actually
 *  DIRTY (dim background or washed-out ink). Crisp scans and photos pass through untouched. */
export function shouldBinarize(stats) {
  const docLike = stats.separability >= 0.55 && stats.darkFrac >= 0.003 && stats.darkFrac <= 0.35;
  const dirty = stats.bgMean < 232 || stats.fgMean > 70;
  return docLike && dirty;
}

/** In-place threshold of RGBA data (below → black, above → white). */
export function applyThreshold(data, threshold) {
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    const v = lum <= threshold ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

/**
 * Canvas wrapper for the OCR pipeline: returns { canvas, applied, stats }. NEVER mutates the input —
 * when the gate fires it draws into a fresh canvas (the input may be the live page canvas).
 */
export function binarizeForOcr(src) {
  try {
    const ctx = src.getContext('2d', { willReadFrequently: true }) || src.getContext('2d');
    const img = ctx.getImageData(0, 0, src.width, src.height);
    const stats = otsuStats(luminanceHistogram(img.data));
    if (!shouldBinarize(stats)) return { canvas: src, applied: false, stats };
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    applyThreshold(img.data, stats.threshold);
    out.getContext('2d').putImageData(img, 0, 0);
    return { canvas: out, applied: true, stats };
  } catch (_) {
    return { canvas: src, applied: false, stats: null };   // tainted/unavailable context → recognize as-is
  }
}
