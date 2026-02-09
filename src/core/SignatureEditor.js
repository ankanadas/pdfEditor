import { PDFEditorError, ErrorCodes } from '../errors/PDFEditorError.js';

/**
 * SignatureOptions interface defines formatting options for signature elements
 * @typedef {Object} SignatureOptions
 * @property {number} [width] - Width of the signature
 * @property {number} [height] - Height of the signature
 * @property {number} [opacity] - Opacity value between 0 and 1
 * @property {number} [rotation] - Rotation in degrees
 */

/**
 * Signature interface represents a signature element in the PDF
 * @typedef {Object} Signature
 * @property {string} id - Unique identifier for the signature
 * @property {number} pageIndex - Zero-based page index
 * @property {'image' | 'drawn' | 'typed'} type - Type of signature
 * @property {number} x - X coordinate on the page
 * @property {number} y - Y coordinate on the page
 * @property {number} width - Width of the signature element
 * @property {number} height - Height of the signature element
 * @property {SignatureOptions} options - Formatting options
 * @property {any} data - Type-specific data
 */

/**
 * Manages signature operations including addition and removal
 */
export class SignatureEditor {
  /**
   * Create a SignatureEditor instance
   * @param {PDFDocument} pdfDocument - The pdf-lib document instance
   */
  constructor(pdfDocument) {
    if (!pdfDocument) {
      throw new PDFEditorError(
        'PDF document is required',
        ErrorCodes.OPERATION_FAILED
      );
    }
    this.pdfDocument = pdfDocument;
    // Map to store signatures by ID
    this.signatures = new Map();
    // Counter for generating unique IDs
    this.idCounter = 0;
  }

  /**
   * Generate a unique ID for a signature element
   * @returns {string} Unique identifier
   * @private
   */
  _generateId() {
    return `signature-${++this.idCounter}-${Date.now()}`;
  }

  /**
   * Validate that coordinates are within page bounds
   * @param {number} pageIndex - The page index
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @returns {boolean} True if valid
   * @private
   */
  _validateCoordinates(pageIndex, x, y) {
    const pages = this.pdfDocument.getPages();
    if (pageIndex < 0 || pageIndex >= pages.length) {
      throw new PDFEditorError(
        `Invalid page index: ${pageIndex}`,
        ErrorCodes.INVALID_COORDINATES,
        { pageIndex, pageCount: pages.length }
      );
    }

    const page = pages[pageIndex];
    const { width, height } = page.getSize();

    if (x < 0 || x > width || y < 0 || y > height) {
      throw new PDFEditorError(
        'Coordinates are out of page bounds',
        ErrorCodes.INVALID_COORDINATES,
        { x, y, pageWidth: width, pageHeight: height }
      );
    }

    return true;
  }

  /**
   * Add an image signature to the PDF
   * @param {number} pageIndex - Zero-based page index
   * @param {Uint8Array} imageData - Image data (PNG or JPG)
   * @param {number} x - X coordinate on the page
   * @param {number} y - Y coordinate on the page
   * @param {SignatureOptions} [options={}] - Signature formatting options
   * @returns {Promise<Signature>} The created signature element
   */
  async addImageSignature(pageIndex, imageData, x, y, options = {}) {
    // Validate inputs
    if (!imageData || !(imageData instanceof Uint8Array)) {
      throw new PDFEditorError(
        'Image data must be a Uint8Array',
        ErrorCodes.INVALID_SIGNATURE,
        { imageData }
      );
    }

    if (imageData.length === 0) {
      throw new PDFEditorError(
        'Image data cannot be empty',
        ErrorCodes.INVALID_SIGNATURE
      );
    }

    // Validate coordinates
    this._validateCoordinates(pageIndex, x, y);

    // Determine image type and embed
    let embeddedImage;
    try {
      // Try PNG first (PNG signature: 89 50 4E 47)
      if (imageData[0] === 0x89 && imageData[1] === 0x50 && imageData[2] === 0x4E && imageData[3] === 0x47) {
        embeddedImage = await this.pdfDocument.embedPng(imageData);
      }
      // Try JPG (JPEG signature: FF D8 FF)
      else if (imageData[0] === 0xFF && imageData[1] === 0xD8 && imageData[2] === 0xFF) {
        embeddedImage = await this.pdfDocument.embedJpg(imageData);
      }
      else {
        throw new PDFEditorError(
          'Image format not supported. Only PNG and JPG are supported.',
          ErrorCodes.INVALID_SIGNATURE,
          { firstBytes: Array.from(imageData.slice(0, 4)) }
        );
      }
    } catch (error) {
      if (error instanceof PDFEditorError) {
        throw error;
      }
      throw new PDFEditorError(
        'Failed to embed image in PDF',
        ErrorCodes.INVALID_SIGNATURE,
        { originalError: error.message }
      );
    }

    // Get image dimensions
    const imageDims = embeddedImage.scale(1);

    // Apply options with defaults
    const width = options.width || imageDims.width;
    const height = options.height || imageDims.height;
    const opacity = options.opacity !== undefined ? options.opacity : 1;
    const rotation = options.rotation || 0;

    // Validate opacity
    if (opacity < 0 || opacity > 1) {
      throw new PDFEditorError(
        'Opacity must be between 0 and 1',
        ErrorCodes.INVALID_SIGNATURE,
        { opacity }
      );
    }

    // Get the page and draw the image
    const page = this.pdfDocument.getPages()[pageIndex];
    const drawOptions = {
      x,
      y,
      width,
      height,
      opacity
    };
    
    // Only add rotation if non-zero (pdf-lib expects degrees property)
    if (rotation !== 0) {
      drawOptions.rotate = { type: 'degrees', angle: rotation };
    }
    
    page.drawImage(embeddedImage, drawOptions);

    // Create signature object
    const signature = {
      id: this._generateId(),
      pageIndex,
      type: 'image',
      x,
      y,
      width,
      height,
      options: { width, height, opacity, rotation },
      data: { imageData, embeddedImage }
    };

    // Store in internal map
    this.signatures.set(signature.id, signature);

    return signature;
  }

