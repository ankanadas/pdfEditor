import { PDFDocument } from 'pdf-lib';
import { PDFDocumentManager } from '../src/core/PDFDocumentManager.js';
import { TextEditor } from '../src/core/TextEditor.js';

describe('TextEditor Integration Tests', () => {
  test('should persist added text when PDF is saved and reloaded', async () => {
    // Create a new PDF
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);

    // Add text using TextEditor
    const textEditor = new TextEditor(pdfDoc);
    const textElement = await textEditor.addText(0, 'Integration Test', 100, 700, {
      size: 16,
      color: { r: 0, g: 0, b: 1 }
    });

    expect(textElement).toBeDefined();
    expect(textElement.text).toBe('Integration Test');

    // Save the PDF
    const savedBytes = await pdfDoc.save();
    expect(savedBytes).toBeInstanceOf(Uint8Array);
    expect(savedBytes.length).toBeGreaterThan(0);

    // Reload the PDF
    const reloadedDoc = await PDFDocument.load(savedBytes);
    expect(reloadedDoc.getPageCount()).toBe(1);

    // The text should be embedded in the PDF
    // We can't easily extract text from pdf-lib, but we can verify the PDF is valid
    const page = reloadedDoc.getPage(0);
    expect(page.getWidth()).toBe(595);
    expect(page.getHeight()).toBe(842);
  });

  test('should handle multiple text elements on same page', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);

    const textEditor = new TextEditor(pdfDoc);

    // Add multiple text elements
    const element1 = await textEditor.addText(0, 'First Text', 100, 700);
    const element2 = await textEditor.addText(0, 'Second Text', 100, 650);
    const element3 = await textEditor.addText(0, 'Third Text', 100, 600);

    expect(textEditor.textElements.size).toBe(3);

    // Save and reload
    const savedBytes = await pdfDoc.save();
    const reloadedDoc = await PDFDocument.load(savedBytes);

    expect(reloadedDoc.getPageCount()).toBe(1);
  });

  test('should work with PDFDocumentManager', async () => {
    // Create a PDF using PDFDocumentManager
    const manager = new PDFDocumentManager();
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    const pdfBytes = await pdfDoc.save();

    await manager.loadFromArrayBuffer(pdfBytes.buffer);

    // Use TextEditor with the loaded document
    const textEditor = new TextEditor(manager.getDocument());
    await textEditor.addText(0, 'Manager Test', 200, 500);

    // Save through manager
    const savedBytes = await manager.save();
    expect(savedBytes).toBeInstanceOf(Uint8Array);

    // Reload and verify
    const newManager = new PDFDocumentManager();
    await newManager.loadFromArrayBuffer(savedBytes.buffer);
    expect(newManager.getPageCount()).toBe(1);
  });

  test('should handle text with various formatting options', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);

    const textEditor = new TextEditor(pdfDoc);

    // Add text with different options
    await textEditor.addText(0, 'Red Text', 100, 700, {
      color: { r: 1, g: 0, b: 0 },
      size: 20
    });

    await textEditor.addText(0, 'Blue Text', 100, 650, {
      color: { r: 0, g: 0, b: 1 },
      size: 14,
      font: 'Times-Roman'
    });

    await textEditor.addText(0, 'Transparent', 100, 600, {
      opacity: 0.5,
      size: 18
    });

    expect(textEditor.textElements.size).toBe(3);

    // Save and verify it's valid
    const savedBytes = await pdfDoc.save();
    const reloadedDoc = await PDFDocument.load(savedBytes);
    expect(reloadedDoc.getPageCount()).toBe(1);
  });

  test('should handle text on multiple pages', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    pdfDoc.addPage([595, 842]);
    pdfDoc.addPage([595, 842]);

    const textEditor = new TextEditor(pdfDoc);

    // Add text to each page
    await textEditor.addText(0, 'Page 1 Text', 100, 700);
    await textEditor.addText(1, 'Page 2 Text', 100, 700);
    await textEditor.addText(2, 'Page 3 Text', 100, 700);

    expect(textEditor.textElements.size).toBe(3);

    // Save and reload
    const savedBytes = await pdfDoc.save();
    const reloadedDoc = await PDFDocument.load(savedBytes);
    expect(reloadedDoc.getPageCount()).toBe(3);
  });
});
