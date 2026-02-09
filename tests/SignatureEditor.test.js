import { SignatureEditor } from '../src/core/SignatureEditor.js';
import { PDFEditorError, ErrorCodes } from '../src/errors/PDFEditorError.js';
import { PDFDocument } from 'pdf-lib';

describe('SignatureEditor - Data Structures', () => {
  let pdfDoc;
  let signatureEditor;

  beforeEach(async () => {
    // Create a new PDF document for testing
    pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]); // A4 size
    signatureEditor = new SignatureEditor(pdfDoc);
  });

  describe('Constructor', () => {
    test('should create SignatureEditor with valid PDF document', () => {
      expect(signatureEditor).toBeInstanceOf(SignatureEditor);
      expect(signatureEditor.pdfDocument).toBe(pdfDoc);
      expect(signatureEditor.signatures).toBeInstanceOf(Map);
      expect(signatureEditor.signatures.size).toBe(0);
      expect(signatureEditor.idCounter).toBe(0);
    });

    test('should throw error when PDF document is not provided', () => {
      expect(() => new SignatureEditor(null)).toThrow(PDFEditorError);
      expect(() => new SignatureEditor(null)).toThrow('PDF document is required');
    });

    test('should throw error with correct error code when PDF document is missing', () => {
      try {
        new SignatureEditor(undefined);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(PDFEditorError);
        expect(error.code).toBe(ErrorCodes.OPERATION_FAILED);
      }
    });
  });

  describe('ID Generation', () => {
    test('should generate unique IDs', () => {
      const id1 = signatureEditor._generateId();
      const id2 = signatureEditor._generateId();
      const id3 = signatureEditor._generateId();

      expect(id1).toMatch(/^signature-\d+-\d+$/);
      expect(id2).toMatch(/^signature-\d+-\d+$/);
      expect(id3).toMatch(/^signature-\d+-\d+$/);

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });

    test('should increment counter for each ID', () => {
      expect(signatureEditor.idCounter).toBe(0);
      signatureEditor._generateId();
      expect(signatureEditor.idCounter).toBe(1);
      signatureEditor._generateId();
      expect(signatureEditor.idCounter).toBe(2);
      signatureEditor._generateId();
      expect(signatureEditor.idCounter).toBe(3);
    });

    test('should include timestamp in ID', () => {
      const beforeTime = Date.now();
      const id = signatureEditor._generateId();
      const afterTime = Date.now();

      const timestamp = parseInt(id.split('-')[2]);
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('Coordinate Validation', () => {
    test('should validate coordinates within page bounds', () => {
      expect(() => signatureEditor._validateCoordinates(0, 100, 100)).not.toThrow();
      expect(() => signatureEditor._validateCoordinates(0, 0, 0)).not.toThrow();
      expect(() => signatureEditor._validateCoordinates(0, 595, 842)).not.toThrow();
    });

    test('should throw error for invalid page index', () => {
      expect(() => signatureEditor._validateCoordinates(-1, 100, 100)).toThrow(PDFEditorError);
      expect(() => signatureEditor._validateCoordinates(5, 100, 100)).toThrow(PDFEditorError);
    });

    test('should throw error with correct details for invalid page index', () => {
      try {
        signatureEditor._validateCoordinates(10, 100, 100);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(PDFEditorError);
        expect(error.code).toBe(ErrorCodes.INVALID_COORDINATES);
        expect(error.details.pageIndex).toBe(10);
        expect(error.details.pageCount).toBe(1);
      }
    });

    test('should throw error for coordinates out of bounds', () => {
      expect(() => signatureEditor._validateCoordinates(0, -10, 100)).toThrow(PDFEditorError);
      expect(() => signatureEditor._validateCoordinates(0, 100, -10)).toThrow(PDFEditorError);
      expect(() => signatureEditor._validateCoordinates(0, 600, 100)).toThrow(PDFEditorError);
      expect(() => signatureEditor._validateCoordinates(0, 100, 850)).toThrow(PDFEditorError);
    });

    test('should throw error with correct details for out of bounds coordinates', () => {
      try {
        signatureEditor._validateCoordinates(0, 1000, 1000);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(PDFEditorError);
        expect(error.code).toBe(ErrorCodes.INVALID_COORDINATES);
        expect(error.details.x).toBe(1000);
        expect(error.details.y).toBe(1000);
        expect(error.details.pageWidth).toBe(595);
        expect(error.details.pageHeight).toBe(842);
      }
    });
  });

  describe('Signatures Map', () => {
    test('should initialize with empty signatures map', () => {
      expect(signatureEditor.signatures).toBeInstanceOf(Map);
      expect(signatureEditor.signatures.size).toBe(0);
    });

    test('should allow storing signatures in the map', () => {
      const signature = {
        id: 'test-sig-1',
        pageIndex: 0,
        type: 'image',
        x: 100,
        y: 100,
        width: 200,
        height: 100,
        options: {},
        data: null
      };

      signatureEditor.signatures.set(signature.id, signature);
      expect(signatureEditor.signatures.size).toBe(1);
      expect(signatureEditor.signatures.get('test-sig-1')).toBe(signature);
    });

    test('should allow retrieving signatures from the map', () => {
      const sig1 = { id: 'sig-1', type: 'image' };
      const sig2 = { id: 'sig-2', type: 'drawn' };
      const sig3 = { id: 'sig-3', type: 'typed' };

      signatureEditor.signatures.set(sig1.id, sig1);
      signatureEditor.signatures.set(sig2.id, sig2);
      signatureEditor.signatures.set(sig3.id, sig3);

      expect(signatureEditor.signatures.get('sig-1')).toBe(sig1);
      expect(signatureEditor.signatures.get('sig-2')).toBe(sig2);
      expect(signatureEditor.signatures.get('sig-3')).toBe(sig3);
      expect(signatureEditor.signatures.size).toBe(3);
    });
  });
});

describe('SignatureEditor - addImageSignature()', () => {
  let pdfDoc;
  let signatureEditor;

  beforeEach(async () => {
    pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]); // A4 size
    signatureEditor = new SignatureEditor(pdfDoc);
  });

  // Helper to create a minimal valid PNG
  const createPngData = () => {
    // Minimal PNG: signature + IHDR + IEND
    return new Uint8Array([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 image
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F,
      0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59,
      0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
      0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
  };

  // Helper to create a minimal valid JPG
  const createJpgData = () => {
    // Minimal JPEG: SOI + APP0 + SOF0 + SOS + EOI
    return new Uint8Array([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, // JPEG signature + APP0
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
      0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, // Quantization table
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
      0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C,
      0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
      0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D,
      0x1A, 0x1C, 0x1C, 0x20, 0x24, 0x2E, 0x27, 0x20,
      0x22, 0x2C, 0x23, 0x1C, 0x1C, 0x28, 0x37, 0x29,
      0x2C, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1F, 0x27,
      0x39, 0x3D, 0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34,
      0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, // SOF0
      0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4,
      0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // Huffman table
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x03, 0xFF, 0xDA, 0x00, 0x08, // SOS
      0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xD2, 0xFF,
      0xD9 // EOI
    ]);
  };

  describe('Input Validation', () => {
    test('should throw error when imageData is not Uint8Array', async () => {
      await expect(
        signatureEditor.addImageSignature(0, 'not-a-uint8array', 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addImageSignature(0, null, 100, 100)
      ).rejects.toThrow('Image data must be a Uint8Array');
    });

    test('should throw error when imageData is empty', async () => {
      await expect(
        signatureEditor.addImageSignature(0, new Uint8Array([]), 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addImageSignature(0, new Uint8Array([]), 100, 100)
      ).rejects.toThrow('Image data cannot be empty');
    });

    test('should throw error for unsupported image format', async () => {
      const invalidData = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      
      await expect(
        signatureEditor.addImageSignature(0, invalidData, 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addImageSignature(0, invalidData, 100, 100)
      ).rejects.toThrow('Image format not supported');
    });

    test('should throw error for invalid page index', async () => {
      const pngData = createPngData();
      
      await expect(
        signatureEditor.addImageSignature(-1, pngData, 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addImageSignature(10, pngData, 100, 100)
      ).rejects.toThrow('Invalid page index');
    });

    test('should throw error for coordinates out of bounds', async () => {
      const pngData = createPngData();
      
      await expect(
        signatureEditor.addImageSignature(0, pngData, -10, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addImageSignature(0, pngData, 1000, 100)
      ).rejects.toThrow('Coordinates are out of page bounds');
    });

    test('should throw error for invalid opacity', async () => {
      const pngData = createPngData();
      
      await expect(
        signatureEditor.addImageSignature(0, pngData, 100, 100, { opacity: -0.5 })
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addImageSignature(0, pngData, 100, 100, { opacity: 1.5 })
      ).rejects.toThrow('Opacity must be between 0 and 1');
    });
  });

  describe('PNG Image Signatures', () => {
    test('should add PNG signature successfully', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      expect(signature).toBeDefined();
      expect(signature.id).toMatch(/^signature-\d+-\d+$/);
      expect(signature.pageIndex).toBe(0);
      expect(signature.type).toBe('image');
      expect(signature.x).toBe(100);
      expect(signature.y).toBe(200);
      expect(signature.width).toBeGreaterThan(0);
      expect(signature.height).toBeGreaterThan(0);
    });

    test('should store PNG signature in internal map', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      expect(signatureEditor.signatures.size).toBe(1);
      expect(signatureEditor.signatures.get(signature.id)).toBe(signature);
    });

    test('should apply custom width and height to PNG signature', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        width: 150,
        height: 75
      });

      expect(signature.width).toBe(150);
      expect(signature.height).toBe(75);
      expect(signature.options.width).toBe(150);
      expect(signature.options.height).toBe(75);
    });

    test('should apply opacity to PNG signature', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        opacity: 0.5
      });

      expect(signature.options.opacity).toBe(0.5);
    });

    test('should apply rotation to PNG signature', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        rotation: 45
      });

      expect(signature.options.rotation).toBe(45);
    });

    test('should use default opacity of 1 when not specified', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      expect(signature.options.opacity).toBe(1);
    });

    test('should use default rotation of 0 when not specified', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      expect(signature.options.rotation).toBe(0);
    });
  });

  describe('JPG Image Signatures', () => {
    test('should add JPG signature successfully', async () => {
      const jpgData = createJpgData();
      const signature = await signatureEditor.addImageSignature(0, jpgData, 150, 250);

      expect(signature).toBeDefined();
      expect(signature.id).toMatch(/^signature-\d+-\d+$/);
      expect(signature.pageIndex).toBe(0);
      expect(signature.type).toBe('image');
      expect(signature.x).toBe(150);
      expect(signature.y).toBe(250);
      expect(signature.width).toBeGreaterThan(0);
      expect(signature.height).toBeGreaterThan(0);
    });

    test('should store JPG signature in internal map', async () => {
      const jpgData = createJpgData();
      const signature = await signatureEditor.addImageSignature(0, jpgData, 150, 250);

      expect(signatureEditor.signatures.size).toBe(1);
      expect(signatureEditor.signatures.get(signature.id)).toBe(signature);
    });

    test('should apply custom dimensions to JPG signature', async () => {
      const jpgData = createJpgData();
      const signature = await signatureEditor.addImageSignature(0, jpgData, 150, 250, {
        width: 200,
        height: 100
      });

      expect(signature.width).toBe(200);
      expect(signature.height).toBe(100);
    });
  });

  describe('Multiple Signatures', () => {
    test('should add multiple signatures to the same page', async () => {
      const pngData = createPngData();
      const jpgData = createJpgData();

      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const sig2 = await signatureEditor.addImageSignature(0, jpgData, 200, 200);
      const sig3 = await signatureEditor.addImageSignature(0, pngData, 300, 300);

      expect(signatureEditor.signatures.size).toBe(3);
      expect(sig1.id).not.toBe(sig2.id);
      expect(sig2.id).not.toBe(sig3.id);
      expect(sig1.id).not.toBe(sig3.id);
    });

    test('should add signatures to different pages', async () => {
      pdfDoc.addPage([595, 842]); // Add second page
      const pngData = createPngData();

      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const sig2 = await signatureEditor.addImageSignature(1, pngData, 200, 200);

      expect(signatureEditor.signatures.size).toBe(2);
      expect(sig1.pageIndex).toBe(0);
      expect(sig2.pageIndex).toBe(1);
    });
  });

  describe('Signature Data Storage', () => {
    test('should store image data in signature object', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      expect(signature.data).toBeDefined();
      expect(signature.data.imageData).toBe(pngData);
      expect(signature.data.embeddedImage).toBeDefined();
    });

    test('should store all options in signature object', async () => {
      const pngData = createPngData();
      const options = {
        width: 150,
        height: 75,
        opacity: 0.8,
        rotation: 30
      };
      
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, options);

      expect(signature.options.width).toBe(150);
      expect(signature.options.height).toBe(75);
      expect(signature.options.opacity).toBe(0.8);
      expect(signature.options.rotation).toBe(30);
    });
  });

  describe('Edge Cases', () => {
    test('should handle signature at page boundaries', async () => {
      const pngData = createPngData();
      
      // Top-left corner
      const sig1 = await signatureEditor.addImageSignature(0, pngData, 0, 0);
      expect(sig1).toBeDefined();

      // Bottom-right corner
      const sig2 = await signatureEditor.addImageSignature(0, pngData, 595, 842);
      expect(sig2).toBeDefined();
    });

    test('should handle opacity of 0 (fully transparent)', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        opacity: 0
      });

      expect(signature.options.opacity).toBe(0);
    });

    test('should handle opacity of 1 (fully opaque)', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        opacity: 1
      });

      expect(signature.options.opacity).toBe(1);
    });

    test('should handle negative rotation', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        rotation: -45
      });

      expect(signature.options.rotation).toBe(-45);
    });

    test('should handle rotation greater than 360', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        rotation: 450
      });

      expect(signature.options.rotation).toBe(450);
    });
  });
});

