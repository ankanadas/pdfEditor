import { PDFDocument } from 'pdf-lib';
import { PDFEditorError, ErrorCodes } from '../errors/PDFEditorError.js';

/**
 * Manages the lifecycle of PDF documents
 * Provides loading and saving functionality
 */
export class PDFDocumentManager {
  constructor() {
    this.pdfDoc = null;
    this.pages = [];
  }

  /**
   * Load a PDF from a File object
   * @param {File} file - The PDF file to load
   */
  async loadFromFile(file) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      await this.loadFromArrayBuffer(arrayBuffer);
    } catch (error) {
      if (error instanceof PDFEditorError) {
        throw error;
      }
      throw new PDFEditorError(
        'Failed to load PDF from file',
        ErrorCodes.INVALID_PDF,
        { originalError: error.message }
      );
    }
  }

  /**
   * Load a PDF from an ArrayBuffer
   * @param {ArrayBuffer} buffer - The PDF data as ArrayBuffer
   */
  async loadFromArrayBuffer(buffer) {
    try {
      // Try loading with lenient parsing options
      this.pdfDoc = await PDFDocument.load(buffer, {
        ignoreEncryption: true,
        updateMetadata: false
      });
      this.pages = this.pdfDoc.getPages();
    } catch (error) {
      // If loading fails, try creating a new PDF and copying pages
      // This can help with some corrupted or non-standard PDFs
      console.warn('Standard PDF loading failed, attempting recovery...', error.message);
      
      try {
        // Try one more time with even more lenient options
        this.pdfDoc = await PDFDocument.load(buffer, {
          ignoreEncryption: true,
          updateMetadata: false,
          capNumbers: false
        });
        this.pages = this.pdfDoc.getPages();
      } catch (secondError) {
        throw new PDFEditorError(
          'Invalid or corrupted PDF file. The PDF may use features not supported by this editor.',
          ErrorCodes.CORRUPTED_FILE,
          { originalError: error.message, secondError: secondError.message }
        );
      }
    }
  }

  /**
   * Load a PDF from a URL
   * @param {string} url - The URL to fetch the PDF from
   */
  async loadFromURL(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      await this.loadFromArrayBuffer(arrayBuffer);
    } catch (error) {
      if (error instanceof PDFEditorError) {
        throw error;
      }
      throw new PDFEditorError(
        'Failed to load PDF from URL',
        ErrorCodes.INVALID_PDF,
        { originalError: error.message, url }
      );
    }
  }

  /**
   * Get the underlying pdf-lib document
   * @returns {PDFDocument} The pdf-lib document instance
   */
  getDocument() {
    if (!this.pdfDoc) {
      throw new PDFEditorError(
        'No PDF document loaded',
        ErrorCodes.OPERATION_FAILED
      );
    }
    return this.pdfDoc;
  }

  /**
   * Get the total number of pages
   * @returns {number} Page count
   */
  getPageCount() {
    if (!this.pdfDoc) {
      throw new PDFEditorError(
        'No PDF document loaded',
        ErrorCodes.OPERATION_FAILED
      );
    }
    return this.pages.length;
  }

  /**
   * Get a specific page by index
   * @param {number} index - Zero-based page index
   * @returns {PDFPage} The requested page
   */
  getPage(index) {
    if (!this.pdfDoc) {
      throw new PDFEditorError(
        'No PDF document loaded',
        ErrorCodes.OPERATION_FAILED
      );
    }
    if (index < 0 || index >= this.pages.length) {
      throw new PDFEditorError(
        `Invalid page index: ${index}`,
        ErrorCodes.INVALID_COORDINATES,
        { index, pageCount: this.pages.length }
      );
    }
    return this.pages[index];
  }

  /**
   * Save the PDF document to a Uint8Array
   * @returns {Promise<Uint8Array>} The PDF data
   */
  async save() {
    if (!this.pdfDoc) {
      throw new PDFEditorError(
        'No PDF document loaded',
        ErrorCodes.OPERATION_FAILED
      );
    }
    try {
      return await this.pdfDoc.save();
    } catch (error) {
      throw new PDFEditorError(
        'Failed to save PDF document',
        ErrorCodes.SAVE_FAILED,
        { originalError: error.message }
      );
    }
  }

  /**
   * Save the PDF document and trigger download
   * @param {string} filename - The filename for the download
   */
  async saveToFile(filename) {
    try {
      const pdfBytes = await this.save();
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      
      URL.revokeObjectURL(url);
    } catch (error) {
      if (error instanceof PDFEditorError) {
        throw error;
      }
      throw new PDFEditorError(
        'Failed to save PDF to file',
        ErrorCodes.SAVE_FAILED,
        { originalError: error.message, filename }
      );
    }
  }
}