  /**
   * Add a drawn signature to the PDF
   * @param {number} pageIndex - Zero-based page index
   * @param {Path2D|Object} pathData - Path2D object or path commands
   * @param {number} x - X coordinate on the page
   * @param {number} y - Y coordinate on the page
   * @param {SignatureOptions} [options={}] - Signature formatting options
   * @returns {Promise<Signature>} The created signature element
   */
  async addDrawnSignature(pageIndex, pathData, x, y, options = {}) {
    // Validate inputs
    if (!pathData) {
      throw new PDFEditorError(
        'Path data is required',
        ErrorCodes.INVALID_SIGNATURE,
        { pathData }
      );
    }

    // Validate coordinates
    this._validateCoordinates(pageIndex, x, y);

    // Extract path commands from Path2D or object
    let pathCommands;
    
    // Check if it's a Path2D object (only available in browser)
    const isPath2D = typeof Path2D !== 'undefined' && pathData instanceof Path2D;
    
    if (isPath2D) {
      // For Path2D objects, we need to extract the commands
      // Since Path2D doesn't expose its internal commands directly,
      // we expect the pathData to have a custom property with commands
      if (pathData.commands) {
        pathCommands = pathData.commands;
      } else {
        throw new PDFEditorError(
          'Path2D object must have a commands property',
          ErrorCodes.INVALID_SIGNATURE,
          { pathData }
        );
      }
    } else if (typeof pathData === 'object' && pathData.commands) {
      pathCommands = pathData.commands;
    } else {
      throw new PDFEditorError(
        'Path data must be a Path2D object with commands property or an object with commands array',
        ErrorCodes.INVALID_SIGNATURE,
        { pathData }
      );
    }

    if (!Array.isArray(pathCommands) || pathCommands.length === 0) {
      throw new PDFEditorError(
        'Path commands must be a non-empty array',
        ErrorCodes.INVALID_SIGNATURE,
        { pathCommands }
      );
    }

    // Calculate bounding box from path commands
    const bounds = this._calculatePathBounds(pathCommands);
    
    // Apply options with defaults
    const width = options.width || bounds.width || 100;
    const height = options.height || bounds.height || 50;
    const opacity = options.opacity !== undefined ? options.opacity : 1;
    const rotation = options.rotation || 0;
    const strokeColor = options.strokeColor || { r: 0, g: 0, b: 0 }; // Default black
    const strokeWidth = options.strokeWidth || 2;

    // Validate opacity
    if (opacity < 0 || opacity > 1) {
      throw new PDFEditorError(
        'Opacity must be between 0 and 1',
        ErrorCodes.INVALID_SIGNATURE,
        { opacity }
      );
    }

    // Get the page
    const page = this.pdfDocument.getPages()[pageIndex];

    // Draw the path on the PDF using pdf-lib's drawing methods
    // We'll convert the path to a series of line segments
    const { rgb } = await import('pdf-lib');
    const color = rgb(strokeColor.r, strokeColor.g, strokeColor.b);

    // Draw each path segment
    for (let i = 0; i < pathCommands.length; i++) {
      const cmd = pathCommands[i];
      const prevCmd = i > 0 ? pathCommands[i - 1] : null;

      if (cmd.type === 'lineTo' && prevCmd) {
        // Draw a line from previous point to current point
        const startX = x + (prevCmd.x || 0) - bounds.x;
        const startY = y + (prevCmd.y || 0) - bounds.y;
        const endX = x + cmd.x - bounds.x;
        const endY = y + cmd.y - bounds.y;

        page.drawLine({
          start: { x: startX, y: startY },
          end: { x: endX, y: endY },
          thickness: strokeWidth,
          color: color,
          opacity: opacity
        });
      } else if (cmd.type === 'bezierCurveTo' || cmd.type === 'quadraticCurveTo') {
        // For curves, approximate with line segments
        // This is a simplified approach - a more sophisticated implementation
        // would use actual bezier curve rendering
        const startX = x + (prevCmd?.x || 0) - bounds.x;
        const startY = y + (prevCmd?.y || 0) - bounds.y;
        const endX = x + cmd.x - bounds.x;
        const endY = y + cmd.y - bounds.y;

        // Draw approximation as a straight line for now
        page.drawLine({
          start: { x: startX, y: startY },
          end: { x: endX, y: endY },
          thickness: strokeWidth,
          color: color,
          opacity: opacity
        });
      }
    }

    // Create signature object
    const signature = {
      id: this._generateId(),
      pageIndex,
      type: 'drawn',
      x,
      y,
      width,
      height,
      options: { width, height, opacity, rotation, strokeColor, strokeWidth },
      data: { pathData: pathCommands, bounds }
    };

    // Store in internal map
    this.signatures.set(signature.id, signature);

    return signature;
  }