describe('SignatureEditor - addDrawnSignature()', () => {
  let pdfDoc;
  let signatureEditor;

  beforeEach(async () => {
    pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]); // A4 size
    signatureEditor = new SignatureEditor(pdfDoc);
  });

  // Helper to create simple path data
  const createSimplePath = () => ({
    commands: [
      { type: 'moveTo', x: 0, y: 0 },
      { type: 'lineTo', x: 100, y: 0 },
      { type: 'lineTo', x: 100, y: 50 },
      { type: 'lineTo', x: 0, y: 50 },
      { type: 'closePath' }
    ]
  });

  // Helper to create signature-like path
  const createSignaturePath = () => ({
    commands: [
      { type: 'moveTo', x: 10, y: 20 },
      { type: 'bezierCurveTo', cp1x: 30, cp1y: 10, cp2x: 50, cp2y: 30, x: 70, y: 20 },
      { type: 'lineTo', x: 80, y: 25 },
      { type: 'quadraticCurveTo', cpx: 90, cpy: 15, x: 100, y: 20 }
    ]
  });

  describe('Input Validation', () => {
    test('should throw error when pathData is null or undefined', async () => {
      await expect(
        signatureEditor.addDrawnSignature(0, null, 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addDrawnSignature(0, null, 100, 100)
      ).rejects.toThrow('Path data is required');

      await expect(
        signatureEditor.addDrawnSignature(0, undefined, 100, 100)
      ).rejects.toThrow(PDFEditorError);
    });

    test('should throw error when pathData has no commands', async () => {
      await expect(
        signatureEditor.addDrawnSignature(0, {}, 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addDrawnSignature(0, {}, 100, 100)
      ).rejects.toThrow('Path data must be a Path2D object with commands property or an object with commands array');
    });

    test('should throw error when commands is not an array', async () => {
      await expect(
        signatureEditor.addDrawnSignature(0, { commands: 'not-an-array' }, 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addDrawnSignature(0, { commands: 'not-an-array' }, 100, 100)
      ).rejects.toThrow('Path commands must be a non-empty array');
    });

    test('should throw error when commands array is empty', async () => {
      await expect(
        signatureEditor.addDrawnSignature(0, { commands: [] }, 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addDrawnSignature(0, { commands: [] }, 100, 100)
      ).rejects.toThrow('Path commands must be a non-empty array');
    });

    test('should throw error for invalid page index', async () => {
      const pathData = createSimplePath();
      
      await expect(
        signatureEditor.addDrawnSignature(-1, pathData, 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addDrawnSignature(10, pathData, 100, 100)
      ).rejects.toThrow('Invalid page index');
    });

    test('should throw error for coordinates out of bounds', async () => {
      const pathData = createSimplePath();
      
      await expect(
        signatureEditor.addDrawnSignature(0, pathData, -10, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addDrawnSignature(0, pathData, 1000, 100)
      ).rejects.toThrow('Coordinates are out of page bounds');
    });

    test('should throw error for invalid opacity', async () => {
      const pathData = createSimplePath();
      
      await expect(
        signatureEditor.addDrawnSignature(0, pathData, 100, 100, { opacity: -0.5 })
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addDrawnSignature(0, pathData, 100, 100, { opacity: 1.5 })
      ).rejects.toThrow('Opacity must be between 0 and 1');
    });
  });

  describe('Basic Drawn Signatures', () => {
    test('should add drawn signature successfully', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);

      expect(signature).toBeDefined();
      expect(signature.id).toMatch(/^signature-\d+-\d+$/);
      expect(signature.pageIndex).toBe(0);
      expect(signature.type).toBe('drawn');
      expect(signature.x).toBe(100);
      expect(signature.y).toBe(200);
      expect(signature.width).toBeGreaterThan(0);
      expect(signature.height).toBeGreaterThan(0);
    });

    test('should store drawn signature in internal map', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);

      expect(signatureEditor.signatures.size).toBe(1);
      expect(signatureEditor.signatures.get(signature.id)).toBe(signature);
    });

    test('should apply custom width and height', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, {
        width: 150,
        height: 75
      });

      expect(signature.width).toBe(150);
      expect(signature.height).toBe(75);
      expect(signature.options.width).toBe(150);
      expect(signature.options.height).toBe(75);
    });

    test('should apply opacity', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, {
        opacity: 0.5
      });

      expect(signature.options.opacity).toBe(0.5);
    });

    test('should apply rotation', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, {
        rotation: 45
      });

      expect(signature.options.rotation).toBe(45);
    });

    test('should use default opacity of 1 when not specified', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);

      expect(signature.options.opacity).toBe(1);
    });

    test('should use default rotation of 0 when not specified', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);

      expect(signature.options.rotation).toBe(0);
    });

    test('should use default stroke color (black) when not specified', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);

      expect(signature.options.strokeColor).toEqual({ r: 0, g: 0, b: 0 });
    });

    test('should use default stroke width of 2 when not specified', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);

      expect(signature.options.strokeWidth).toBe(2);
    });
  });

  describe('Path Command Types', () => {
    test('should handle moveTo and lineTo commands', async () => {
      const pathData = {
        commands: [
          { type: 'moveTo', x: 10, y: 10 },
          { type: 'lineTo', x: 50, y: 10 },
          { type: 'lineTo', x: 50, y: 50 }
        ]
      };
      
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);
      expect(signature).toBeDefined();
      expect(signature.data.pathData).toEqual(pathData.commands);
    });

    test('should handle bezierCurveTo commands', async () => {
      const pathData = {
        commands: [
          { type: 'moveTo', x: 10, y: 20 },
          { type: 'bezierCurveTo', cp1x: 30, cp1y: 10, cp2x: 50, cp2y: 30, x: 70, y: 20 }
        ]
      };
      
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);
      expect(signature).toBeDefined();
      expect(signature.data.pathData).toEqual(pathData.commands);
    });

    test('should handle quadraticCurveTo commands', async () => {
      const pathData = {
        commands: [
          { type: 'moveTo', x: 10, y: 20 },
          { type: 'quadraticCurveTo', cpx: 50, cpy: 10, x: 90, y: 20 }
        ]
      };
      
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);
      expect(signature).toBeDefined();
      expect(signature.data.pathData).toEqual(pathData.commands);
    });

    test('should handle closePath command', async () => {
      const pathData = {
        commands: [
          { type: 'moveTo', x: 10, y: 10 },
          { type: 'lineTo', x: 50, y: 10 },
          { type: 'lineTo', x: 50, y: 50 },
          { type: 'closePath' }
        ]
      };
      
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);
      expect(signature).toBeDefined();
    });

    test('should handle complex signature path', async () => {
      const pathData = createSignaturePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);

      expect(signature).toBeDefined();
      expect(signature.type).toBe('drawn');
    });
  });

  describe('Custom Styling Options', () => {
    test('should apply custom stroke color', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, {
        strokeColor: { r: 0, g: 0, b: 1 } // Blue
      });

      expect(signature.options.strokeColor).toEqual({ r: 0, g: 0, b: 1 });
    });

    test('should apply custom stroke width', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, {
        strokeWidth: 5
      });

      expect(signature.options.strokeWidth).toBe(5);
    });

    test('should apply multiple custom options together', async () => {
      const pathData = createSimplePath();
      const options = {
        width: 200,
        height: 100,
        opacity: 0.7,
        rotation: 30,
        strokeColor: { r: 1, g: 0, b: 0 },
        strokeWidth: 3
      };
      
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, options);

      expect(signature.options.width).toBe(200);
      expect(signature.options.height).toBe(100);
      expect(signature.options.opacity).toBe(0.7);
      expect(signature.options.rotation).toBe(30);
      expect(signature.options.strokeColor).toEqual({ r: 1, g: 0, b: 0 });
      expect(signature.options.strokeWidth).toBe(3);
    });
  });

  describe('Multiple Drawn Signatures', () => {
    test('should add multiple drawn signatures to the same page', async () => {
      const path1 = createSimplePath();
      const path2 = createSignaturePath();

      const sig1 = await signatureEditor.addDrawnSignature(0, path1, 100, 100);
      const sig2 = await signatureEditor.addDrawnSignature(0, path2, 200, 200);

      expect(signatureEditor.signatures.size).toBe(2);
      expect(sig1.id).not.toBe(sig2.id);
    });

    test('should add drawn signatures to different pages', async () => {
      pdfDoc.addPage([595, 842]); // Add second page
      const pathData = createSimplePath();

      const sig1 = await signatureEditor.addDrawnSignature(0, pathData, 100, 100);
      const sig2 = await signatureEditor.addDrawnSignature(1, pathData, 200, 200);

      expect(signatureEditor.signatures.size).toBe(2);
      expect(sig1.pageIndex).toBe(0);
      expect(sig2.pageIndex).toBe(1);
    });
  });

  describe('Signature Data Storage', () => {
    test('should store path data in signature object', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);

      expect(signature.data).toBeDefined();
      expect(signature.data.pathData).toEqual(pathData.commands);
      expect(signature.data.bounds).toBeDefined();
    });

    test('should calculate and store bounding box', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);

      expect(signature.data.bounds).toBeDefined();
      expect(signature.data.bounds.x).toBeDefined();
      expect(signature.data.bounds.y).toBeDefined();
      expect(signature.data.bounds.width).toBeGreaterThan(0);
      expect(signature.data.bounds.height).toBeGreaterThan(0);
    });

    test('should store all options in signature object', async () => {
      const pathData = createSimplePath();
      const options = {
        width: 150,
        height: 75,
        opacity: 0.8,
        rotation: 30,
        strokeColor: { r: 0.5, g: 0.5, b: 0.5 },
        strokeWidth: 4
      };
      
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, options);

      expect(signature.options.width).toBe(150);
      expect(signature.options.height).toBe(75);
      expect(signature.options.opacity).toBe(0.8);
      expect(signature.options.rotation).toBe(30);
      expect(signature.options.strokeColor).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
      expect(signature.options.strokeWidth).toBe(4);
    });
  });

  describe('Edge Cases', () => {
    test('should handle signature at page boundaries', async () => {
      const pathData = createSimplePath();
      
      // Top-left corner
      const sig1 = await signatureEditor.addDrawnSignature(0, pathData, 0, 0);
      expect(sig1).toBeDefined();

      // Bottom-right corner
      const sig2 = await signatureEditor.addDrawnSignature(0, pathData, 595, 842);
      expect(sig2).toBeDefined();
    });

    test('should handle opacity of 0 (fully transparent)', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, {
        opacity: 0
      });

      expect(signature.options.opacity).toBe(0);
    });

    test('should handle opacity of 1 (fully opaque)', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, {
        opacity: 1
      });

      expect(signature.options.opacity).toBe(1);
    });

    test('should handle negative rotation', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, {
        rotation: -45
      });

      expect(signature.options.rotation).toBe(-45);
    });

    test('should handle rotation greater than 360', async () => {
      const pathData = createSimplePath();
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, {
        rotation: 450
      });

      expect(signature.options.rotation).toBe(450);
    });

    test('should handle very small path', async () => {
      const pathData = {
        commands: [
          { type: 'moveTo', x: 0, y: 0 },
          { type: 'lineTo', x: 1, y: 1 }
        ]
      };
      
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);
      expect(signature).toBeDefined();
      expect(signature.data.bounds.width).toBeGreaterThan(0);
    });

    test('should handle path with single point', async () => {
      const pathData = {
        commands: [
          { type: 'moveTo', x: 50, y: 50 }
        ]
      };
      
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);
      expect(signature).toBeDefined();
    });
  });

  describe('Path2D Object Support', () => {
    test('should accept Path2D-like object with commands property', async () => {
      // Mock a Path2D-like object
      const path2DLike = {
        commands: [
          { type: 'moveTo', x: 10, y: 10 },
          { type: 'lineTo', x: 50, y: 50 }
        ]
      };
      
      const signature = await signatureEditor.addDrawnSignature(0, path2DLike, 100, 200);
      expect(signature).toBeDefined();
      expect(signature.type).toBe('drawn');
    });

    test('should handle object without commands property', async () => {
      const invalidPath = { notCommands: [] };
      
      await expect(
        signatureEditor.addDrawnSignature(0, invalidPath, 100, 200)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addDrawnSignature(0, invalidPath, 100, 200)
      ).rejects.toThrow('Path data must be a Path2D object with commands property or an object with commands array');
    });
  });
});

