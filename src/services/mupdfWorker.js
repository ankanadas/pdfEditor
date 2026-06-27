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

self.onmessage = async (e) => {
  const { id, type, bytes, password } = e.data || {};
  try {
    if (type === 'ping') {
      await getMupdf();
      self.postMessage({ id, ok: true, result: 'ready' });
      return;
    }
    if (type === 'decrypt') {
      const res = await decrypt(bytes, password);
      const transfer = res.bytes ? [res.bytes.buffer] : [];
      self.postMessage({ id, ok: true, result: res }, transfer);
      return;
    }
    self.postMessage({ id, ok: false, error: `unknown message type: ${type}` });
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
