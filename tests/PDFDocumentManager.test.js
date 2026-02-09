import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PDFDocumentManager } from '../src/core/PDFDocumentManager.js';
import { PDFEditorError, ErrorCodes } from '../src/errors/PDFEditorError.js';

// Helper function to create a simple test PDF
async function createTestPDF() {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4 size
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText('Test PDF Document', {
    x: 50,
    y: 800,
    size: 20,
    font,
    color: rgb(0, 0, 0),
  });
  return await pdfDoc.save();
}

// Helper function to create a corrupted PDF buffer
function createCorruptedPDF() {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0xFF, 0xFF, 0xFF]); // Invalid PDF
}

describe('PDFDocumentManager', () => {
  let manager;

  beforeEach(() => {
    manager = new PDFDocumentManager();
  });

  describe('loadFromArrayBuffer', () => {
    test('should load a valid PDF from ArrayBuffer', async () => {
      const pdfBytes = await createTestPDF();
      await manager.loadFromArrayBuffer(pdfBytes.buffer);

      expect(manager.getDocument()).toBeDefined();
      expect(manager.getPageCount()).toBe(1);
    });

    test('should throw PDFEditorError for corrupted PDF', async () => {
      const corruptedBytes = createCorruptedPDF();
      
      await expect(manager.loadFromArrayBuffer(corruptedBytes.buffer))
        .rejects.toThrow(PDFEditorError);
      
      await expect(manager.loadFromArrayBuffer(corruptedBytes.buffer))
        .rejects.toMatchObject({
          code: ErrorCodes.CORRUPTED_FILE,
        });
    });

    test('should throw PDFEditorError for empty buffer', async () => {
      const emptyBuffer = new ArrayBuffer(0);
      
      await expect(manager.loadFromArrayBuffer(emptyBuffer))
        .rejects.toThrow(PDFEditorError);
    });
  });

  describe('loadFromFile', () => {
    test('should load a valid PDF from File object', async () => {
      const pdfBytes = await createTestPDF();
      // Mock File with arrayBuffer method for jsdom compatibility
      const file = {
        arrayBuffer: async () => pdfBytes.buffer,
        name: 'test.pdf',
        type: 'application/pdf'
      };
      
      await manager.loadFromFile(file);

      expect(manager.getDocument()).toBeDefined();
      expect(manager.getPageCount()).toBe(1);
    });

    test('should throw PDFEditorError for corrupted PDF file', async () => {
      const corruptedBytes = createCorruptedPDF();
      const file = {
        arrayBuffer: async () => corruptedBytes.buffer,
        name: 'corrupted.pdf',
        type: 'application/pdf'
      };
      
      await expect(manager.loadFromFile(file))
        .rejects.toThrow(PDFEditorError);
    });
  });

  describe('getDocument', () => {
    test('should return the loaded PDF document', async () => {
      const pdfBytes = await createTestPDF();
      await manager.loadFromArrayBuffer(pdfBytes.buffer);

      const doc = manager.getDocument();
      expect(doc).toBeInstanceOf(PDFDocument);
    });

    test('should throw error when no document is loaded', () => {
      expect(() => manager.getDocument()).toThrow(PDFEditorError);
      expect(() => manager.getDocument()).toThrow('No PDF document loaded');
    });
  });

  describe('getPageCount', () => {
    test('should return correct page count', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage();
      pdfDoc.addPage();
      pdfDoc.addPage();
      const pdfBytes = await pdfDoc.save();

      await manager.loadFromArrayBuffer(pdfBytes.buffer);

      expect(manager.getPageCount()).toBe(3);
    });

    test('should throw error when no document is loaded', () => {
      expect(() => manager.getPageCount()).toThrow(PDFEditorError);
    });
  });

  describe('getPage', () => {
    test('should return the correct page by index', async () => {
      const pdfBytes = await createTestPDF();
      await manager.loadFromArrayBuffer(pdfBytes.buffer);

      const page = manager.getPage(0);
      expect(page).toBeDefined();
      expect(page.getWidth()).toBe(595);
      expect(page.getHeight()).toBe(842);
    });

    test('should throw error for invalid page index (negative)', async () => {
      const pdfBytes = await createTestPDF();
      await manager.loadFromArrayBuffer(pdfBytes.buffer);

      expect(() => manager.getPage(-1)).toThrow(PDFEditorError);
      expect(() => manager.getPage(-1)).toThrow('Invalid page index');
    });

    test('should throw error for invalid page index (out of bounds)', async () => {
      const pdfBytes = await createTestPDF();
      await manager.loadFromArrayBuffer(pdfBytes.buffer);

      expect(() => manager.getPage(5)).toThrow(PDFEditorError);
    });

    test('should throw error when no document is loaded', () => {
      expect(() => manager.getPage(0)).toThrow(PDFEditorError);
    });
  });

  describe('save', () => {
    test('should save a loaded PDF to Uint8Array', async () => {
      const pdfBytes = await createTestPDF();
      await manager.loadFromArrayBuffer(pdfBytes.buffer);

      const savedBytes = await manager.save();
      expect(savedBytes).toBeInstanceOf(Uint8Array);
      expect(savedBytes.length).toBeGreaterThan(0);
    });

    test('should throw error when no document is loaded', async () => {
      await expect(manager.save()).rejects.toThrow(PDFEditorError);
      await expect(manager.save()).rejects.toThrow('No PDF document loaded');
    });

    test('saved PDF should be loadable', async () => {
      const pdfBytes = await createTestPDF();
      await manager.loadFromArrayBuffer(pdfBytes.buffer);

      const savedBytes = await manager.save();
      
      // Create a new manager and load the saved PDF
      const newManager = new PDFDocumentManager();
      await newManager.loadFromArrayBuffer(savedBytes.buffer);

      expect(newManager.getPageCount()).toBe(1);
    });
  });

  describe('save-load round trip', () => {
    test('should preserve document structure after save-load cycle', async () => {
      // Create a PDF with multiple pages and content
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      const page1 = pdfDoc.addPage([595, 842]);
      page1.drawText('Page 1', { x: 50, y: 800, size: 20, font });
      
      const page2 = pdfDoc.addPage([595, 842]);
      page2.drawText('Page 2', { x: 50, y: 800, size: 20, font });
      
      const originalBytes = await pdfDoc.save();

      // Load, save, and reload
      await manager.loadFromArrayBuffer(originalBytes.buffer);
      const savedBytes = await manager.save();
      
      const newManager = new PDFDocumentManager();
      await newManager.loadFromArrayBuffer(savedBytes.buffer);

      // Verify structure is preserved
      expect(newManager.getPageCount()).toBe(2);
      expect(newManager.getPage(0).getWidth()).toBe(595);
      expect(newManager.getPage(0).getHeight()).toBe(842);
      expect(newManager.getPage(1).getWidth()).toBe(595);
      expect(newManager.getPage(1).getHeight()).toBe(842);
    });

    test('should preserve metadata after save-load cycle', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.setTitle('Test Document');
      pdfDoc.setAuthor('Test Author');
      pdfDoc.setSubject('Test Subject');
      pdfDoc.addPage();
      
      const originalBytes = await pdfDoc.save();

      await manager.loadFromArrayBuffer(originalBytes.buffer);
      const savedBytes = await manager.save();
      
      const newManager = new PDFDocumentManager();
      await newManager.loadFromArrayBuffer(savedBytes.buffer);

      const doc = newManager.getDocument();
      expect(doc.getTitle()).toBe('Test Document');
      expect(doc.getAuthor()).toBe('Test Author');
      expect(doc.getSubject()).toBe('Test Subject');
    });
  });

  describe('edge cases', () => {
    test('should handle PDF with single empty page', async () => {
      // pdf-lib automatically adds a page when creating a document
      const pdfDoc = await PDFDocument.create();
      const pdfBytes = await pdfDoc.save();

      await manager.loadFromArrayBuffer(pdfBytes.buffer);

      // pdf-lib creates a document with 1 empty page by default
      expect(manager.getPageCount()).toBe(1);
    });

    test('should handle large PDF documents', async () => {
      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      
      // Create 50 pages
      for (let i = 0; i < 50; i++) {
        const page = pdfDoc.addPage();
        page.drawText(`Page ${i + 1}`, { x: 50, y: 800, size: 20, font });
      }
      
      const pdfBytes = await pdfDoc.save();

      await manager.loadFromArrayBuffer(pdfBytes.buffer);

      expect(manager.getPageCount()).toBe(50);
      expect(manager.getPage(0)).toBeDefined();
      expect(manager.getPage(49)).toBeDefined();
    });
  });
});