describe('SignatureEditor - addTypedSignature()', () => {
  let pdfDoc;
  let signatureEditor;

  beforeEach(async () => {
    pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]); // A4 size
    signatureEditor = new SignatureEditor(pdfDoc);
  });

  describe('Input Validation', () => {
    test('should throw error when text is not a string', async () => {
      await expect(
        signatureEditor.addTypedSignature(0, null, 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addTypedSignature(0, null, 100, 100)
      ).rejects.toThrow('Text must be a non-empty string');

      await expect(
        signatureEditor.addTypedSignature(0, 123, 100, 100)
      ).rejects.toThrow(PDFEditorError);
    });

    test('should throw error when text is empty string', async () => {
      await expect(
        signatureEditor.addTypedSignature(0, '', 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addTypedSignature(0, '', 100, 100)
      ).rejects.toThrow('Text must be a non-empty string');
    });

    test('should throw error when text is whitespace only', async () => {
      await expect(
        signatureEditor.addTypedSignature(0, '   ', 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addTypedSignature(0, '   ', 100, 100)
      ).rejects.toThrow('Text cannot be empty or whitespace only');
    });

    test('should throw error for invalid page index', async () => {
      await expect(
        signatureEditor.addTypedSignature(-1, 'John Doe', 100, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addTypedSignature(10, 'John Doe', 100, 100)
      ).rejects.toThrow('Invalid page index');
    });

    test('should throw error for coordinates out of bounds', async () => {
      await expect(
        signatureEditor.addTypedSignature(0, 'John Doe', -10, 100)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addTypedSignature(0, 'John Doe', 1000, 100)
      ).rejects.toThrow('Coordinates are out of page bounds');
    });

    test('should throw error for invalid opacity', async () => {
      await expect(
        signatureEditor.addTypedSignature(0, 'John Doe', 100, 100, { opacity: -0.5 })
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addTypedSignature(0, 'John Doe', 100, 100, { opacity: 1.5 })
      ).rejects.toThrow('Opacity must be between 0 and 1');
    });
  });

  describe('Basic Typed Signatures', () => {
    test('should add typed signature successfully', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200);

      expect(signature).toBeDefined();
      expect(signature.id).toMatch(/^signature-\d+-\d+$/);
      expect(signature.pageIndex).toBe(0);
      expect(signature.type).toBe('typed');
      expect(signature.x).toBe(100);
      expect(signature.y).toBe(200);
      expect(signature.width).toBeGreaterThan(0);
      expect(signature.height).toBeGreaterThan(0);
    });

    test('should store typed signature in internal map', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'Jane Smith', 100, 200);

      expect(signatureEditor.signatures.size).toBe(1);
      expect(signatureEditor.signatures.get(signature.id)).toBe(signature);
    });

    test('should store text in signature data', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200);

      expect(signature.data).toBeDefined();
      expect(signature.data.text).toBe('John Doe');
      expect(signature.data.font).toBe('TimesRomanItalic');
    });

    test('should use default font size of 24', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200);

      expect(signature.options.fontSize).toBe(24);
    });

    test('should use default color (black)', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200);

      expect(signature.options.color).toEqual({ r: 0, g: 0, b: 0 });
    });

    test('should use default opacity of 1', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200);

      expect(signature.options.opacity).toBe(1);
    });

    test('should use default rotation of 0', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200);

      expect(signature.options.rotation).toBe(0);
    });
  });

  describe('Custom Formatting Options', () => {
    test('should apply custom font size', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        fontSize: 36
      });

      expect(signature.options.fontSize).toBe(36);
    });

    test('should apply custom color', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        color: { r: 0, g: 0, b: 1 } // Blue
      });

      expect(signature.options.color).toEqual({ r: 0, g: 0, b: 1 });
    });

    test('should apply custom opacity', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        opacity: 0.5
      });

      expect(signature.options.opacity).toBe(0.5);
    });

    test('should apply custom rotation', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        rotation: 45
      });

      expect(signature.options.rotation).toBe(45);
    });

    test('should apply custom width and height', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        width: 200,
        height: 50
      });

      expect(signature.width).toBe(200);
      expect(signature.height).toBe(50);
      expect(signature.options.width).toBe(200);
      expect(signature.options.height).toBe(50);
    });

    test('should apply multiple custom options together', async () => {
      const options = {
        fontSize: 30,
        color: { r: 1, g: 0, b: 0 },
        opacity: 0.8,
        rotation: 15,
        width: 250,
        height: 60
      };
      
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, options);

      expect(signature.options.fontSize).toBe(30);
      expect(signature.options.color).toEqual({ r: 1, g: 0, b: 0 });
      expect(signature.options.opacity).toBe(0.8);
      expect(signature.options.rotation).toBe(15);
      expect(signature.options.width).toBe(250);
      expect(signature.options.height).toBe(60);
    });
  });

  describe('Text Content Variations', () => {
    test('should handle short names', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'Jo', 100, 200);

      expect(signature).toBeDefined();
      expect(signature.data.text).toBe('Jo');
    });

    test('should handle long names', async () => {
      const longName = 'Christopher Alexander Montgomery-Wellington III';
      const signature = await signatureEditor.addTypedSignature(0, longName, 100, 200);

      expect(signature).toBeDefined();
      expect(signature.data.text).toBe(longName);
    });

    test('should handle names with special characters', async () => {
      const signature = await signatureEditor.addTypedSignature(0, "O'Brien-Smith", 100, 200);

      expect(signature).toBeDefined();
      expect(signature.data.text).toBe("O'Brien-Smith");
    });

    test('should handle names with accents', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'José García', 100, 200);

      expect(signature).toBeDefined();
      expect(signature.data.text).toBe('José García');
    });

    test('should handle names with unicode characters', async () => {
      // Standard PDF fonts don't support all Unicode characters (like Chinese)
      // This should throw an error with a helpful message
      await expect(
        signatureEditor.addTypedSignature(0, '李明', 100, 200)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.addTypedSignature(0, '李明', 100, 200)
      ).rejects.toThrow('Text contains characters not supported by standard PDF fonts');
    });

    test('should handle text with leading/trailing spaces', async () => {
      const signature = await signatureEditor.addTypedSignature(0, ' John Doe ', 100, 200);

      expect(signature).toBeDefined();
      expect(signature.data.text).toBe(' John Doe ');
    });
  });

  describe('Multiple Typed Signatures', () => {
    test('should add multiple typed signatures to the same page', async () => {
      const sig1 = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 100);
      const sig2 = await signatureEditor.addTypedSignature(0, 'Jane Smith', 200, 200);
      const sig3 = await signatureEditor.addTypedSignature(0, 'Bob Johnson', 300, 300);

      expect(signatureEditor.signatures.size).toBe(3);
      expect(sig1.id).not.toBe(sig2.id);
      expect(sig2.id).not.toBe(sig3.id);
      expect(sig1.id).not.toBe(sig3.id);
    });

    test('should add typed signatures to different pages', async () => {
      pdfDoc.addPage([595, 842]); // Add second page

      const sig1 = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 100);
      const sig2 = await signatureEditor.addTypedSignature(1, 'Jane Smith', 200, 200);

      expect(signatureEditor.signatures.size).toBe(2);
      expect(sig1.pageIndex).toBe(0);
      expect(sig2.pageIndex).toBe(1);
    });

    test('should add typed signatures with different formatting', async () => {
      const sig1 = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 100, {
        fontSize: 20,
        color: { r: 0, g: 0, b: 0 }
      });
      const sig2 = await signatureEditor.addTypedSignature(0, 'Jane Smith', 200, 200, {
        fontSize: 30,
        color: { r: 0, g: 0, b: 1 }
      });

      expect(sig1.options.fontSize).toBe(20);
      expect(sig2.options.fontSize).toBe(30);
      expect(sig1.options.color).toEqual({ r: 0, g: 0, b: 0 });
      expect(sig2.options.color).toEqual({ r: 0, g: 0, b: 1 });
    });
  });

  describe('Mixed Signature Types', () => {
    test('should add typed signature alongside image signatures', async () => {
      // Create a minimal PNG
      const pngData = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F,
        0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59,
        0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
        0x44, 0xAE, 0x42, 0x60, 0x82
      ]);

      const imageSig = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const typedSig = await signatureEditor.addTypedSignature(0, 'John Doe', 200, 200);

      expect(signatureEditor.signatures.size).toBe(2);
      expect(imageSig.type).toBe('image');
      expect(typedSig.type).toBe('typed');
    });

    test('should add typed signature alongside drawn signatures', async () => {
      const pathData = {
        commands: [
          { type: 'moveTo', x: 0, y: 0 },
          { type: 'lineTo', x: 100, y: 50 }
        ]
      };

      const drawnSig = await signatureEditor.addDrawnSignature(0, pathData, 100, 100);
      const typedSig = await signatureEditor.addTypedSignature(0, 'John Doe', 200, 200);

      expect(signatureEditor.signatures.size).toBe(2);
      expect(drawnSig.type).toBe('drawn');
      expect(typedSig.type).toBe('typed');
    });
  });

  describe('Edge Cases', () => {
    test('should handle signature at page boundaries', async () => {
      // Top-left corner
      const sig1 = await signatureEditor.addTypedSignature(0, 'John Doe', 0, 0);
      expect(sig1).toBeDefined();

      // Bottom-right corner
      const sig2 = await signatureEditor.addTypedSignature(0, 'Jane Smith', 595, 842);
      expect(sig2).toBeDefined();
    });

    test('should handle opacity of 0 (fully transparent)', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        opacity: 0
      });

      expect(signature.options.opacity).toBe(0);
    });

    test('should handle opacity of 1 (fully opaque)', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        opacity: 1
      });

      expect(signature.options.opacity).toBe(1);
    });

    test('should handle negative rotation', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        rotation: -45
      });

      expect(signature.options.rotation).toBe(-45);
    });

    test('should handle rotation greater than 360', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        rotation: 450
      });

      expect(signature.options.rotation).toBe(450);
    });

    test('should handle very small font size', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        fontSize: 6
      });

      expect(signature.options.fontSize).toBe(6);
      expect(signature).toBeDefined();
    });

    test('should handle very large font size', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        fontSize: 72
      });

      expect(signature.options.fontSize).toBe(72);
      expect(signature).toBeDefined();
    });

    test('should handle single character text', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'X', 100, 200);

      expect(signature).toBeDefined();
      expect(signature.data.text).toBe('X');
    });
  });

  describe('Signature Data Storage', () => {
    test('should store all signature properties correctly', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200);

      expect(signature.id).toBeDefined();
      expect(signature.pageIndex).toBe(0);
      expect(signature.type).toBe('typed');
      expect(signature.x).toBe(100);
      expect(signature.y).toBe(200);
      expect(signature.width).toBeGreaterThan(0);
      expect(signature.height).toBeGreaterThan(0);
      expect(signature.options).toBeDefined();
      expect(signature.data).toBeDefined();
    });

    test('should store all options in signature object', async () => {
      const options = {
        fontSize: 28,
        color: { r: 0.2, g: 0.3, b: 0.4 },
        opacity: 0.9,
        rotation: 10,
        width: 180,
        height: 45
      };
      
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, options);

      expect(signature.options.fontSize).toBe(28);
      expect(signature.options.color).toEqual({ r: 0.2, g: 0.3, b: 0.4 });
      expect(signature.options.opacity).toBe(0.9);
      expect(signature.options.rotation).toBe(10);
      expect(signature.options.width).toBe(180);
      expect(signature.options.height).toBe(45);
    });

    test('should calculate dimensions based on text and font size', async () => {
      const sig1 = await signatureEditor.addTypedSignature(0, 'Jo', 100, 200, { fontSize: 20 });
      const sig2 = await signatureEditor.addTypedSignature(0, 'Christopher', 100, 300, { fontSize: 20 });

      // Longer text should have greater width
      expect(sig2.width).toBeGreaterThan(sig1.width);
    });

    test('should calculate dimensions based on font size', async () => {
      const sig1 = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, { fontSize: 12 });
      const sig2 = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 300, { fontSize: 36 });

      // Larger font should have greater dimensions
      expect(sig2.width).toBeGreaterThan(sig1.width);
      expect(sig2.height).toBeGreaterThan(sig1.height);
    });
  });
});

