import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EditorController } from '../src/core/EditorController.js';
import { PDFDocument } from 'pdf-lib';
import { PDFEditorError, ErrorCodes } from '../src/errors/PDFEditorError.js';

describe('EditorController', () => {
  let controller;

  beforeEach(() => {
    controller = new EditorController();
  });

  describe('Initialization', () => {
    it('should initialize with default state', () => {
      expect(controller.documentManager).toBeDefined();
      expect(controller.textEditor).toBeNull();
      expect(controller.signatureEditor).toBeNull();
      expect(controller.history).toEqual([]);
      expect(controller.currentHistoryIndex).toBe(-1);
      expect(controller.isLoaded).toBe(false);
    });

    it('should initialize event listeners map', () => {
      expect(controller.eventListeners).toBeInstanceOf(Map);
      expect(controller.eventListeners.size).toBe(0);
    });

    it('should initialize selection state', () => {
      expect(controller.selectedElement).toBeNull();
      expect(controller.selectedElementType).toBeNull();
    });
  });

  describe('loadPDF', () => {
    it('should load PDF from ArrayBuffer and initialize editors', async () => {
      // Create a minimal PDF
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage();
      const pdfBytes = await pdfDoc.save();

      await controller.loadPDF(pdfBytes.buffer);

      expect(controller.isLoaded).toBe(true);
      expect(controller.textEditor).toBeDefined();
      expect(controller.signatureEditor).toBeDefined();
    });

    it('should emit loaded event after successful load', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage();
      const pdfBytes = await pdfDoc.save();

      const loadedHandler = jest.fn();
      controller.on('loaded', loadedHandler);

      await controller.loadPDF(pdfBytes.buffer);

      expect(loadedHandler).toHaveBeenCalledWith({ pageCount: 1 });
    });

    it('should reset state when loading new PDF', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage();
      const pdfBytes = await pdfDoc.save();

      // Set some state
      controller.history = [{ type: 'addText' }];
      controller.currentHistoryIndex = 0;
      controller.selectedElement = { id: 'test' };

      await controller.loadPDF(pdfBytes.buffer);

      expect(controller.history).toEqual([]);
      expect(controller.currentHistoryIndex).toBe(-1);
      expect(controller.selectedElement).toBeNull();
    });

    it('should emit error event on invalid PDF', async () => {
      const errorHandler = jest.fn();
      controller.on('error', errorHandler);

      const invalidBuffer = new ArrayBuffer(10);

      await expect(controller.loadPDF(invalidBuffer)).rejects.toThrow();
      expect(errorHandler).toHaveBeenCalled();
      expect(controller.isLoaded).toBe(false);
    });

    it('should throw error for invalid source type', async () => {
      await expect(controller.loadPDF(123)).rejects.toThrow(PDFEditorError);
      await expect(controller.loadPDF(123)).rejects.toThrow('Invalid source type');
    });
  });

  describe('getTextEditor', () => {
    it('should return TextEditor after PDF is loaded', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage();
      const pdfBytes = await pdfDoc.save();

      await controller.loadPDF(pdfBytes.buffer);

      const textEditor = controller.getTextEditor();
      expect(textEditor).toBeDefined();
      expect(textEditor.constructor.name).toBe('TextEditor');
    });

    it('should throw error if no PDF is loaded', () => {
      expect(() => controller.getTextEditor()).toThrow(PDFEditorError);
      expect(() => controller.getTextEditor()).toThrow('No PDF document loaded');
    });
  });

  describe('getSignatureEditor', () => {
    it('should return SignatureEditor after PDF is loaded', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage();
      const pdfBytes = await pdfDoc.save();

      await controller.loadPDF(pdfBytes.buffer);

      const signatureEditor = controller.getSignatureEditor();
      expect(signatureEditor).toBeDefined();
      expect(signatureEditor.constructor.name).toBe('SignatureEditor');
    });

    it('should throw error if no PDF is loaded', () => {
      expect(() => controller.getSignatureEditor()).toThrow(PDFEditorError);
      expect(() => controller.getSignatureEditor()).toThrow('No PDF document loaded');
    });
  });

  describe('getDocumentManager', () => {
    it('should always return PDFDocumentManager', () => {
      const docManager = controller.getDocumentManager();
      expect(docManager).toBeDefined();
      expect(docManager.constructor.name).toBe('PDFDocumentManager');
    });
  });

  describe('Undo/Redo', () => {
    it('should return false for canUndo when no history', () => {
      expect(controller.canUndo()).toBe(false);
    });

    it('should return false for canRedo when no history', () => {
      expect(controller.canRedo()).toBe(false);
    });

    it('should return true for canUndo after adding to history', () => {
      controller.history = [{ type: 'addText', data: {}, inverse: {} }];
      controller.currentHistoryIndex = 0;

      expect(controller.canUndo()).toBe(true);
    });

    it('should return true for canRedo after undo', () => {
      controller.history = [{ type: 'addText', data: {}, inverse: {} }];
      controller.currentHistoryIndex = 0;

      controller.currentHistoryIndex = -1; // Simulate undo

      expect(controller.canRedo()).toBe(true);
    });

    it('should do nothing when undo is called with no history', async () => {
      await controller.undo();
      expect(controller.currentHistoryIndex).toBe(-1);
    });

    it('should do nothing when redo is called with no future history', async () => {
      await controller.redo();
      expect(controller.currentHistoryIndex).toBe(-1);
    });
  });

  describe('Selection Management', () => {
    it('should select an element', () => {
      const element = { id: 'text-1', text: 'Hello' };
      controller.selectElement(element, 'text');

      expect(controller.selectedElement).toBe(element);
      expect(controller.selectedElementType).toBe('text');
    });

    it('should emit selectionChanged event when selecting', () => {
      const handler = jest.fn();
      controller.on('selectionChanged', handler);

      const element = { id: 'text-1' };
      controller.selectElement(element, 'text');

      expect(handler).toHaveBeenCalledWith({
        element,
        type: 'text',
        previousElement: null,
        previousType: null
      });
    });

    it('should deselect element', () => {
      const element = { id: 'text-1' };
      controller.selectElement(element, 'text');
      controller.deselectElement();

      expect(controller.selectedElement).toBeNull();
      expect(controller.selectedElementType).toBeNull();
    });

    it('should return selected element', () => {
      const element = { id: 'sig-1' };
      controller.selectElement(element, 'signature');

      const selected = controller.getSelectedElement();
      expect(selected.element).toBe(element);
      expect(selected.type).toBe('signature');
    });
  });

  describe('Event Management', () => {
    it('should register event listener', () => {
      const handler = jest.fn();
      controller.on('loaded', handler);

      expect(controller.eventListeners.has('loaded')).toBe(true);
      expect(controller.eventListeners.get('loaded')).toContain(handler);
    });

    it('should throw error for non-function handler', () => {
      expect(() => controller.on('loaded', 'not a function')).toThrow(PDFEditorError);
    });

    it('should unregister event listener', () => {
      const handler = jest.fn();
      controller.on('loaded', handler);
      controller.off('loaded', handler);

      expect(controller.eventListeners.has('loaded')).toBe(false);
    });

    it('should handle multiple listeners for same event', () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      controller.on('loaded', handler1);
      controller.on('loaded', handler2);

      controller._emit('loaded', { test: true });

      expect(handler1).toHaveBeenCalledWith({ test: true });
      expect(handler2).toHaveBeenCalledWith({ test: true });
    });

    it('should not throw when removing non-existent listener', () => {
      const handler = jest.fn();
      expect(() => controller.off('nonexistent', handler)).not.toThrow();
    });

    it('should handle errors in event handlers gracefully', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const throwingHandler = jest.fn(() => {
        throw new Error('Handler error');
      });

      controller.on('test', throwingHandler);
      controller._emit('test', {});

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Save Operations', () => {
    it('should throw error when saving without loaded PDF', async () => {
      await expect(controller.save()).rejects.toThrow(PDFEditorError);
      await expect(controller.save()).rejects.toThrow('No PDF document loaded');
    });

    it('should save PDF and emit saved event', async () => {
      const pdfDoc = await PDFDocument.create();
      pdfDoc.addPage();
      const pdfBytes = await pdfDoc.save();

      await controller.loadPDF(pdfBytes.buffer);

      const savedHandler = jest.fn();
      controller.on('saved', savedHandler);

      const result = await controller.save();

      expect(result).toBeInstanceOf(Uint8Array);
      expect(savedHandler).toHaveBeenCalled();
      expect(savedHandler.mock.calls[0][0]).toHaveProperty('size');
    });

    it('should throw error when saveAs without loaded PDF', async () => {
      await expect(controller.saveAs('test.pdf')).rejects.toThrow(PDFEditorError);
    });
  });
});
