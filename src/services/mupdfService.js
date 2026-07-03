// Main-thread facade for the mupdf-wasm Web Worker. Mirrors PDFBackendService so it can slot into
// the existing save/decrypt fallback chains as a drop-in tier. The worker (and its ~10 MB WASM) is
// spawned lazily on first use and kept off the main thread; bytes cross as transferable ArrayBuffers
// (no base64). Everything runs in the browser — nothing is uploaded.
//
// Phase 1 exposes: isSupported(), ready(), decryptPDF(). editPDF() arrives in Phase 1b.

let _worker = null;
let _seq = 0;
const _pending = new Map();

function getWorker() {
  if (_worker) return _worker;
  // new URL(..., import.meta.url) is webpack 5's worker idiom — it emits mupdfWorker.js as its own
  // chunk (same pattern as the pdf.js worker in app.js). type:'module' so the worker can use imports.
  _worker = new Worker(new URL('./mupdfWorker.js', import.meta.url), { type: 'module' });
  _worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data || {};
    const entry = _pending.get(id);
    if (!entry) return;
    _pending.delete(id);
    ok ? entry.resolve(result) : entry.reject(new Error(error || 'mupdf worker error'));
  };
  _worker.onerror = (e) => {
    // A worker-level failure rejects everything in flight so callers fall through to the next tier.
    const err = new Error((e && e.message) || 'mupdf worker crashed');
    for (const { reject } of _pending.values()) reject(err);
    _pending.clear();
    _worker = null;
  };
  return _worker;
}

function call(type, payload = {}, transfer = []) {
  const id = ++_seq;
  const worker = getWorker();
  return new Promise((resolve, reject) => {
    _pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
}

export const MupdfService = {
  /** WebAssembly + module Worker support — gate spawning on this (older/locked-down browsers). */
  isSupported() {
    return typeof Worker === 'function' && typeof WebAssembly === 'object';
  },

  /** Force the worker + WASM to load (lazy warm-up). Resolves 'ready' or rejects. */
  async ready() {
    if (!this.isSupported()) throw new Error('mupdf-wasm unsupported in this browser');
    return call('ping');
  },

  /**
   * Unlock a password-protected PDF in the browser (WASM). Drop-in for PDFBackendService.decryptPDF:
   * returns { bytes: Uint8Array|null, needsPassword, wrongPassword }.
   * @param {ArrayBuffer} pdfArrayBuffer
   * @param {string} password
   */
  async decryptPDF(pdfArrayBuffer, password = '') {
    if (!this.isSupported()) throw new Error('mupdf-wasm unsupported in this browser');
    // Copy to a fresh ArrayBuffer we can transfer without detaching the caller's buffer.
    const buf = pdfArrayBuffer instanceof ArrayBuffer
      ? pdfArrayBuffer.slice(0)
      : new Uint8Array(pdfArrayBuffer).slice().buffer;
    return call('decrypt', { bytes: buf, password }, [buf]);
  },

  /**
   * Apply text edits + Fabric annotations in the browser (WASM). Drop-in for PDFBackendService.editPDF;
   * resolves a Uint8Array of edited bytes, or REJECTS if the edit set isn't faithfully supported yet
   * (the caller then falls through to the pdf-lib tier).
   * @param {ArrayBuffer} pdfArrayBuffer
   * @param {Array} edits
   * @param {Array} [annotations]
   * @returns {Promise<Uint8Array>}
   */
  async editPDF(pdfArrayBuffer, edits, annotations = []) {
    if (!this.isSupported()) throw new Error('mupdf-wasm unsupported in this browser');
    const buf = pdfArrayBuffer instanceof ArrayBuffer
      ? pdfArrayBuffer.slice(0)
      : new Uint8Array(pdfArrayBuffer).slice().buffer;
    return call('edit', { bytes: buf, edits, annotations }, [buf]);
  },

  /**
   * Open the current document in the worker for exact per-char ink colours (kept open across
   * per-page calls; close with inkClose). Resolves { docId, pages }.
   */
  async inkOpen(pdfArrayBuffer) {
    if (!this.isSupported()) throw new Error('mupdf-wasm unsupported in this browser');
    const buf = pdfArrayBuffer instanceof ArrayBuffer
      ? pdfArrayBuffer.slice(0)
      : new Uint8Array(pdfArrayBuffer).slice().buffer;
    return call('inkopen', { bytes: buf }, [buf]);
  },

  /** Per-char [{x, y, rgb:[0..1]×3, size}] for a 0-based page of an inkOpen'd document. */
  async inkPage(docId, page) {
    return call('inkpage', { docId, page });
  },

  /** Free an inkOpen'd document (fire-and-forget). */
  inkClose(docId) {
    call('inkclose', { docId }).catch(() => {});
  },
};