  /**
   * Calculate bounding box from path commands
   * @param {Array} commands - Array of path commands
   * @returns {Object} Bounding box with x, y, width, height
   * @private
   */
  _calculatePathBounds(commands) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const cmd of commands) {
      if (cmd.type === 'moveTo' || cmd.type === 'lineTo') {
        minX = Math.min(minX, cmd.x);
        minY = Math.min(minY, cmd.y);
        maxX = Math.max(maxX, cmd.x);
        maxY = Math.max(maxY, cmd.y);
      } else if (cmd.type === 'bezierCurveTo') {
        minX = Math.min(minX, cmd.cp1x, cmd.cp2x, cmd.x);
        minY = Math.min(minY, cmd.cp1y, cmd.cp2y, cmd.y);
        maxX = Math.max(maxX, cmd.cp1x, cmd.cp2x, cmd.x);
        maxY = Math.max(maxY, cmd.cp1y, cmd.cp2y, cmd.y);
      } else if (cmd.type === 'quadraticCurveTo') {
        minX = Math.min(minX, cmd.cpx, cmd.x);
        minY = Math.min(minY, cmd.cpy, cmd.y);
        maxX = Math.max(maxX, cmd.cpx, cmd.x);
        maxY = Math.max(maxY, cmd.cpy, cmd.y);
      }
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

    /**
     * Add a typed signature to the PDF
     * @param {number} pageIndex - Zero-based page index
     * @param {string} text - Text to render as signature
     * @param {number} x - X coordinate on the page
     * @param {number} y - Y coordinate on the page
     * @param {SignatureOptions} [options={}] - Signature formatting options
     * @returns {Promise<Signature>} The created signature element
     */
    async addTypedSignature(pageIndex, text, x, y, options = {}) {
      // Validate inputs
      if (!text || typeof text !== 'string') {
        throw new PDFEditorError(
          'Text must be a non-empty string',
          ErrorCodes.INVALID_SIGNATURE,
          { text }
        );
      }

      if (text.trim().length === 0) {
        throw new PDFEditorError(
          'Text cannot be empty or whitespace only',
          ErrorCodes.INVALID_SIGNATURE,
          { text }
        );
      }

      // Validate coordinates
      this._validateCoordinates(pageIndex, x, y);

      // Import necessary pdf-lib functions
      const { rgb, StandardFonts } = await import('pdf-lib');

      // Try to use a cursive/script font if available, otherwise use italic
      // pdf-lib standard fonts don't include cursive, so we'll use TimesRomanItalic
      // as the closest approximation for signature-style formatting
      let font;
      try {
        font = await this.pdfDocument.embedFont(StandardFonts.TimesRomanItalic);
      } catch (error) {
        // Fallback to Helvetica if Times Roman Italic fails
        font = await this.pdfDocument.embedFont(StandardFonts.Helvetica);
      }

      // Apply options with defaults
      const fontSize = options.fontSize || 24; // Larger default for signatures
      const color = options.color || { r: 0, g: 0, b: 0 }; // Default black
      const opacity = options.opacity !== undefined ? options.opacity : 1;
      const rotation = options.rotation || 0;

      // Validate opacity
      if (opacity < 0 || opacity > 1) {
        throw new PDFEditorError(
          'Opacity must be between 0 and 1',
          ErrorCodes.INVALID_SIGNATURE,
          { opacity }
        );
      }

      // Calculate text dimensions
      // Note: Some Unicode characters may not be supported by standard fonts
      let textWidth, textHeight;
      try {
        textWidth = font.widthOfTextAtSize(text, fontSize);
        textHeight = font.heightAtSize(fontSize);
      } catch (error) {
        // If font doesn't support the characters, use estimated dimensions
        // Approximate: average character width is ~60% of font size
        textWidth = text.length * fontSize * 0.6;
        textHeight = fontSize;
      }

      // Use custom width/height if provided, otherwise use calculated dimensions
      const width = options.width || textWidth;
      const height = options.height || textHeight;

      // Get the page and draw the text
      const page = this.pdfDocument.getPages()[pageIndex];
      const textColor = rgb(color.r, color.g, color.b);

      const drawOptions = {
        x,
        y,
        size: fontSize,
        font,
        color: textColor,
        opacity
      };

      // Only add rotation if non-zero
      if (rotation !== 0) {
        drawOptions.rotate = { type: 'degrees', angle: rotation };
      }

      // Try to draw the text - some Unicode characters may not be supported
      try {
        page.drawText(text, drawOptions);
      } catch (error) {
        // If the font doesn't support the characters, throw a more helpful error
        throw new PDFEditorError(
          'Text contains characters not supported by standard PDF fonts',
          ErrorCodes.INVALID_SIGNATURE,
          { text, originalError: error.message }
        );
      }

      // Create signature object
      const signature = {
        id: this._generateId(),
        pageIndex,
        type: 'typed',
        x,
        y,
        width,
        height,
        options: { width, height, opacity, rotation, fontSize, color },
        data: { text, font: 'TimesRomanItalic' }
      };

      // Store in internal map
      this.signatures.set(signature.id, signature);

      return signature;
    }
    /**
     * Remove a signature from the PDF
     * @param {Signature} signature - The signature element to remove
     * @returns {Promise<void>}
     */
    async removeSignature(signature) {
      // Validate input
      if (!signature || typeof signature !== 'object') {
        throw new PDFEditorError(
          'Signature must be a valid signature object',
          ErrorCodes.INVALID_SIGNATURE,
          { signature }
        );
      }

      if (!signature.id) {
        throw new PDFEditorError(
          'Signature must have an id property',
          ErrorCodes.INVALID_SIGNATURE,
          { signature }
        );
      }

      // Check if signature exists in the map
      const existingSignature = this.signatures.get(signature.id);

      if (!existingSignature) {
        // Signature doesn't exist - this is idempotent, so just return
        // This satisfies Property 4: Element Removal is Idempotent
        return;
      }

      // Mark signature as removed (for undo/redo support)
      existingSignature.removed = true;
      existingSignature.removedAt = Date.now();

      // Remove from internal map
      this.signatures.delete(signature.id);

      // Note: pdf-lib doesn't support removing content from pages directly
      // The signature will remain in the PDF document until it's regenerated
      // For a complete implementation, the document would need to be rebuilt
      // without the removed signatures when saving
    }
    /**
     * Find a signature at specific coordinates
     * @param {number} pageIndex - Zero-based page index
     * @param {number} x - X coordinate on the page
     * @param {number} y - Y coordinate on the page
     * @returns {Signature|null} The signature at the coordinates, or null if none found
     */
    findSignatureAt(pageIndex, x, y) {
      // Validate page index
      const pages = this.pdfDocument.getPages();
      if (pageIndex < 0 || pageIndex >= pages.length) {
        throw new PDFEditorError(
          `Invalid page index: ${pageIndex}`,
          ErrorCodes.INVALID_COORDINATES,
          { pageIndex, pageCount: pages.length }
        );
      }

      // Find all signatures on the specified page
      const pageSignatures = Array.from(this.signatures.values())
        .filter(sig => sig.pageIndex === pageIndex && !sig.removed);

      // Check each signature to see if the coordinates fall within its bounds
      // Iterate in reverse order to find the topmost signature (last drawn)
      for (let i = pageSignatures.length - 1; i >= 0; i--) {
        const sig = pageSignatures[i];

        // Check if point (x, y) is within the signature's bounding box
        if (x >= sig.x && x <= sig.x + sig.width &&
            y >= sig.y && y <= sig.y + sig.height) {
          return sig;
        }
      }

      // No signature found at the coordinates
      return null;
    }

    /**
     * Get all signatures on a page
     * @param {number} pageIndex - Zero-based page index
     * @returns {Signature[]} Array of signatures on the page
     */
    getSignatures(pageIndex) {
      // Validate page index
      const pages = this.pdfDocument.getPages();
      if (pageIndex < 0 || pageIndex >= pages.length) {
        throw new PDFEditorError(
          `Invalid page index: ${pageIndex}`,
          ErrorCodes.INVALID_COORDINATES,
          { pageIndex, pageCount: pages.length }
        );
      }

      // Return all non-removed signatures on the specified page
      return Array.from(this.signatures.values())
        .filter(sig => sig.pageIndex === pageIndex && !sig.removed);
    }
}
