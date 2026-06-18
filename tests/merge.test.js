// Unit tests for the pure PDF merge (src/mergeCore.js). Runs in jest's jsdom env using
// pdf-lib directly — no PDF.js / DOM needed.
import { describe, it, expect } from '@jest/globals';
import { PDFDocument, degrees } from 'pdf-lib';
import { mergePdfBytes } from '../src/mergeCore.js';

// Build a tiny PDF; each spec is { w, h, rot? }. Returns Uint8Array bytes.
async function makePdf(pageSpecs, meta = {}) {
  const doc = await PDFDocument.create();
  if (meta.title) doc.setTitle(meta.title);
  if (meta.author) doc.setAuthor(meta.author);
  for (const s of pageSpecs) {
    const p = doc.addPage([s.w, s.h]);
    if (s.rot) p.setRotation(degrees(s.rot));
  }
  return doc.save();
}

describe('mergePdfBytes', () => {
  it('merges in order and preserves total page count', async () => {
    const a = await makePdf([{ w: 200, h: 300 }, { w: 200, h: 300 }]);
    const b = await makePdf([{ w: 400, h: 500 }]);
    const out = await PDFDocument.load(await mergePdfBytes([a, b]));
    expect(out.getPageCount()).toBe(3);
  });

  it('preserves each page size and rotation', async () => {
    const a = await makePdf([{ w: 200, h: 300 }]);
    const b = await makePdf([{ w: 400, h: 500, rot: 90 }]);
    const out = await PDFDocument.load(await mergePdfBytes([a, b]));
    expect(Math.round(out.getPage(0).getWidth())).toBe(200);
    expect(Math.round(out.getPage(0).getHeight())).toBe(300);
    expect(Math.round(out.getPage(1).getWidth())).toBe(400);
    expect(out.getPage(1).getRotation().angle).toBe(90); // rotation kept
  });

  it('respects input order (reordering changes the result)', async () => {
    const a = await makePdf([{ w: 222, h: 300 }]);
    const b = await makePdf([{ w: 444, h: 300 }]);
    const m1 = await PDFDocument.load(await mergePdfBytes([a, b]));
    const m2 = await PDFDocument.load(await mergePdfBytes([b, a]));
    expect(Math.round(m1.getPage(0).getWidth())).toBe(222);
    expect(Math.round(m2.getPage(0).getWidth())).toBe(444);
  });

  it('carries metadata from the first document', async () => {
    const a = await makePdf([{ w: 200, h: 300 }], { title: 'First Doc', author: 'Ankana' });
    const b = await makePdf([{ w: 200, h: 300 }], { title: 'Second Doc' });
    const out = await PDFDocument.load(await mergePdfBytes([a, b]));
    expect(out.getTitle()).toBe('First Doc');
    expect(out.getAuthor()).toBe('Ankana');
  });

  it('reports progress once per input file', async () => {
    const a = await makePdf([{ w: 200, h: 300 }]);
    const b = await makePdf([{ w: 200, h: 300 }]);
    const c = await makePdf([{ w: 200, h: 300 }]);
    const calls = [];
    await mergePdfBytes([a, b, c], { onProgress: (done, total) => calls.push([done, total]) });
    expect(calls).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('throws on an empty list', async () => {
    await expect(mergePdfBytes([])).rejects.toThrow();
  });

  it('merges a single file (the panel now allows 1+)', async () => {
    const a = await makePdf([{ w: 300, h: 400 }]);
    const out = await PDFDocument.load(await mergePdfBytes([a]));
    expect(out.getPageCount()).toBe(1);
  });

  it('produces output that re-loads and is editable (no circular page tree)', async () => {
    const a = await makePdf([{ w: 200, h: 300 }, { w: 200, h: 300 }]);
    const b = await makePdf([{ w: 400, h: 500 }]);
    const merged = await mergePdfBytes([a, b]);
    // Re-opening + traversing pages is exactly what the editor does on save; it must not
    // throw "Pages tree contains circular reference".
    const reopened = await PDFDocument.load(merged, { ignoreEncryption: true });
    expect(() => reopened.getPages()).not.toThrow();
    expect(reopened.getPages().length).toBe(3);
    // and it can be merged again (e.g. re-merging the current document)
    const again = await PDFDocument.load(await mergePdfBytes([merged, b]));
    expect(again.getPageCount()).toBe(4);
  });
});
