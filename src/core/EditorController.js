import { PDFDocumentManager } from './PDFDocumentManager.js';
import { TextEditor } from './TextEditor.js';
import { SignatureEditor } from './SignatureEditor.js';
import { PDFEditorError, ErrorCodes } from '../errors/PDFEditorError.js';

/**
 * EditOperation interface represents an operation that can be undone/redone
 * @typedef {Object} EditOperation
 * @property {'addText' | 'removeText' | 'updateText' | 'addSignature' | 'removeSignature'} type - Operation type
 * @property {number} timestamp - When the operation was performed
 * @property {any} data - Operation-specific data
 * @property {EditOperation} inverse - Operation to undo this one
 */

/**
 * EditorController coordinates between UI interactions and editing modules
 * Manages undo/redo state and emits events for state changes
 */
export class EditorController {
  constructor() {
    // Initialize core components
    this.documentManager = new PDFDocumentManager();
    this.textEditor = null;
    this.signatureEditor = null;

    // Edit history for undo/redo
    this.history = [];
    this.currentHistoryIndex = -1;

    // Event listeners
    this.eventListeners = new Map();

    // Selection state
    this.selectedElement = null;
    this.selectedElementType = null; // 'text' or 'signature'

    // Document loaded state
    this.isLoaded = false;
  }

  /**
   * Initialize editors with the loaded PDF document
   * @private
   */
  _initializeEditors() {
    const pdfDoc = this.documentManager.getDocument();
    this.textEditor = new TextEditor(pdfDoc);
    this.signatureEditor = new SignatureEditor(pdfDoc);
  }

  /**
   * Load a PDF from various sources
   * @param {File | ArrayBuffer | string} source - PDF file, buffer, or URL
   * @returns {Promise<void>}
   */
  async loadPDF(source) {
    try {
      // Determine source type and load accordingly
      if (source instanceof File) {
        await this.documentManager.loadFromFile(source);
      } else if (source instanceof ArrayBuffer) {
        await this.documentManager.loadFromArrayBuffer(source);
      } else if (typeof source === 'string') {
        await this.documentManager.loadFromURL(source);
      } else {
        throw new PDFEditorError(
          'Invalid source type. Must be File, ArrayBuffer, or URL string',
          ErrorCodes.INVALID_PDF,
          { source }
        );
      }

      // Initialize editors with the loaded document
      this._initializeEditors();

      // Reset state
      this.history = [];
      this.currentHistoryIndex = -1;
      this.selectedElement = null;
      this.selectedElementType = null;
      this.isLoaded = true;

      // Emit loaded event
      this._emit('loaded', {
        pageCount: this.documentManager.getPageCount()
      });
    } catch (error) {
      this.isLoaded = false;
      this._emit('error', {
        message: error.message,
        code: error.code,
        details: error.details
      });
      throw error;
    }
  }

  /**
   * Get the TextEditor instance
   * @returns {TextEditor}
   */
  getTextEditor() {
    if (!this.textEditor) {
      throw new PDFEditorError(
        'No PDF document loaded',
        ErrorCodes.OPERATION_FAILED
      );
    }
    return this.textEditor;
  }

  /**
   * Get the SignatureEditor instance
   * @returns {SignatureEditor}
   */
  getSignatureEditor() {
    if (!this.signatureEditor) {
      throw new PDFEditorError(
        'No PDF document loaded',
        ErrorCodes.OPERATION_FAILED
      );
    }
    return this.signatureEditor;
  }

  /**
   * Get the PDFDocumentManager instance
   * @returns {PDFDocumentManager}
   */
  getDocumentManager() {
    return this.documentManager;
  }

  /**
   * Check if undo is available
   * @returns {boolean}
   */
  canUndo() {
    return this.currentHistoryIndex >= 0;
  }

  /**
   * Check if redo is available
   * @returns {boolean}
   */
  canRedo() {
    return this.currentHistoryIndex < this.history.length - 1;
  }

  /**
   * Undo the last operation
   * @returns {Promise<void>}
   */
  async undo() {
    if (!this.canUndo()) {
      return;
    }

    const operation = this.history[this.currentHistoryIndex];
    await this._applyOperation(operation.inverse);
    this.currentHistoryIndex--;

    this._emit('historyChanged', {
      canUndo: this.canUndo(),
      canRedo: this.canRedo()
    });
  }

  /**
   * Redo the previously undone operation
   * @returns {Promise<void>}
   */
  async redo() {
    if (!this.canRedo()) {
      return;
    }

    this.currentHistoryIndex++;
    const operation = this.history[this.currentHistoryIndex];
    await this._applyOperation(operation);

    this._emit('historyChanged', {
      canUndo: this.canUndo(),
      canRedo: this.canRedo()
    });
  }

