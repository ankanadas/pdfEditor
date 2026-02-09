import { PDFEditorError, ErrorCodes } from '../errors/PDFEditorError.js';

/**
 * TextOptions interface defines formatting options for text elements
 * @typedef {Object} TextOptions
 * @property {string} [font] - Font name (e.g., 'Helvetica', 'Times-Roman')
 * @property {number} [size] - Font size in points
 * @property {RGB} [color] - Color object {r, g, b}
 * @property {number} [opacity] - Opacity value between 0 and 1
 * @property {number} [rotation] - Rotation in degrees
 */

/**
 * TextElement interface represents a text element in the PDF
 * @typedef {Object} TextElement
 * @property {string} id - Unique identifier for the text element
 * @property {number} pageIndex - Zero-based page index
 * @property {string} text - The text content
 * @property {number} x - X coordinate on the page
 * @property {number} y - Y coordinate on the page
 * @property {number} width - Width of the text element
 * @property {number} height - Height of the text element
 * @property {TextOptions} options - Formatting options
 */

/**
 * Handles all text-related operations including addition, removal, and updates
 */
export class TextEditor {
  /**
   * Create a TextEditor instance
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
    // Map to store text elements by ID
    this.textElements = new Map();
    // Counter for generating unique IDs
    this.idCounter = 0;
  }

  /**
   * Generate a unique ID for a text element
   * @returns {string} Unique identifier
   * @private
   */
  _generateId() {
    return `text-${++this.idCounter}-${Date.now()}`;
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
   * Validate text content
   * @param {string} text - The text to validate
   * @returns {boolean} True if valid
   * @private
   */
  _validateText(text) {
    if (text === null || text === undefined || text === '') {
      throw new PDFEditorError(
        'Text content cannot be empty',
        ErrorCodes.INVALID_TEXT
      );
    }
    return true;
  }

   /**
    * Add text at specified coordinates with options
    * @param {number} pageIndex - Zero-based page index
    * @param {string} text - The text content to add
    * @param {number} x - X coordinate on the page
    * @param {number} y - Y coordinate on the page
    * @param {TextOptions} options - Formatting options for the text
    * @returns {Promise<TextElement>} The created text element
    */
   async addText(pageIndex, text, x, y, options = {}) {
     // Validate inputs
     this._validateText(text);
     this._validateCoordinates(pageIndex, x, y);

     // Get the page
     const pages = this.pdfDocument.getPages();
     const page = pages[pageIndex];

     // Set default options
     const defaultOptions = {
       font: 'Helvetica',
       size: 12,
       color: { r: 0, g: 0, b: 0 },
       opacity: 1,
       rotation: 0
     };

     const finalOptions = { ...defaultOptions, ...options };

     // Import StandardFonts and rgb from pdf-lib
     const { StandardFonts, rgb } = await import('pdf-lib');

     // Get the font
     let font;
     try {
       // Map common font names to StandardFonts
       const fontMap = {
         'Helvetica': StandardFonts.Helvetica,
         'Helvetica-Bold': StandardFonts.HelveticaBold,
         'Helvetica-Oblique': StandardFonts.HelveticaOblique,
         'Helvetica-BoldOblique': StandardFonts.HelveticaBoldOblique,
         'Times-Roman': StandardFonts.TimesRoman,
         'Times-Bold': StandardFonts.TimesBold,
         'Times-Italic': StandardFonts.TimesItalic,
         'Times-BoldItalic': StandardFonts.TimesBoldItalic,
         'Courier': StandardFonts.Courier,
         'Courier-Bold': StandardFonts.CourierBold,
         'Courier-Oblique': StandardFonts.CourierOblique,
         'Courier-BoldOblique': StandardFonts.CourierBoldOblique
       };

       const standardFont = fontMap[finalOptions.font] || StandardFonts.Helvetica;
       font = await this.pdfDocument.embedFont(standardFont);
     } catch (error) {
       throw new PDFEditorError(
         `Failed to embed font: ${finalOptions.font}`,
         ErrorCodes.OPERATION_FAILED,
         { font: finalOptions.font, error: error.message }
       );
     }

     // Calculate text dimensions
     const textWidth = font.widthOfTextAtSize(text, finalOptions.size);
     const textHeight = font.heightAtSize(finalOptions.size);

     // Draw text on the page
     try {
       const drawOptions = {
         x,
         y,
         size: finalOptions.size,
         font,
         color: rgb(finalOptions.color.r, finalOptions.color.g, finalOptions.color.b),
         opacity: finalOptions.opacity
       };

       // Only add rotation if it's not 0
       if (finalOptions.rotation !== 0) {
         drawOptions.rotate = { type: 'degrees', angle: finalOptions.rotation };
       }

       page.drawText(text, drawOptions);
     } catch (error) {
       throw new PDFEditorError(
         'Failed to draw text on PDF page',
         ErrorCodes.OPERATION_FAILED,
         { pageIndex, x, y, text, error: error.message }
       );
     }

     // Create text element
     const id = this._generateId();
     const textElement = {
       id,
       pageIndex,
       text,
       x,
       y,
       width: textWidth,
       height: textHeight,
       options: finalOptions
     };

     // Store in internal map
     this.textElements.set(id, textElement);

     return textElement;
   }

    /**
     * Remove text element from the PDF
     * @param {TextElement} element - The text element to remove
     * @returns {Promise<void>}
     */
    async removeText(element) {
      // Validate element
      if (!element || !element.id) {
        throw new PDFEditorError(
          'Invalid text element',
          ErrorCodes.INVALID_TEXT,
          { element }
        );
      }

      // Check if element exists in our map
      if (!this.textElements.has(element.id)) {
        // Element already removed or never existed - idempotent behavior
        return;
      }

      // Remove from internal map
      this.textElements.delete(element.id);

      // Mark element as removed (for undo/redo support)
      element.removed = true;
    }

    /**
     * Update existing text element with new content and/or options
     * @param {TextElement} element - The text element to update
     * @param {string} newText - The new text content
     * @param {TextOptions} [options] - Optional new formatting options (preserves original if not specified)
     * @returns {Promise<void>}
     */
    async updateText(element, newText, options) {
      // Validate element
      if (!element || !element.id) {
        throw new PDFEditorError(
          'Invalid text element',
          ErrorCodes.INVALID_TEXT,
          { element }
        );
      }

      // Check if element exists in our map
      if (!this.textElements.has(element.id)) {
        throw new PDFEditorError(
          'Text element not found',
          ErrorCodes.INVALID_TEXT,
          { elementId: element.id }
        );
      }

      // Validate new text
      this._validateText(newText);

      // Get the stored element
      const storedElement = this.textElements.get(element.id);

      // Preserve original formatting when options not specified
      const finalOptions = options ? { ...storedElement.options, ...options } : storedElement.options;

      // Validate coordinates are still within bounds
      this._validateCoordinates(storedElement.pageIndex, storedElement.x, storedElement.y);

      // Get the page
      const pages = this.pdfDocument.getPages();
      const page = pages[storedElement.pageIndex];

      // Import StandardFonts and rgb from pdf-lib
      const { StandardFonts, rgb } = await import('pdf-lib');

      // Get the font
      let font;
      try {
        // Map common font names to StandardFonts
        const fontMap = {
          'Helvetica': StandardFonts.Helvetica,
          'Helvetica-Bold': StandardFonts.HelveticaBold,
          'Helvetica-Oblique': StandardFonts.HelveticaOblique,
          'Helvetica-BoldOblique': StandardFonts.HelveticaBoldOblique,
          'Times-Roman': StandardFonts.TimesRoman,
          'Times-Bold': StandardFonts.TimesBold,
          'Times-Italic': StandardFonts.TimesItalic,
          'Times-BoldItalic': StandardFonts.TimesBoldItalic,
          'Courier': StandardFonts.Courier,
          'Courier-Bold': StandardFonts.CourierBold,
          'Courier-Oblique': StandardFonts.CourierOblique,
          'Courier-BoldOblique': StandardFonts.CourierBoldOblique
        };

        const standardFont = fontMap[finalOptions.font] || StandardFonts.Helvetica;
        font = await this.pdfDocument.embedFont(standardFont);
      } catch (error) {
        throw new PDFEditorError(
          `Failed to embed font: ${finalOptions.font}`,
          ErrorCodes.OPERATION_FAILED,
          { font: finalOptions.font, error: error.message }
        );
      }

      // Calculate new text dimensions
      const textWidth = font.widthOfTextAtSize(newText, finalOptions.size);
      const textHeight = font.heightAtSize(finalOptions.size);

      // Draw updated text on the page
      try {
        const drawOptions = {
          x: storedElement.x,
          y: storedElement.y,
          size: finalOptions.size,
          font,
          color: rgb(finalOptions.color.r, finalOptions.color.g, finalOptions.color.b),
          opacity: finalOptions.opacity
        };

        // Only add rotation if it's not 0
        if (finalOptions.rotation !== 0) {
          drawOptions.rotate = { type: 'degrees', angle: finalOptions.rotation };
        }

        page.drawText(newText, drawOptions);
      } catch (error) {
        throw new PDFEditorError(
          'Failed to draw updated text on PDF page',
          ErrorCodes.OPERATION_FAILED,
          { pageIndex: storedElement.pageIndex, x: storedElement.x, y: storedElement.y, text: newText, error: error.message }
        );
      }

      // Update the stored element
      storedElement.text = newText;
      storedElement.width = textWidth;
      storedElement.height = textHeight;
      storedElement.options = finalOptions;

      // Update the element reference passed in
      element.text = newText;
      element.width = textWidth;
      element.height = textHeight;
      element.options = finalOptions;
    }

    /**
     * Find text element at specific coordinates
     * @param {number} pageIndex - Zero-based page index
     * @param {number} x - X coordinate on the page
     * @param {number} y - Y coordinate on the page
     * @returns {TextElement | null} The text element at the coordinates, or null if none found
     */
    findTextAt(pageIndex, x, y) {
      // Validate page index
      const pages = this.pdfDocument.getPages();
      if (pageIndex < 0 || pageIndex >= pages.length) {
        return null;
      }

      // Find text element at coordinates
      // Check if coordinates fall within any text element's bounding box
      for (const [id, element] of this.textElements) {
        if (element.pageIndex === pageIndex) {
          // Check if point is within the text element's bounding box
          const withinX = x >= element.x && x <= element.x + element.width;
          const withinY = y >= element.y && y <= element.y + element.height;

          if (withinX && withinY) {
            return element;
          }
        }
      }

      return null;
    }

    /**
     * Get all text elements for a specific page
     * @param {number} pageIndex - Zero-based page index
     * @returns {TextElement[]} Array of text elements on the page
     */
    getTextElements(pageIndex) {
      // Validate page index
      const pages = this.pdfDocument.getPages();
      if (pageIndex < 0 || pageIndex >= pages.length) {
        return [];
      }

      // Filter text elements by page index
      const elements = [];
      for (const [id, element] of this.textElements) {
        if (element.pageIndex === pageIndex) {
          elements.push(element);
        }
      }

      return elements;
    }

}
