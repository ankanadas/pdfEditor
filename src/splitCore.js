// Pure (DOM-free) PDF split built on pdf-lib — kept separate from split.js so it can be unit-tested
// in Node without the browser UI. copyPages() preserves each kept page's size, rotation, vector
// content, annotations and quality (no rasterisation); the new document has no outline/bookmark tree
// (dropping cross-page bookmarks that would point at removed pages, keeping the output tiny).
import { PDFDocument } from 'pdf-lib';
import { carryMetadata } from './mergeCore.js';
import { makeZip } from './util/zip.js';

/**
 * Parse a print-style page-range string ("1-5, 8, 11-14") into ORDERED, de-duplicated 0-based page
 * indices within [0, pageCount). 1-based and inclusive, like a print dialog. "5-3" is accepted as
 * "3-5". Out-of-range ends are clamped; wholly-out or unparsable tokens are collected in `bad`.
 * Returns { indices:number[], bad:string[] }.
 */
export function parseRanges(spec, pageCount) {
  const indices = [];
  const seen = new Set();
  const bad = [];
  for (const raw of String(spec == null ? '' : spec).split(',')) {
    const tok = raw.trim();
    if (!tok) continue;
    const m = tok.match(/^(\d+)\s*(?:[-–—]\s*(\d+))?$/);   // "N" or "N-M" (hyphen/en/em dash)
    if (!m) { bad.push(tok); continue; }
    let a = parseInt(m[1], 10);
    let b = m[2] != null ? parseInt(m[2], 10) : a;
    if (a > b) { const t = a; a = b; b = t; }
    if (b < 1 || a > pageCount) { bad.push(tok); continue; }        // wholly out of range
    a = Math.max(1, a); b = Math.min(pageCount, b);
    for (let p = a; p <= b; p++) {
      const i = p - 1;
      if (!seen.has(i)) { seen.add(i); indices.push(i); }
    }
  }
  return { indices, bad };
}

/** New PDF containing only `pageIndices` (0-based, in the given order) copied from srcBytes. */
export async function splitPdfBytes(srcBytes, pageIndices) {
  if (!pageIndices || !pageIndices.length) throw new Error('No pages selected');
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const n = src.getPageCount();
  const idx = pageIndices.filter((i) => i >= 0 && i < n);
  if (!idx.length) throw new Error('No pages in range');
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, idx);
  pages.forEach((p) => out.addPage(p));
  carryMetadata(out, src);
  return out.save();                                    // object streams → compact, lossless
}

/**
 * One 1-page PDF per source page, packaged into a single ZIP (STORE). Returns { zip:Uint8Array,
 * count:number }. `baseName` names the entries (e.g. "document" → "document-1.pdf"). Copies the
 * source once and grafts each page into its own tiny document.
 */
export async function extractAllZipBytes(srcBytes, baseName = 'page', { onProgress } = {}) {
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const n = src.getPageCount();
  const pad = String(n).length;
  const files = [];
  for (let i = 0; i < n; i++) {
    const out = await PDFDocument.create();
    const [p] = await out.copyPages(src, [i]);
    out.addPage(p);
    carryMetadata(out, src);
    const bytes = await out.save();
    files.push({ name: `${baseName}-${String(i + 1).padStart(pad, '0')}.pdf`, bytes });
    if (typeof onProgress === 'function') onProgress(i + 1, n);
  }
  return { zip: makeZip(files), count: n };
}