  /**
   * Apply an operation (for undo/redo)
   * @param {EditOperation} operation - The operation to apply
   * @returns {Promise<void>}
   * @private
   */
  async _applyOperation(operation) {
    switch (operation.type) {
      case 'addText':
        await this.textEditor.addText(
          operation.data.pageIndex,
          operation.data.text,
          operation.data.x,
          operation.data.y,
          operation.data.options
        );
        break;

      case 'removeText':
        await this.textEditor.removeText(operation.data.element);
        break;

      case 'updateText':
        await this.textEditor.updateText(
          operation.data.element,
          operation.data.newText,
          operation.data.options
        );
        break;

      case 'addSignature':
        // Handle different signature types
        if (operation.data.signatureType === 'image') {
          await this.signatureEditor.addImageSignature(
            operation.data.pageIndex,
            operation.data.imageData,
            operation.data.x,
            operation.data.y,
            operation.data.options
          );
        } else if (operation.data.signatureType === 'drawn') {
          await this.signatureEditor.addDrawnSignature(
            operation.data.pageIndex,
            operation.data.pathData,
            operation.data.x,
            operation.data.y,
            operation.data.options
          );
        } else if (operation.data.signatureType === 'typed') {
          await this.signatureEditor.addTypedSignature(
            operation.data.pageIndex,
            operation.data.text,
            operation.data.x,
            operation.data.y,
            operation.data.options
          );
        }
        break;

      case 'removeSignature':
        await this.signatureEditor.removeSignature(operation.data.signature);
        break;

      default:
        throw new PDFEditorError(
          `Unknown operation type: ${operation.type}`,
          ErrorCodes.OPERATION_FAILED,
          { operation }
        );
    }
  }

  /**
   * Add an operation to the history
   * @param {EditOperation} operation - The operation to add
   * @private
   */
  _addToHistory(operation) {
    // Remove any operations after the current index (for redo)
    this.history = this.history.slice(0, this.currentHistoryIndex + 1);

    // Add the new operation
    this.history.push(operation);
    this.currentHistoryIndex++;

    this._emit('historyChanged', {
      canUndo: this.canUndo(),
      canRedo: this.canRedo()
    });
  }

  /**
   * Save the PDF document
   * @returns {Promise<Uint8Array>} The PDF data
   */
  async save() {
    if (!this.isLoaded) {
      throw new PDFEditorError(
        'No PDF document loaded',
        ErrorCodes.OPERATION_FAILED
      );
    }

    try {
      const pdfBytes = await this.documentManager.save();
      this._emit('saved', { size: pdfBytes.length });
      return pdfBytes;
    } catch (error) {
      this._emit('error', {
        message: error.message,
        code: error.code,
        details: error.details
      });
      throw error;
    }
  }

  /**
   * Save the PDF document and trigger download
   * @param {string} filename - The filename for the download
   * @returns {Promise<void>}
   */
  async saveAs(filename) {
    if (!this.isLoaded) {
      throw new PDFEditorError(
        'No PDF document loaded',
        ErrorCodes.OPERATION_FAILED
      );
    }

    try {
      await this.documentManager.saveToFile(filename);
      this._emit('saved', { filename });
    } catch (error) {
      this._emit('error', {
        message: error.message,
        code: error.code,
        details: error.details
      });
      throw error;
    }
  }

  /**
   * Select an element (text or signature)
   * @param {TextElement | Signature | null} element - The element to select, or null to deselect
   * @param {'text' | 'signature' | null} type - The type of element
   */
  selectElement(element, type = null) {
    const previousElement = this.selectedElement;
    const previousType = this.selectedElementType;

    this.selectedElement = element;
    this.selectedElementType = type;

    this._emit('selectionChanged', {
      element,
      type,
      previousElement,
      previousType
    });
  }

  /**
   * Get the currently selected element
   * @returns {{element: TextElement | Signature | null, type: 'text' | 'signature' | null}}
   */
  getSelectedElement() {
    return {
      element: this.selectedElement,
      type: this.selectedElementType
    };
  }

  /**
   * Deselect the currently selected element
   */
  deselectElement() {
    this.selectElement(null, null);
  }

  /**
   * Register an event listener
   * @param {string} event - Event name ('loaded', 'saved', 'error', 'historyChanged', 'selectionChanged')
   * @param {Function} handler - Event handler function
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new PDFEditorError(
        'Event handler must be a function',
        ErrorCodes.OPERATION_FAILED,
        { event, handler }
      );
    }

    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }

    this.eventListeners.get(event).push(handler);
  }

  /**
   * Unregister an event listener
   * @param {string} event - Event name
   * @param {Function} handler - Event handler function to remove
   */
  off(event, handler) {
    if (!this.eventListeners.has(event)) {
      return;
    }

    const handlers = this.eventListeners.get(event);
    const index = handlers.indexOf(handler);

    if (index !== -1) {
      handlers.splice(index, 1);
    }

    // Clean up empty arrays
    if (handlers.length === 0) {
      this.eventListeners.delete(event);
    }
  }

  /**
   * Emit an event to all registered listeners
   * @param {string} event - Event name
   * @param {any} data - Event data
   * @private
   */
  _emit(event, data) {
    if (!this.eventListeners.has(event)) {
      return;
    }

    const handlers = this.eventListeners.get(event);
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for '${event}':`, error);
      }
    }
  }
}
