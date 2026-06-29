// Pure (DOM-free) PDF merge built on pdf-lib. Kept separate from merge.js so it can be
// unit-tested in Node/jsdom without pulling in PDF.js or the browser UI.
import { PDFDocument } from 'pdf-lib';

// Merge an ordered list of PDF byte buffers (Uint8Array / ArrayBuffer) into one.
// copyPages() preserves each page's size, rotation, vector content and quality (no
// rasterisation). Metadata is carried over from the first document. Returns Uint8Array.
export async function mergePdfBytes(byteArrays, { onProgress } = {}) {
  if (!byteArrays || byteArrays.length < 1) throw new Error('No PDFs to merge');

  const out = await PDFDocument.create();
  let firstDoc = null;

  for (let i = 0; i < byteArrays.length; i++) {
    const src = await PDFDocument.load(byteArrays[i], { ignoreEncryption: true });
    if (!firstDoc) firstDoc = src;
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    if (typeof onProgress === 'function') onProgress(i + 1, byteArrays.length);
  }

  carryMetadata(out, firstDoc);
  // NOTE: no setProducer/setModificationDate here — pdf-lib's save() overwrites both with its
  // own values (verified), so setting them is dead code.

  return out.save(); // object streams on by default → compact, lossless
}

// Best-effort: copy descriptive metadata from the first source document.
export function carryMetadata(out, src) {
  if (!src) return;
  try {
    const title = src.getTitle(); if (title) out.setTitle(title);
    const author = src.getAuthor(); if (author) out.setAuthor(author);
    const subject = src.getSubject(); if (subject) out.setSubject(subject);
    const creator = src.getCreator(); if (creator) out.setCreator(creator);
    const kw = src.getKeywords(); if (kw) out.setKeywords(Array.isArray(kw) ? kw : [kw]);
  } catch (_) { /* metadata is best-effort */ }
}
