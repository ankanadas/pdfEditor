// Main entry point for the PDF Editor application
export { PDFDocumentManager } from './core/PDFDocumentManager.js';
export { TextEditor } from './core/TextEditor.js';
export { SignatureEditor } from './core/SignatureEditor.js';
export { EditorController } from './core/EditorController.js';
export { PDFEditorError, ErrorCodes } from './errors/PDFEditorError.js';

console.log('PDF Editor initialized');
