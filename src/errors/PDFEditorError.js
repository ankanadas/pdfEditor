// Custom error class for PDF Editor operations
export class PDFEditorError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'PDFEditorError';
    this.code = code;
    this.details = details;
  }
}

// Error codes
export const ErrorCodes = {
  INVALID_PDF: 'INVALID_PDF',
  CORRUPTED_FILE: 'CORRUPTED_FILE',
  INVALID_COORDINATES: 'INVALID_COORDINATES',
  INVALID_TEXT: 'INVALID_TEXT',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  SAVE_FAILED: 'SAVE_FAILED',
  OPERATION_FAILED: 'OPERATION_FAILED',
};
