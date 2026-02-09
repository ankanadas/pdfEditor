import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { TextEditor } from '../src/core/TextEditor.js';
import { PDFEditorError, ErrorCodes } from '../src/errors/PDFEditorError.js';

// Helper function to create a simple test PDF
async function createTestPDF() {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([595, 842]); // A4 size
  return pdfDoc;
}

describe('TextEditor', () => {
  let pdfDoc;
  let textEditor;

  beforeEach(async () => {
    pdfDoc = await createTestPDF();
    textEditor = new TextEditor(pdfDoc);
  });

  describe('constructor', () => {
    test('should create TextEditor with valid PDF document', () => {
      expect(textEditor).toBeDefined();
      expect(textEditor.pdfDocument).toBe(pdfDoc);
      expect(textEditor.textElements).toBeInstanceOf(Map);
      expect(textEditor.textElements.size).toBe(0);
    });

    test('should throw error when PDF document is not provided', () => {
      expect(() => new TextEditor(null)).toThrow(PDFEditorError);
      expect(() => new TextEditor(null)).toThrow('PDF document is required');
    });
  });

  describe('addText', () => {
    test('should add text at specified coordinates with default options', async () => {
      const textElement = await textEditor.addText(0, 'Hello World', 100, 700);

      expect(textElement).toBeDefined();
      expect(textElement.id).toBeDefined();
      expect(textElement.pageIndex).toBe(0);
      expect(textElement.text).toBe('Hello World');
      expect(textElement.x).toBe(100);
      expect(textElement.y).toBe(700);
      expect(textElement.width).toBeGreaterThan(0);
      expect(textElement.height).toBeGreaterThan(0);
      expect(textElement.options.font).toBe('Helvetica');
      expect(textElement.options.size).toBe(12);
      expect(textElement.options.color).toEqual({ r: 0, g: 0, b: 0 });
      expect(textElement.options.opacity).toBe(1);
      expect(textElement.options.rotation).toBe(0);
    });

    test('should add text with custom options', async () => {
      const options = {
        font: 'Times-Roman',
        size: 16,
        color: { r: 1, g: 0, b: 0 },
        opacity: 0.8,
        rotation: 45
      };

      const textElement = await textEditor.addText(0, 'Custom Text', 200, 600, options);

      expect(textElement.options.font).toBe('Times-Roman');
      expect(textElement.options.size).toBe(16);
      expect(textElement.options.color).toEqual({ r: 1, g: 0, b: 0 });
      expect(textElement.options.opacity).toBe(0.8);
      expect(textElement.options.rotation).toBe(45);
    });

    test('should store text element in internal map', async () => {
      const textElement = await textEditor.addText(0, 'Test', 50, 50);

      expect(textEditor.textElements.has(textElement.id)).toBe(true);
      expect(textEditor.textElements.get(textElement.id)).toBe(textElement);
    });

    test('should generate unique IDs for multiple text elements', async () => {
      const element1 = await textEditor.addText(0, 'Text 1', 100, 700);
      const element2 = await textEditor.addText(0, 'Text 2', 200, 600);
      const element3 = await textEditor.addText(0, 'Text 3', 300, 500);

      expect(element1.id).not.toBe(element2.id);
      expect(element2.id).not.toBe(element3.id);
      expect(element1.id).not.toBe(element3.id);
      expect(textEditor.textElements.size).toBe(3);
    });

    test('should throw error for empty text', async () => {
      await expect(textEditor.addText(0, '', 100, 700))
        .rejects.toThrow(PDFEditorError);
      await expect(textEditor.addText(0, '', 100, 700))
        .rejects.toMatchObject({ code: ErrorCodes.INVALID_TEXT });
    });

    test('should throw error for null text', async () => {
      await expect(textEditor.addText(0, null, 100, 700))
        .rejects.toThrow(PDFEditorError);
    });

    test('should throw error for invalid page index (negative)', async () => {
      await expect(textEditor.addText(-1, 'Test', 100, 700))
        .rejects.toThrow(PDFEditorError);
      await expect(textEditor.addText(-1, 'Test', 100, 700))
        .rejects.toMatchObject({ code: ErrorCodes.INVALID_COORDINATES });
    });

    test('should throw error for invalid page index (out of bounds)', async () => {
      await expect(textEditor.addText(5, 'Test', 100, 700))
        .rejects.toThrow(PDFEditorError);
    });

    test('should throw error for coordinates out of page bounds (x too large)', async () => {
      await expect(textEditor.addText(0, 'Test', 1000, 700))
        .rejects.toThrow(PDFEditorError);
      await expect(textEditor.addText(0, 'Test', 1000, 700))
        .rejects.toMatchObject({ code: ErrorCodes.INVALID_COORDINATES });
    });

    test('should throw error for coordinates out of page bounds (y too large)', async () => {
      await expect(textEditor.addText(0, 'Test', 100, 1000))
        .rejects.toThrow(PDFEditorError);
    });

    test('should throw error for negative coordinates', async () => {
      await expect(textEditor.addText(0, 'Test', -10, 700))
        .rejects.toThrow(PDFEditorError);
      await expect(textEditor.addText(0, 'Test', 100, -10))
        .rejects.toThrow(PDFEditorError);
    });

    test('should handle text at page boundaries', async () => {
      const textElement = await textEditor.addText(0, 'Edge', 0, 0);
      expect(textElement).toBeDefined();
      expect(textElement.x).toBe(0);
      expect(textElement.y).toBe(0);
    });

    test('should handle special characters', async () => {
      const specialText = 'Hello! @#$%^&*()';
      const textElement = await textEditor.addText(0, specialText, 100, 700);
      expect(textElement.text).toBe(specialText);
    });

    test('should handle multi-line text by treating it as single line', async () => {
      // Note: pdf-lib standard fonts don't support newline characters
      // Multi-line text needs to be handled by calling addText multiple times
      const multiLineText = 'Line 1\nLine 2\nLine 3';
      
      // This should throw an error because standard fonts can't encode newlines
      await expect(textEditor.addText(0, multiLineText, 100, 700))
        .rejects.toThrow();
    });

    test('should handle different font types', async () => {
      const fonts = ['Helvetica', 'Times-Roman', 'Courier', 'Helvetica-Bold'];
      
      for (const font of fonts) {
        const textElement = await textEditor.addText(0, 'Test', 100, 700 - fonts.indexOf(font) * 50, { font });
        expect(textElement.options.font).toBe(font);
      }
    });

    test('should calculate text dimensions correctly', async () => {
      const textElement = await textEditor.addText(0, 'Test', 100, 700, { size: 20 });
      
      expect(textElement.width).toBeGreaterThan(0);
      expect(textElement.height).toBeGreaterThan(0);
      // Larger text should have larger dimensions
      expect(textElement.height).toBeGreaterThan(10);
    });
  });

  describe('removeText', () => {
    test('should remove text element from internal map', async () => {
      const textElement = await textEditor.addText(0, 'Remove Me', 100, 700);
      expect(textEditor.textElements.has(textElement.id)).toBe(true);

      await textEditor.removeText(textElement);

      expect(textEditor.textElements.has(textElement.id)).toBe(false);
    });

    test('should mark element as removed', async () => {
      const textElement = await textEditor.addText(0, 'Test', 100, 700);
      
      await textEditor.removeText(textElement);

      expect(textElement.removed).toBe(true);
    });

    test('should be idempotent - removing same element multiple times should not error', async () => {
      const textElement = await textEditor.addText(0, 'Test', 100, 700);
      
      await textEditor.removeText(textElement);
      await textEditor.removeText(textElement); // Second removal
      await textEditor.removeText(textElement); // Third removal

      expect(textEditor.textElements.has(textElement.id)).toBe(false);
    });

    test('should throw error for null element', async () => {
      await expect(textEditor.removeText(null))
        .rejects.toThrow(PDFEditorError);
      await expect(textEditor.removeText(null))
        .rejects.toMatchObject({ code: ErrorCodes.INVALID_TEXT });
    });

    test('should throw error for element without id', async () => {
      const invalidElement = { text: 'Test', x: 100, y: 700 };
      
      await expect(textEditor.removeText(invalidElement))
        .rejects.toThrow(PDFEditorError);
    });

    test('should not affect other text elements when removing one', async () => {
      const element1 = await textEditor.addText(0, 'Text 1', 100, 700);
      const element2 = await textEditor.addText(0, 'Text 2', 200, 600);
      const element3 = await textEditor.addText(0, 'Text 3', 300, 500);

      await textEditor.removeText(element2);

      expect(textEditor.textElements.has(element1.id)).toBe(true);
      expect(textEditor.textElements.has(element2.id)).toBe(false);
      expect(textEditor.textElements.has(element3.id)).toBe(true);
      expect(textEditor.textElements.size).toBe(2);
    });

    test('should handle removing non-existent element gracefully', async () => {
      const fakeElement = {
        id: 'non-existent-id',
        pageIndex: 0,
        text: 'Fake',
        x: 100,
        y: 700
      };

      // Should not throw error
      await textEditor.removeText(fakeElement);
      
      expect(textEditor.textElements.has(fakeElement.id)).toBe(false);
    });

    test('should allow removing all text elements', async () => {
      const element1 = await textEditor.addText(0, 'Text 1', 100, 700);
      const element2 = await textEditor.addText(0, 'Text 2', 200, 600);
      const element3 = await textEditor.addText(0, 'Text 3', 300, 500);

      await textEditor.removeText(element1);
      await textEditor.removeText(element2);
      await textEditor.removeText(element3);

      expect(textEditor.textElements.size).toBe(0);
    });
  });

  describe('updateText', () => {
    test('should update text content while preserving original formatting', async () => {
      const textElement = await textEditor.addText(0, 'Original Text', 100, 700, {
        font: 'Times-Roman',
        size: 16,
        color: { r: 1, g: 0, b: 0 }
      });

      await textEditor.updateText(textElement, 'Updated Text');

      expect(textElement.text).toBe('Updated Text');
      expect(textElement.options.font).toBe('Times-Roman');
      expect(textElement.options.size).toBe(16);
      expect(textElement.options.color).toEqual({ r: 1, g: 0, b: 0 });
    });

    test('should update text content and options', async () => {
      const textElement = await textEditor.addText(0, 'Original', 100, 700);

      await textEditor.updateText(textElement, 'Updated', {
        font: 'Courier',
        size: 20,
        color: { r: 0, g: 1, b: 0 }
      });

      expect(textElement.text).toBe('Updated');
      expect(textElement.options.font).toBe('Courier');
      expect(textElement.options.size).toBe(20);
      expect(textElement.options.color).toEqual({ r: 0, g: 1, b: 0 });
    });

    test('should update only specified options', async () => {
      const textElement = await textEditor.addText(0, 'Test', 100, 700, {
        font: 'Helvetica',
        size: 12,
        color: { r: 0, g: 0, b: 0 },
        opacity: 0.8
      });

      await textEditor.updateText(textElement, 'Updated', { size: 18 });

      expect(textElement.text).toBe('Updated');
      expect(textElement.options.font).toBe('Helvetica');
      expect(textElement.options.size).toBe(18);
      expect(textElement.options.opacity).toBe(0.8);
    });

    test('should update text dimensions when content changes', async () => {
      const textElement = await textEditor.addText(0, 'Short', 100, 700);
      const originalWidth = textElement.width;

      await textEditor.updateText(textElement, 'Much Longer Text String');

      expect(textElement.width).toBeGreaterThan(originalWidth);
      expect(textElement.height).toBeGreaterThan(0);
    });

    test('should update stored element in internal map', async () => {
      const textElement = await textEditor.addText(0, 'Original', 100, 700);
      const elementId = textElement.id;

      await textEditor.updateText(textElement, 'Updated');

      const storedElement = textEditor.textElements.get(elementId);
      expect(storedElement.text).toBe('Updated');
    });

    test('should throw error for null element', async () => {
      await expect(textEditor.updateText(null, 'New Text'))
        .rejects.toThrow(PDFEditorError);
      await expect(textEditor.updateText(null, 'New Text'))
        .rejects.toMatchObject({ code: ErrorCodes.INVALID_TEXT });
    });

    test('should throw error for element without id', async () => {
      const invalidElement = { text: 'Test', x: 100, y: 700 };
      
      await expect(textEditor.updateText(invalidElement, 'New Text'))
        .rejects.toThrow(PDFEditorError);
    });

    test('should throw error for non-existent element', async () => {
      const fakeElement = {
        id: 'non-existent-id',
        pageIndex: 0,
        text: 'Fake',
        x: 100,
        y: 700
      };

      await expect(textEditor.updateText(fakeElement, 'New Text'))
        .rejects.toThrow(PDFEditorError);
      await expect(textEditor.updateText(fakeElement, 'New Text'))
        .rejects.toMatchObject({ code: ErrorCodes.INVALID_TEXT });
    });

    test('should throw error for empty new text', async () => {
      const textElement = await textEditor.addText(0, 'Original', 100, 700);

      await expect(textEditor.updateText(textElement, ''))
        .rejects.toThrow(PDFEditorError);
      await expect(textEditor.updateText(textElement, ''))
        .rejects.toMatchObject({ code: ErrorCodes.INVALID_TEXT });
    });

    test('should throw error for null new text', async () => {
      const textElement = await textEditor.addText(0, 'Original', 100, 700);

      await expect(textEditor.updateText(textElement, null))
        .rejects.toThrow(PDFEditorError);
    });

    test('should handle updating with same text', async () => {
      const textElement = await textEditor.addText(0, 'Same Text', 100, 700);

      await textEditor.updateText(textElement, 'Same Text');

      expect(textElement.text).toBe('Same Text');
    });

    test('should handle updating multiple times', async () => {
      const textElement = await textEditor.addText(0, 'Version 1', 100, 700);

      await textEditor.updateText(textElement, 'Version 2');
      expect(textElement.text).toBe('Version 2');

      await textEditor.updateText(textElement, 'Version 3');
      expect(textElement.text).toBe('Version 3');

      await textEditor.updateText(textElement, 'Final Version');
      expect(textElement.text).toBe('Final Version');
    });

    test('should handle special characters in updated text', async () => {
      const textElement = await textEditor.addText(0, 'Original', 100, 700);
      const specialText = 'Updated! @#$%^&*()';

      await textEditor.updateText(textElement, specialText);

      expect(textElement.text).toBe(specialText);
    });

    test('should preserve unspecified options when updating', async () => {
      const textElement = await textEditor.addText(0, 'Test', 100, 700, {
        font: 'Times-Roman',
        size: 14,
        color: { r: 0.5, g: 0.5, b: 0.5 },
        opacity: 0.9,
        rotation: 30
      });

      await textEditor.updateText(textElement, 'Updated', { size: 18 });

      expect(textElement.options.font).toBe('Times-Roman');
      expect(textElement.options.size).toBe(18);
      expect(textElement.options.color).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
      expect(textElement.options.opacity).toBe(0.9);
      expect(textElement.options.rotation).toBe(30);
    });

    test('should not affect other text elements when updating one', async () => {
      const element1 = await textEditor.addText(0, 'Text 1', 100, 700);
      const element2 = await textEditor.addText(0, 'Text 2', 200, 600);
      const element3 = await textEditor.addText(0, 'Text 3', 300, 500);

      await textEditor.updateText(element2, 'Updated Text 2');

      expect(element1.text).toBe('Text 1');
      expect(element2.text).toBe('Updated Text 2');
      expect(element3.text).toBe('Text 3');
    });
  });

  describe('edge cases', () => {
    test('should handle very long text', async () => {
      const longText = 'A'.repeat(1000);
      const textElement = await textEditor.addText(0, longText, 100, 700);
      expect(textElement.text).toBe(longText);
      expect(textElement.width).toBeGreaterThan(0);
    });

    test('should handle very small font size', async () => {
      const textElement = await textEditor.addText(0, 'Tiny', 100, 700, { size: 1 });
      expect(textElement.options.size).toBe(1);
      expect(textElement.height).toBeGreaterThan(0);
    });

    test('should handle very large font size', async () => {
      const textElement = await textEditor.addText(0, 'Big', 100, 700, { size: 100 });
      expect(textElement.options.size).toBe(100);
      expect(textElement.height).toBeGreaterThan(50);
    });

    test('should handle multiple pages', async () => {
      pdfDoc.addPage([595, 842]); // Add second page
      
      const element1 = await textEditor.addText(0, 'Page 1', 100, 700);
      const element2 = await textEditor.addText(1, 'Page 2', 100, 700);
      
      expect(element1.pageIndex).toBe(0);
      expect(element2.pageIndex).toBe(1);
    });
  });

  describe('findTextAt', () => {
    test('should find text element at exact coordinates', async () => {
      const textElement = await textEditor.addText(0, 'Find Me', 100, 700);
      
      const found = textEditor.findTextAt(0, 100, 700);
      
      expect(found).toBeDefined();
      expect(found.id).toBe(textElement.id);
      expect(found.text).toBe('Find Me');
    });

    test('should find text element within bounding box', async () => {
      const textElement = await textEditor.addText(0, 'Test', 100, 700);
      
      // Test coordinates within the text bounding box
      const found = textEditor.findTextAt(0, 100 + textElement.width / 2, 700 + textElement.height / 2);
      
      expect(found).toBeDefined();
      expect(found.id).toBe(textElement.id);
    });

    test('should return null when no text at coordinates', async () => {
      await textEditor.addText(0, 'Test', 100, 700);
      
      const found = textEditor.findTextAt(0, 500, 500);
      
      expect(found).toBeNull();
    });

    test('should return null for invalid page index', async () => {
      await textEditor.addText(0, 'Test', 100, 700);
      
      const found = textEditor.findTextAt(5, 100, 700);
      
      expect(found).toBeNull();
    });

    test('should return null for negative page index', async () => {
      await textEditor.addText(0, 'Test', 100, 700);
      
      const found = textEditor.findTextAt(-1, 100, 700);
      
      expect(found).toBeNull();
    });

    test('should find correct element when multiple elements exist', async () => {
      const element1 = await textEditor.addText(0, 'Text 1', 100, 700);
      const element2 = await textEditor.addText(0, 'Text 2', 200, 600);
      const element3 = await textEditor.addText(0, 'Text 3', 300, 500);
      
      const found = textEditor.findTextAt(0, 200, 600);
      
      expect(found).toBeDefined();
      expect(found.id).toBe(element2.id);
      expect(found.text).toBe('Text 2');
    });

    test('should only find elements on specified page', async () => {
      pdfDoc.addPage([595, 842]); // Add second page
      
      const element1 = await textEditor.addText(0, 'Page 1', 100, 700);
      const element2 = await textEditor.addText(1, 'Page 2', 100, 700);
      
      const foundPage0 = textEditor.findTextAt(0, 100, 700);
      const foundPage1 = textEditor.findTextAt(1, 100, 700);
      
      expect(foundPage0.id).toBe(element1.id);
      expect(foundPage1.id).toBe(element2.id);
    });

    test('should not find removed elements', async () => {
      const textElement = await textEditor.addText(0, 'Remove Me', 100, 700);
      
      await textEditor.removeText(textElement);
      
      const found = textEditor.findTextAt(0, 100, 700);
      
      expect(found).toBeNull();
    });

    test('should find element at edge of bounding box', async () => {
      const textElement = await textEditor.addText(0, 'Edge Test', 100, 700);
      
      // Test at right edge
      const foundRight = textEditor.findTextAt(0, 100 + textElement.width, 700);
      expect(foundRight).toBeDefined();
      expect(foundRight.id).toBe(textElement.id);
      
      // Test at top edge
      const foundTop = textEditor.findTextAt(0, 100, 700 + textElement.height);
      expect(foundTop).toBeDefined();
      expect(foundTop.id).toBe(textElement.id);
    });

    test('should not find element just outside bounding box', async () => {
      const textElement = await textEditor.addText(0, 'Test', 100, 700);
      
      // Just beyond right edge
      const foundRight = textEditor.findTextAt(0, 100 + textElement.width + 1, 700);
      expect(foundRight).toBeNull();
      
      // Just beyond top edge
      const foundTop = textEditor.findTextAt(0, 100, 700 + textElement.height + 1);
      expect(foundTop).toBeNull();
      
      // Just before left edge
      const foundLeft = textEditor.findTextAt(0, 99, 700);
      expect(foundLeft).toBeNull();
      
      // Just before bottom edge
      const foundBottom = textEditor.findTextAt(0, 100, 699);
      expect(foundBottom).toBeNull();
    });

    test('should handle overlapping text elements', async () => {
      // Add two overlapping text elements
      const element1 = await textEditor.addText(0, 'First', 100, 700);
      const element2 = await textEditor.addText(0, 'Second', 100, 700);
      
      // Should find one of them (implementation returns first match)
      const found = textEditor.findTextAt(0, 100, 700);
      
      expect(found).toBeDefined();
      expect([element1.id, element2.id]).toContain(found.id);
    });
  });

  describe('getTextElements', () => {
    test('should return empty array when no text elements exist', () => {
      const elements = textEditor.getTextElements(0);
      
      expect(elements).toEqual([]);
      expect(elements.length).toBe(0);
    });

    test('should return all text elements on a page', async () => {
      const element1 = await textEditor.addText(0, 'Text 1', 100, 700);
      const element2 = await textEditor.addText(0, 'Text 2', 200, 600);
      const element3 = await textEditor.addText(0, 'Text 3', 300, 500);
      
      const elements = textEditor.getTextElements(0);
      
      expect(elements.length).toBe(3);
      expect(elements).toContainEqual(element1);
      expect(elements).toContainEqual(element2);
      expect(elements).toContainEqual(element3);
    });

    test('should only return elements from specified page', async () => {
      pdfDoc.addPage([595, 842]); // Add second page
      
      const element1 = await textEditor.addText(0, 'Page 1 Text 1', 100, 700);
      const element2 = await textEditor.addText(0, 'Page 1 Text 2', 200, 600);
      const element3 = await textEditor.addText(1, 'Page 2 Text 1', 100, 700);
      const element4 = await textEditor.addText(1, 'Page 2 Text 2', 200, 600);
      
      const page0Elements = textEditor.getTextElements(0);
      const page1Elements = textEditor.getTextElements(1);
      
      expect(page0Elements.length).toBe(2);
      expect(page1Elements.length).toBe(2);
      expect(page0Elements).toContainEqual(element1);
      expect(page0Elements).toContainEqual(element2);
      expect(page1Elements).toContainEqual(element3);
      expect(page1Elements).toContainEqual(element4);
    });

    test('should return empty array for invalid page index', async () => {
      await textEditor.addText(0, 'Test', 100, 700);
      
      const elements = textEditor.getTextElements(5);
      
      expect(elements).toEqual([]);
      expect(elements.length).toBe(0);
    });

    test('should return empty array for negative page index', async () => {
      await textEditor.addText(0, 'Test', 100, 700);
      
      const elements = textEditor.getTextElements(-1);
      
      expect(elements).toEqual([]);
      expect(elements.length).toBe(0);
    });

    test('should not include removed elements', async () => {
      const element1 = await textEditor.addText(0, 'Text 1', 100, 700);
      const element2 = await textEditor.addText(0, 'Text 2', 200, 600);
      const element3 = await textEditor.addText(0, 'Text 3', 300, 500);
      
      await textEditor.removeText(element2);
      
      const elements = textEditor.getTextElements(0);
      
      expect(elements.length).toBe(2);
      expect(elements).toContainEqual(element1);
      expect(elements).not.toContainEqual(element2);
      expect(elements).toContainEqual(element3);
    });

    test('should return updated elements after text update', async () => {
      const element1 = await textEditor.addText(0, 'Original', 100, 700);
      
      await textEditor.updateText(element1, 'Updated');
      
      const elements = textEditor.getTextElements(0);
      
      expect(elements.length).toBe(1);
      expect(elements[0].text).toBe('Updated');
    });

    test('should handle multiple pages correctly', async () => {
      pdfDoc.addPage([595, 842]); // Add second page
      pdfDoc.addPage([595, 842]); // Add third page
      
      await textEditor.addText(0, 'Page 1', 100, 700);
      await textEditor.addText(1, 'Page 2', 100, 700);
      await textEditor.addText(2, 'Page 3', 100, 700);
      
      expect(textEditor.getTextElements(0).length).toBe(1);
      expect(textEditor.getTextElements(1).length).toBe(1);
      expect(textEditor.getTextElements(2).length).toBe(1);
    });

    test('should return array that can be safely modified', async () => {
      const element1 = await textEditor.addText(0, 'Text 1', 100, 700);
      const element2 = await textEditor.addText(0, 'Text 2', 200, 600);
      
      const elements = textEditor.getTextElements(0);
      elements.push({ id: 'fake', text: 'Fake' });
      
      // Original should not be affected
      const elementsAgain = textEditor.getTextElements(0);
      expect(elementsAgain.length).toBe(2);
    });

    test('should preserve element order', async () => {
      const element1 = await textEditor.addText(0, 'First', 100, 700);
      const element2 = await textEditor.addText(0, 'Second', 200, 600);
      const element3 = await textEditor.addText(0, 'Third', 300, 500);
      
      const elements = textEditor.getTextElements(0);
      
      // Elements should be in the order they were added
      expect(elements[0].text).toBe('First');
      expect(elements[1].text).toBe('Second');
      expect(elements[2].text).toBe('Third');
    });
  });
});