describe('SignatureEditor - removeSignature()', () => {
  let pdfDoc;
  let signatureEditor;

  beforeEach(async () => {
    pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]); // A4 size
    signatureEditor = new SignatureEditor(pdfDoc);
  });

  // Helper to create a minimal valid PNG
  const createPngData = () => {
    return new Uint8Array([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F,
      0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59,
      0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
      0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
  };

  describe('Input Validation', () => {
    test('should throw error when signature is null', async () => {
      await expect(
        signatureEditor.removeSignature(null)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.removeSignature(null)
      ).rejects.toThrow('Signature must be a valid signature object');
    });

    test('should throw error when signature is undefined', async () => {
      await expect(
        signatureEditor.removeSignature(undefined)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.removeSignature(undefined)
      ).rejects.toThrow('Signature must be a valid signature object');
    });

    test('should throw error when signature is not an object', async () => {
      await expect(
        signatureEditor.removeSignature('not-an-object')
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.removeSignature(123)
      ).rejects.toThrow(PDFEditorError);
    });

    test('should throw error when signature has no id property', async () => {
      const invalidSignature = {
        pageIndex: 0,
        type: 'image',
        x: 100,
        y: 100
      };

      await expect(
        signatureEditor.removeSignature(invalidSignature)
      ).rejects.toThrow(PDFEditorError);
      
      await expect(
        signatureEditor.removeSignature(invalidSignature)
      ).rejects.toThrow('Signature must have an id property');
    });

    test('should throw error with correct error code for invalid signature', async () => {
      try {
        await signatureEditor.removeSignature(null);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(PDFEditorError);
        expect(error.code).toBe(ErrorCodes.INVALID_SIGNATURE);
      }
    });
  });

  describe('Basic Removal', () => {
    test('should remove an existing image signature', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      expect(signatureEditor.signatures.size).toBe(1);
      expect(signatureEditor.signatures.has(signature.id)).toBe(true);

      await signatureEditor.removeSignature(signature);

      expect(signatureEditor.signatures.size).toBe(0);
      expect(signatureEditor.signatures.has(signature.id)).toBe(false);
    });

    test('should remove an existing typed signature', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200);

      expect(signatureEditor.signatures.size).toBe(1);

      await signatureEditor.removeSignature(signature);

      expect(signatureEditor.signatures.size).toBe(0);
    });

    test('should remove an existing drawn signature', async () => {
      const pathData = {
        commands: [
          { type: 'moveTo', x: 0, y: 0 },
          { type: 'lineTo', x: 100, y: 0 }
        ]
      };
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200);

      expect(signatureEditor.signatures.size).toBe(1);

      await signatureEditor.removeSignature(signature);

      expect(signatureEditor.signatures.size).toBe(0);
    });
  });

  describe('Removal Marking for Undo/Redo', () => {
    test('should mark signature as removed before deletion', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      // Store reference before removal
      const signatureId = signature.id;
      const storedSignature = signatureEditor.signatures.get(signatureId);

      await signatureEditor.removeSignature(signature);

      // The signature should have been marked as removed
      expect(storedSignature.removed).toBe(true);
      expect(storedSignature.removedAt).toBeDefined();
      expect(typeof storedSignature.removedAt).toBe('number');
    });

    test('should set removedAt timestamp when marking as removed', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      const beforeTime = Date.now();
      const storedSignature = signatureEditor.signatures.get(signature.id);
      
      await signatureEditor.removeSignature(signature);
      const afterTime = Date.now();

      expect(storedSignature.removedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(storedSignature.removedAt).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('Idempotent Removal (Property 4)', () => {
    test('should be idempotent - removing non-existent signature does not throw', async () => {
      const nonExistentSignature = {
        id: 'non-existent-id',
        pageIndex: 0,
        type: 'image',
        x: 100,
        y: 100
      };

      // Should not throw error
      await expect(
        signatureEditor.removeSignature(nonExistentSignature)
      ).resolves.not.toThrow();
    });

    test('should be idempotent - removing same signature twice does not throw', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      // First removal
      await signatureEditor.removeSignature(signature);
      expect(signatureEditor.signatures.size).toBe(0);

      // Second removal should not throw
      await expect(
        signatureEditor.removeSignature(signature)
      ).resolves.not.toThrow();
      
      expect(signatureEditor.signatures.size).toBe(0);
    });

    test('should be idempotent - multiple removals of same signature', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      // Remove multiple times
      await signatureEditor.removeSignature(signature);
      await signatureEditor.removeSignature(signature);
      await signatureEditor.removeSignature(signature);

      expect(signatureEditor.signatures.size).toBe(0);
    });
  });

  describe('Multiple Signatures', () => {
    test('should remove specific signature without affecting others', async () => {
      const pngData = createPngData();
      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const sig2 = await signatureEditor.addImageSignature(0, pngData, 200, 200);
      const sig3 = await signatureEditor.addImageSignature(0, pngData, 300, 300);

      expect(signatureEditor.signatures.size).toBe(3);

      // Remove middle signature
      await signatureEditor.removeSignature(sig2);

      expect(signatureEditor.signatures.size).toBe(2);
      expect(signatureEditor.signatures.has(sig1.id)).toBe(true);
      expect(signatureEditor.signatures.has(sig2.id)).toBe(false);
      expect(signatureEditor.signatures.has(sig3.id)).toBe(true);
    });

    test('should remove all signatures when called for each', async () => {
      const pngData = createPngData();
      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const sig2 = await signatureEditor.addImageSignature(0, pngData, 200, 200);
      const sig3 = await signatureEditor.addImageSignature(0, pngData, 300, 300);

      expect(signatureEditor.signatures.size).toBe(3);

      await signatureEditor.removeSignature(sig1);
      await signatureEditor.removeSignature(sig2);
      await signatureEditor.removeSignature(sig3);

      expect(signatureEditor.signatures.size).toBe(0);
    });

    test('should handle removing signatures of different types', async () => {
      const pngData = createPngData();
      const pathData = {
        commands: [
          { type: 'moveTo', x: 0, y: 0 },
          { type: 'lineTo', x: 100, y: 0 }
        ]
      };

      const imageSig = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const drawnSig = await signatureEditor.addDrawnSignature(0, pathData, 200, 200);
      const typedSig = await signatureEditor.addTypedSignature(0, 'John Doe', 300, 300);

      expect(signatureEditor.signatures.size).toBe(3);

      // Remove drawn signature
      await signatureEditor.removeSignature(drawnSig);

      expect(signatureEditor.signatures.size).toBe(2);
      expect(signatureEditor.signatures.has(imageSig.id)).toBe(true);
      expect(signatureEditor.signatures.has(drawnSig.id)).toBe(false);
      expect(signatureEditor.signatures.has(typedSig.id)).toBe(true);
    });
  });

  describe('Signatures on Multiple Pages', () => {
    test('should remove signature from specific page without affecting other pages', async () => {
      pdfDoc.addPage([595, 842]); // Add second page
      const pngData = createPngData();

      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const sig2 = await signatureEditor.addImageSignature(1, pngData, 200, 200);

      expect(signatureEditor.signatures.size).toBe(2);

      await signatureEditor.removeSignature(sig1);

      expect(signatureEditor.signatures.size).toBe(1);
      expect(signatureEditor.signatures.has(sig1.id)).toBe(false);
      expect(signatureEditor.signatures.has(sig2.id)).toBe(true);
      expect(signatureEditor.signatures.get(sig2.id).pageIndex).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    test('should handle removing signature with only id property', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      // Create minimal signature object with only id
      const minimalSignature = { id: signature.id };

      await signatureEditor.removeSignature(minimalSignature);

      expect(signatureEditor.signatures.size).toBe(0);
    });

    test('should handle empty signatures map', async () => {
      expect(signatureEditor.signatures.size).toBe(0);

      const nonExistentSignature = {
        id: 'does-not-exist',
        pageIndex: 0,
        type: 'image'
      };

      // Should not throw
      await expect(
        signatureEditor.removeSignature(nonExistentSignature)
      ).resolves.not.toThrow();
    });

    test('should handle signature with extra properties', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      // Add extra properties
      signature.extraProp1 = 'value1';
      signature.extraProp2 = 123;

      await signatureEditor.removeSignature(signature);

      expect(signatureEditor.signatures.size).toBe(0);
    });
  });

  describe('Requirements Validation', () => {
    test('should satisfy Requirement 5.2 - remove signature from PDF document', async () => {
      // Requirement 5.2: WHEN a user requests deletion of a selected signature, 
      // THE PDF_Editor SHALL remove the Signature from the PDF_Document
      
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      expect(signatureEditor.signatures.has(signature.id)).toBe(true);

      await signatureEditor.removeSignature(signature);

      // Signature should be removed from internal map
      expect(signatureEditor.signatures.has(signature.id)).toBe(false);
    });

    test('should satisfy Requirement 5.4 - update PDF document to reflect deletion', async () => {
      // Requirement 5.4: WHEN a Signature is removed, 
      // THE PDF_Editor SHALL update the PDF_Document to reflect the deletion
      
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      const initialSize = signatureEditor.signatures.size;
      expect(initialSize).toBe(1);

      await signatureEditor.removeSignature(signature);

      // Document state should be updated (signature removed from map)
      expect(signatureEditor.signatures.size).toBe(0);
      expect(signatureEditor.signatures.size).toBeLessThan(initialSize);
    });
  });
});

