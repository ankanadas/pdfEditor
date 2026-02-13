/**
 * Service to communicate with Python backend for PDF processing
 */

const BACKEND_URL = 'http://localhost:5000';

export class PDFBackendService {
  /**
   * Check if backend is running
   */
  static async checkHealth() {
    try {
      const response = await fetch(`${BACKEND_URL}/health`);
      const data = await response.json();
      return data.status === 'ok';
    } catch (error) {
      console.error('Backend health check failed:', error);
      return false;
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
   * @param {Array} edits - Array of edit operations
   * @returns {Promise<Uint8Array>} - Edited PDF bytes
   */
  static async editPDF(pdfArrayBuffer, edits) {
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
          edits: edits
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

