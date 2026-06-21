/**
 * Service to communicate with Python backend for PDF processing
 */

// Backend base URL. For production (e.g. a hosted Flask app), set `window.PDF_BACKEND_URL`
// in index.html. In local dev it defaults to 127.0.0.1:5001 — using 127.0.0.1 (not
// "localhost") because on macOS "localhost" can resolve to IPv6 (::1) and miss the backend,
// and port 5001 because 5000 is taken by AirPlay Receiver.
const BACKEND_URL = (typeof window !== 'undefined' && window.PDF_BACKEND_URL) || 'http://127.0.0.1:5001';

export class PDFBackendService {
  /**
   * Check if backend is running
   */
  static async checkHealth() {
    try {
      // Short timeout so a missing backend (e.g. on static hosting) falls back to the
      // client-side save quickly instead of stalling.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const response = await fetch(`${BACKEND_URL}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      const data = await response.json();
      return data.status === 'ok';
    } catch (error) {
      return false;   // backend unreachable -> caller uses the client-side fallback
    }
  }

  /**
   * Extract text with positions from PDF
   * @param {File} pdfFile - The PDF file
   * @returns {Promise<Object>} - Extracted text data
   */
  static async extractText(pdfFile) {
    try {
      const formData = new FormData();
      formData.append('file', pdfFile);

      const response = await fetch(`${BACKEND_URL}/extract-text`, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Backend error: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Text extraction failed:', error);
      throw error;
    }
  }

  /**
   * Edit PDF using backend
   * @param {ArrayBuffer} pdfArrayBuffer - The PDF as ArrayBuffer
   * @param {Array} edits - Array of text/erase/image edit operations
   * @param {Array} [annotations] - Optional Fabric annotation descriptors (from annotationManager.serialize())
   * @returns {Promise<Uint8Array>} - Edited PDF bytes
   */
  static async editPDF(pdfArrayBuffer, edits, annotations = []) {
    try {
      // Convert ArrayBuffer to base64 in chunks to avoid stack overflow
      const pdfBytes = new Uint8Array(pdfArrayBuffer);
      
      // Convert to base64 using a more efficient method
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < pdfBytes.length; i += chunkSize) {
        const chunk = pdfBytes.subarray(i, Math.min(i + chunkSize, pdfBytes.length));
        binary += String.fromCharCode.apply(null, chunk);
      }
      const pdfBase64 = btoa(binary);

      const response = await fetch(`${BACKEND_URL}/edit-pdf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          pdfBase64: pdfBase64,
          edits: edits,
          // Pass Fabric annotation descriptors so the backend can burn them in with
          // PyMuPDF's native APIs (real PDF highlight annotations, proper opacity, etc.)
          annotations: annotations,
        })
      });

      if (!response.ok) {
        throw new Error(`Backend error: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Edit failed');
      }

      // Convert base64 back to Uint8Array in chunks
      const editedPdfBase64 = data.pdfBase64;
      const editedPdfString = atob(editedPdfBase64);
      const editedPdfBytes = new Uint8Array(editedPdfString.length);
      for (let i = 0; i < editedPdfString.length; i++) {
        editedPdfBytes[i] = editedPdfString.charCodeAt(i);
      }

      return editedPdfBytes;
    } catch (error) {
      console.error('PDF edit failed:', error);
      throw error;
    }
  }

  /**
   * Unlock a password-protected PDF via the backend (PyMuPDF). Returns an unlocked copy so the
   * rest of the editor (render / edit / save) works on plain bytes.
   * @param {ArrayBuffer} pdfArrayBuffer - The encrypted PDF as ArrayBuffer
   * @param {string} password - The user-supplied open password ('' for empty/permission-only)
   * @returns {Promise<{bytes: Uint8Array|null, needsPassword: boolean, wrongPassword: boolean}>}
   */
  static async decryptPDF(pdfArrayBuffer, password = '') {
    const pdfBytes = new Uint8Array(pdfArrayBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < pdfBytes.length; i += chunkSize) {
      const chunk = pdfBytes.subarray(i, Math.min(i + chunkSize, pdfBytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    const pdfBase64 = btoa(binary);

    const response = await fetch(`${BACKEND_URL}/decrypt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfBase64, password })
    });
    if (!response.ok) throw new Error(`Backend error: ${response.statusText}`);

    const data = await response.json();
    if (!data.success) {
      return { bytes: null, needsPassword: !!data.needsPassword, wrongPassword: !!data.wrongPassword };
    }

    const str = atob(data.pdfBase64);
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
    return { bytes: out, needsPassword: false, wrongPassword: false };
  }

  /**
   * Clear signature images from PDF
   * @param {ArrayBuffer} pdfArrayBuffer - The PDF as ArrayBuffer
   * @returns {Promise<Uint8Array>} - PDF with signatures cleared
   */
  static async clearSignature(pdfArrayBuffer) {
    try {
      // Convert ArrayBuffer to base64 in chunks
      const pdfBytes = new Uint8Array(pdfArrayBuffer);
      
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < pdfBytes.length; i += chunkSize) {
        const chunk = pdfBytes.subarray(i, Math.min(i + chunkSize, pdfBytes.length));
        binary += String.fromCharCode.apply(null, chunk);
      }
      const pdfBase64 = btoa(binary);

      const response = await fetch(`${BACKEND_URL}/clear-signature`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          pdfBase64: pdfBase64
        })
      });

      if (!response.ok) {
        throw new Error(`Backend error: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Clear signature failed');
      }

      // Convert base64 back to Uint8Array
      const clearedPdfBase64 = data.pdfBase64;
      const clearedPdfString = atob(clearedPdfBase64);
      const clearedPdfBytes = new Uint8Array(clearedPdfString.length);
      for (let i = 0; i < clearedPdfString.length; i++) {
        clearedPdfBytes[i] = clearedPdfString.charCodeAt(i);
      }

      return clearedPdfBytes;
    } catch (error) {
      console.error('Clear signature failed:', error);
      throw error;
    }
  }
}