describe('SignatureEditor - findSignatureAt()', () => {
  let pdfDoc;
  let signatureEditor;

  // Helper to create a minimal valid PNG
  const createPngData = () => {
    return new Uint8Array([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F,
      0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59,
      0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
      0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
  };

  beforeEach(async () => {
    pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]); // A4 size
    signatureEditor = new SignatureEditor(pdfDoc);
  });

  describe('Input Validation', () => {
    test('should throw error for invalid page index', () => {
      expect(() => signatureEditor.findSignatureAt(-1, 100, 100)).toThrow(PDFEditorError);
      expect(() => signatureEditor.findSignatureAt(10, 100, 100)).toThrow('Invalid page index');
    });

    test('should throw error with correct details for invalid page index', () => {
      try {
        signatureEditor.findSignatureAt(5, 100, 100);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(PDFEditorError);
        expect(error.code).toBe(ErrorCodes.INVALID_COORDINATES);
        expect(error.details.pageIndex).toBe(5);
        expect(error.details.pageCount).toBe(1);
      }
    });
  });

  describe('Finding Signatures', () => {
    test('should return null when no signatures exist', () => {
      const result = signatureEditor.findSignatureAt(0, 100, 100);
      expect(result).toBeNull();
    });

    test('should find signature at exact coordinates', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        width: 150,
        height: 75
      });

      const found = signatureEditor.findSignatureAt(0, 100, 200);
      expect(found).toBe(signature);
    });

    test('should find signature within its bounds', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        width: 150,
        height: 75
      });

      // Test center of signature
      const found1 = signatureEditor.findSignatureAt(0, 175, 237);
      expect(found1).toBe(signature);

      // Test near top-left corner
      const found2 = signatureEditor.findSignatureAt(0, 105, 205);
      expect(found2).toBe(signature);

      // Test near bottom-right corner
      const found3 = signatureEditor.findSignatureAt(0, 245, 270);
      expect(found3).toBe(signature);
    });

    test('should return null when coordinates are outside signature bounds', async () => {
      const pngData = createPngData();
      await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        width: 150,
        height: 75
      });

      // Just outside left edge
      expect(signatureEditor.findSignatureAt(0, 99, 237)).toBeNull();

      // Just outside right edge
      expect(signatureEditor.findSignatureAt(0, 251, 237)).toBeNull();

      // Just outside bottom edge
      expect(signatureEditor.findSignatureAt(0, 175, 199)).toBeNull();

      // Just outside top edge
      expect(signatureEditor.findSignatureAt(0, 175, 276)).toBeNull();
    });

    test('should find signature at boundary coordinates', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        width: 150,
        height: 75
      });

      // Test all four corners
      expect(signatureEditor.findSignatureAt(0, 100, 200)).toBe(signature); // Bottom-left
      expect(signatureEditor.findSignatureAt(0, 250, 200)).toBe(signature); // Bottom-right
      expect(signatureEditor.findSignatureAt(0, 100, 275)).toBe(signature); // Top-left
      expect(signatureEditor.findSignatureAt(0, 250, 275)).toBe(signature); // Top-right
    });

    test('should not find removed signatures', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        width: 150,
        height: 75
      });

      // Should find before removal
      expect(signatureEditor.findSignatureAt(0, 175, 237)).toBe(signature);

      // Remove signature
      await signatureEditor.removeSignature(signature);

      // Should not find after removal
      expect(signatureEditor.findSignatureAt(0, 175, 237)).toBeNull();
    });
  });

  describe('Multiple Signatures', () => {
    test('should find correct signature when multiple exist on same page', async () => {
      const pngData = createPngData();
      
      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100, {
        width: 100,
        height: 50
      });
      
      const sig2 = await signatureEditor.addImageSignature(0, pngData, 300, 300, {
        width: 100,
        height: 50
      });

      // Find first signature
      expect(signatureEditor.findSignatureAt(0, 150, 125)).toBe(sig1);

      // Find second signature
      expect(signatureEditor.findSignatureAt(0, 350, 325)).toBe(sig2);

      // Find nothing in between
      expect(signatureEditor.findSignatureAt(0, 250, 250)).toBeNull();
    });

    test('should return topmost signature when signatures overlap', async () => {
      const pngData = createPngData();
      
      // Add first signature
      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100, {
        width: 200,
        height: 100
      });
      
      // Add overlapping signature (drawn later, so on top)
      const sig2 = await signatureEditor.addImageSignature(0, pngData, 150, 120, {
        width: 200,
        height: 100
      });

      // In overlap area, should find the topmost (most recently added)
      const found = signatureEditor.findSignatureAt(0, 200, 150);
      expect(found).toBe(sig2);
    });

    test('should only find signatures on the specified page', async () => {
      pdfDoc.addPage([595, 842]); // Add second page
      const pngData = createPngData();
      
      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100, {
        width: 100,
        height: 50
      });
      
      const sig2 = await signatureEditor.addImageSignature(1, pngData, 100, 100, {
        width: 100,
        height: 50
      });

      // Find on page 0
      expect(signatureEditor.findSignatureAt(0, 150, 125)).toBe(sig1);

      // Find on page 1
      expect(signatureEditor.findSignatureAt(1, 150, 125)).toBe(sig2);

      // Should not find page 1 signature when searching page 0
      expect(signatureEditor.findSignatureAt(0, 150, 125)).not.toBe(sig2);
    });
  });

  describe('Different Signature Types', () => {
    test('should find image signatures', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        width: 150,
        height: 75
      });

      const found = signatureEditor.findSignatureAt(0, 175, 237);
      expect(found).toBe(signature);
      expect(found.type).toBe('image');
    });

    test('should find drawn signatures', async () => {
      const pathData = {
        commands: [
          { type: 'moveTo', x: 0, y: 0 },
          { type: 'lineTo', x: 100, y: 50 }
        ]
      };
      
      const signature = await signatureEditor.addDrawnSignature(0, pathData, 100, 200, {
        width: 150,
        height: 75
      });

      const found = signatureEditor.findSignatureAt(0, 175, 237);
      expect(found).toBe(signature);
      expect(found.type).toBe('drawn');
    });

    test('should find typed signatures', async () => {
      const signature = await signatureEditor.addTypedSignature(0, 'John Doe', 100, 200, {
        width: 150,
        height: 30
      });

      const found = signatureEditor.findSignatureAt(0, 175, 215);
      expect(found).toBe(signature);
      expect(found.type).toBe('typed');
    });
  });

  describe('Requirements Validation', () => {
    test('should satisfy Requirement 5.1 - highlight selected signature', async () => {
      // Requirement 5.1: WHEN a user selects a Signature, 
      // THE PDF_Editor SHALL highlight the selected signature
      
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200, {
        width: 150,
        height: 75
      });

      // User clicks at coordinates within signature bounds
      const selected = signatureEditor.findSignatureAt(0, 175, 237);

      // Should find the signature for highlighting
      expect(selected).toBe(signature);
      expect(selected).not.toBeNull();
      expect(selected.id).toBe(signature.id);
    });
  });
});

