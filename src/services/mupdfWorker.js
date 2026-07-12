// Web Worker that runs mupdf-wasm (the same MuPDF engine PyMuPDF wraps, compiled to WebAssembly)
// off the main thread. Phase 1: lazy-loads the ~10 MB WASM on first request and handles `decrypt`.
// Edit support is added in Phase 1b. Stays a *fallback* below the live backend until parity is proven.
//
// WASM load: import the .wasm as a content-hashed asset URL (webpack `asset/resource`), fetch its
// bytes, and hand them to mupdf via `globalThis.$libmupdf_wasm_Module = { wasmBinary }` BEFORE the
// dynamic `import('mupdf')` (mupdf.js reads that global at module-eval time). This is deterministic
// and avoids mupdf's own `new URL(..., import.meta.url)` locator guessing the bundled path.
// Resolved by a webpack alias to node_modules/mupdf/dist/mupdf-wasm.wasm (the package's exports map
// hides the .wasm subpath); emitted as a content-hashed asset whose URL we fetch below.
import wasmUrl from 'mupdf-wasm-binary';
import { applyEdits } from './mupdfEdit.js';
import { loadBundledFont } from './mupdfFonts.js';
import { normColor } from './mupdfSpans.js';

let _mupdfPromise = null;
async function getMupdf() {
  if (!_mupdfPromise) {
    _mupdfPromise = (async () => {
      const resp = await fetch(wasmUrl);
      if (!resp.ok) throw new Error(`mupdf wasm fetch failed: ${resp.status}`);
      const wasmBinary = new Uint8Array(await resp.arrayBuffer());
      globalThis.$libmupdf_wasm_Module = { wasmBinary };
      return import('mupdf');
    })();
  }
  return _mupdfPromise;
}

/**
 * Unlock a password-protected PDF entirely in the browser and return a permission-free copy —
 * the WASM equivalent of the backend `/decrypt` (PyMuPDF authenticate + tobytes(ENCRYPT_NONE)).
 * Mirrors PDFBackendService.decryptPDF's return shape so it's a drop-in fallback.
 */
/**
 * Apply text edits + Fabric annotations to a PDF entirely in the browser (the WASM equivalent of the
 * backend /edit-pdf). Throws if it can't do the edit set faithfully so the caller falls through to the
 * pdf-lib tier. Returns a standalone Uint8Array of the edited PDF.
 */
async function edit(bytes, edits, annotations) {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  try {
    if (!(doc instanceof mupdf.PDFDocument)) throw new Error('not a PDF');
    const loadFont = (candidates) => loadBundledFont(mupdf, candidates, self.location.origin);
    // MUST await: applyEdits is async (font fetch), so returning the bare promise would let the
    // `finally` destroy the doc mid-operation. await keeps it alive until the work completes.
    return await applyEdits(mupdf, doc, { edits, annotations }, loadFont, self.location.origin);
  } finally {
    try { doc.destroy(); } catch (_) {}
  }
}

async function decrypt(bytes, password) {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  try {
    const needs = doc.needsPassword();
    if (needs) {
      const level = doc.authenticatePassword(password || '');
      if (!level) return { bytes: null, needsPassword: true, wrongPassword: !!password };
    }
    // Re-save without encryption so the rest of the editor works on plain bytes (saved copy is unlocked).
    const out = doc.saveToBuffer('compress,encrypt=none').asUint8Array();
    // Copy out of WASM heap memory into a standalone ArrayBuffer we can transfer back.
    const copy = out.slice();
    return { bytes: copy, needsPassword: false, wrongPassword: false };
  } finally {
    try { doc.destroy(); } catch (_) {}
  }
}

// Exact per-char ink colours for the editor's line styling (engine-independent, unlike canvas
// pixel sampling, which reads anti-aliased pixels and drifts on WebKit's lighter rasteriser).
// The document stays OPEN in the worker across per-page calls so the bytes cross the worker
// boundary once; `inkclose` (or a new load replacing it) frees it.
const _inkDocs = new Map();
let _inkSeq = 0;

async function inkOpen(bytes) {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const docId = ++_inkSeq;
  _inkDocs.set(docId, doc);
  return { docId, pages: doc.countPages() };
}

function inkPage(docId, pageIndex) {
  const doc = _inkDocs.get(docId);
  if (!doc) throw new Error('ink doc not open');
  const page = doc.loadPage(pageIndex);
  try {
    const colors = [];
    // Raster image placements (top-origin PDF pts, same space as the char origins). The editor's
    // cover strips punch holes over these so a baked signature/initials image that overlaps a text
    // line's band isn't erased from the on-screen page (it was chopped/hidden before).
    const images = [];
    const walker = {
      onChar(_c, origin, _font, size, _quad, color) {
        if (origin) colors.push({ x: origin[0], y: origin[1], rgb: normColor(color), size: +size || 0 });
      },
      onImageBlock(bbox) {
        try {
          const r = bbox || {};
          const x0 = +(r[0] != null ? r[0] : r.x0), y0 = +(r[1] != null ? r[1] : r.y0);
          const x1 = +(r[2] != null ? r[2] : r.x1), y1 = +(r[3] != null ? r[3] : r.y1);
          if (isFinite(x0) && isFinite(y0) && x1 > x0 && y1 > y0) images.push({ x0, y0, x1, y1 });
        } catch (_) {}
      },
    };
    // Never let the images option cost us the colours: fall back to the plain walk on any failure.
    try {
      page.toStructuredText('preserve-whitespace,preserve-images').walk(walker);
    } catch (_) {
      colors.length = 0; images.length = 0;
      page.toStructuredText('preserve-whitespace').walk(walker);
    }
    return { colors, images };
  } finally {
    try { page.destroy(); } catch (_) {}
  }
}

function inkClose(docId) {
  const doc = _inkDocs.get(docId);
  _inkDocs.delete(docId);
  if (doc) { try { doc.destroy(); } catch (_) {} }
  return true;
}

self.onmessage = async (e) => {
  const { id, type, bytes, password, edits, annotations, docId, page } = e.data || {};
  try {
    if (type === 'ping') {
      await getMupdf();
      self.postMessage({ id, ok: true, result: 'ready' });
      return;
    }
    if (type === 'inkopen') {
      self.postMessage({ id, ok: true, result: await inkOpen(bytes) });
      return;
    }
    if (type === 'inkpage') {
      self.postMessage({ id, ok: true, result: inkPage(docId, page) });
      return;
    }
    if (type === 'inkclose') {
      self.postMessage({ id, ok: true, result: inkClose(docId) });
      return;
    }
    if (type === 'decrypt') {
      const res = await decrypt(bytes, password);
      const transfer = res.bytes ? [res.bytes.buffer] : [];
      self.postMessage({ id, ok: true, result: res }, transfer);
      return;
    }
    if (type === 'edit') {
      const out = await edit(bytes, edits, annotations);
      self.postMessage({ id, ok: true, result: out }, [out.buffer]);
      return;
    }
    self.postMessage({ id, ok: false, error: `unknown message type: ${type}` });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