describe('SignatureEditor - getSignatures()', () => {
  let pdfDoc;
  let signatureEditor;

  // Helper to create a minimal valid PNG
  const createPngData = () => {
    return new Uint8Array([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F,
      0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59,
      0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
      0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
  };

  beforeEach(async () => {
    pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]); // A4 size
    signatureEditor = new SignatureEditor(pdfDoc);
  });

  describe('Input Validation', () => {
    test('should throw error for invalid page index', () => {
      expect(() => signatureEditor.getSignatures(-1)).toThrow(PDFEditorError);
      expect(() => signatureEditor.getSignatures(10)).toThrow('Invalid page index');
    });

    test('should throw error with correct details for invalid page index', () => {
      try {
        signatureEditor.getSignatures(5);
        fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(PDFEditorError);
        expect(error.code).toBe(ErrorCodes.INVALID_COORDINATES);
        expect(error.details.pageIndex).toBe(5);
        expect(error.details.pageCount).toBe(1);
      }
    });
  });

  describe('Getting Signatures', () => {
    test('should return empty array when no signatures exist', () => {
      const signatures = signatureEditor.getSignatures(0);
      expect(signatures).toEqual([]);
      expect(signatures).toHaveLength(0);
    });

    test('should return single signature on page', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 200);

      const signatures = signatureEditor.getSignatures(0);
      expect(signatures).toHaveLength(1);
      expect(signatures[0]).toBe(signature);
    });

    test('should return all signatures on page', async () => {
      const pngData = createPngData();
      
      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const sig2 = await signatureEditor.addImageSignature(0, pngData, 200, 200);
      const sig3 = await signatureEditor.addImageSignature(0, pngData, 300, 300);

      const signatures = signatureEditor.getSignatures(0);
      expect(signatures).toHaveLength(3);
      expect(signatures).toContain(sig1);
      expect(signatures).toContain(sig2);
      expect(signatures).toContain(sig3);
    });

    test('should only return signatures from specified page', async () => {
      pdfDoc.addPage([595, 842]); // Add second page
      const pngData = createPngData();
      
      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const sig2 = await signatureEditor.addImageSignature(0, pngData, 200, 200);
      const sig3 = await signatureEditor.addImageSignature(1, pngData, 100, 100);
      const sig4 = await signatureEditor.addImageSignature(1, pngData, 200, 200);

      const page0Signatures = signatureEditor.getSignatures(0);
      expect(page0Signatures).toHaveLength(2);
      expect(page0Signatures).toContain(sig1);
      expect(page0Signatures).toContain(sig2);
      expect(page0Signatures).not.toContain(sig3);
      expect(page0Signatures).not.toContain(sig4);

      const page1Signatures = signatureEditor.getSignatures(1);
      expect(page1Signatures).toHaveLength(2);
      expect(page1Signatures).toContain(sig3);
      expect(page1Signatures).toContain(sig4);
      expect(page1Signatures).not.toContain(sig1);
      expect(page1Signatures).not.toContain(sig2);
    });

    test('should not include removed signatures', async () => {
      const pngData = createPngData();
      
      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const sig2 = await signatureEditor.addImageSignature(0, pngData, 200, 200);
      const sig3 = await signatureEditor.addImageSignature(0, pngData, 300, 300);

      // Before removal
      expect(signatureEditor.getSignatures(0)).toHaveLength(3);

      // Remove one signature
      await signatureEditor.removeSignature(sig2);

      // After removal
      const signatures = signatureEditor.getSignatures(0);
      expect(signatures).toHaveLength(2);
      expect(signatures).toContain(sig1);
      expect(signatures).not.toContain(sig2);
      expect(signatures).toContain(sig3);
    });

    test('should return empty array after all signatures removed', async () => {
      const pngData = createPngData();
      
      const sig1 = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const sig2 = await signatureEditor.addImageSignature(0, pngData, 200, 200);

      expect(signatureEditor.getSignatures(0)).toHaveLength(2);

      await signatureEditor.removeSignature(sig1);
      await signatureEditor.removeSignature(sig2);

      expect(signatureEditor.getSignatures(0)).toHaveLength(0);
      expect(signatureEditor.getSignatures(0)).toEqual([]);
    });
  });

  describe('Different Signature Types', () => {
    test('should return all signature types', async () => {
      const pngData = createPngData();
      const pathData = {
        commands: [
          { type: 'moveTo', x: 0, y: 0 },
          { type: 'lineTo', x: 100, y: 50 }
        ]
      };
      
      const imageSig = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const drawnSig = await signatureEditor.addDrawnSignature(0, pathData, 200, 200);
      const typedSig = await signatureEditor.addTypedSignature(0, 'John Doe', 300, 300);

      const signatures = signatureEditor.getSignatures(0);
      expect(signatures).toHaveLength(3);
      expect(signatures).toContain(imageSig);
      expect(signatures).toContain(drawnSig);
      expect(signatures).toContain(typedSig);

      // Verify types
      const types = signatures.map(sig => sig.type);
      expect(types).toContain('image');
      expect(types).toContain('drawn');
      expect(types).toContain('typed');
    });
  });

  describe('Multiple Pages', () => {
    test('should handle multiple pages correctly', async () => {
      pdfDoc.addPage([595, 842]); // Page 1
      pdfDoc.addPage([595, 842]); // Page 2
      const pngData = createPngData();
      
      const sig0 = await signatureEditor.addImageSignature(0, pngData, 100, 100);
      const sig1a = await signatureEditor.addImageSignature(1, pngData, 100, 100);
      const sig1b = await signatureEditor.addImageSignature(1, pngData, 200, 200);
      const sig2 = await signatureEditor.addImageSignature(2, pngData, 100, 100);

      expect(signatureEditor.getSignatures(0)).toHaveLength(1);
      expect(signatureEditor.getSignatures(1)).toHaveLength(2);
      expect(signatureEditor.getSignatures(2)).toHaveLength(1);

      expect(signatureEditor.getSignatures(0)[0]).toBe(sig0);
      expect(signatureEditor.getSignatures(1)).toContain(sig1a);
      expect(signatureEditor.getSignatures(1)).toContain(sig1b);
      expect(signatureEditor.getSignatures(2)[0]).toBe(sig2);
    });
  });

  describe('Return Value Properties', () => {
    test('should return a new array (not internal reference)', async () => {
      const pngData = createPngData();
      await signatureEditor.addImageSignature(0, pngData, 100, 100);

      const signatures1 = signatureEditor.getSignatures(0);
      const signatures2 = signatureEditor.getSignatures(0);

      // Should be different array instances
      expect(signatures1).not.toBe(signatures2);
      
      // But contain the same signature objects
      expect(signatures1[0]).toBe(signatures2[0]);
    });

    test('should return array that can be modified without affecting internal state', async () => {
      const pngData = createPngData();
      const signature = await signatureEditor.addImageSignature(0, pngData, 100, 100);

      const signatures = signatureEditor.getSignatures(0);
      expect(signatures).toHaveLength(1);

      // Modify returned array
      signatures.push({ id: 'fake', type: 'fake' });
      signatures[0] = null;

      // Internal state should be unchanged
      const signaturesAgain = signatureEditor.getSignatures(0);
      expect(signaturesAgain).toHaveLength(1);
      expect(signaturesAgain[0]).toBe(signature);
    });
  });

  describe('Requirements Validation', () => {
    test('should satisfy Requirement 5.1 - get all signatures for selection', async () => {
      // Requirement 5.1: WHEN a user selects a Signature, 
      // THE PDF_Editor SHALL highlight the selected signature
      // (getSignatures enables UI to display all signatures for selection)
      
      const pngData = createPngData();
      
      await signatureEditor.addImageSignature(0, pngData, 100, 100);
      await signatureEditor.addImageSignature(0, pngData, 200, 200);
      await signatureEditor.addImageSignature(0, pngData, 300, 300);

      // Get all signatures on page for rendering/selection
      const signatures = signatureEditor.getSignatures(0);

      // Should return all signatures for UI to display
      expect(signatures).toHaveLength(3);
      signatures.forEach(sig => {
        expect(sig).toHaveProperty('id');
        expect(sig).toHaveProperty('x');
        expect(sig).toHaveProperty('y');
        expect(sig).toHaveProperty('width');
        expect(sig).toHaveProperty('height');
      });
    });
  });
});
