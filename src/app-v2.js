import { EditorController } from './core/EditorController.js';
import { PDFBackendService } from './services/pdfBackendService.js';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

class PDFEditorAppV2 {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.currentPage = 0;
    this.scale = 1.5;
    this.pdfJsDoc = null;
    this.originalFile = null;
    this.originalFileData = null;
    this.textOverlays = [];
    this.edits = new Map();
    
    this.initializeEventListeners();
    this.checkBackendHealth();
  }

  async checkBackendHealth() {
    const isHealthy = await PDFBackendService.checkHealth();
    if (isHealthy) {
      console.log('✅ Backend is running');
    } else {
      console.warn('⚠️ Backend is not running');
      this.showStatus('Warning: Backend not running', 'error');
    }
  }

  initializeEventListeners() {
    document.getElementById('fileInput').addEventListener('change', (e) => {
      this.handleFileSelect(e);
    });

    document.getElementById('editModeBtn').addEventListener('click', () => {
      this.enterEditMode();
    });

    document.getElementById('saveBtn').addEventListener('click', () => {
      this.savePDF();
    });
  }

  async handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      console.log('Loading PDF:', file.name);
      this.showStatus('Loading PDF...', 'info');
      
      this.originalFile = file;
      const arrayBuffer = await file.arrayBuffer();
      this.originalFileData = arrayBuffer.slice(0);
      
      // Load with PDF.js
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer.slice(0) });
      this.pdfJsDoc = await loadingTask.promise;
      
      console.log('PDF loaded:', this.pdfJsDoc.numPages, 'pages');
      
      this.currentPage = 0;
      await this.renderPage(this.currentPage);
      
      document.getElementById('saveBtn').disabled = false;
      document.getElementById('editModeBtn').disabled = false;
      
      this.showStatus(`PDF loaded: ${this.pdfJsDoc.numPages} page(s)`, 'success');
    } catch (error) {
      console.error('Error loading PDF:', error);
      this.showStatus(`Failed to load PDF: ${error.message}`, 'error');
    }
  }

  async renderPage(pageNumber) {
    if (!this.pdfJsDoc) return;
    
    const page = await this.pdfJsDoc.getPage(pageNumber + 1);
    const viewport = page.getViewport({ scale: this.scale });
    
    this.canvas.width = viewport.width;
    this.canvas.height = viewport.height;
    
    // Render page as image
    await page.render({
      canvasContext: this.ctx,
      viewport: viewport
    }).promise;
    
    console.log('Page rendered as image');
  }

  async enterEditMode() {
    if (!this.pdfJsDoc) return;
    
    console.log('Entering edit mode');
    this.showStatus('Loading text for editing...', 'info');
    
    try {
      // Extract text from backend
      const extractData = await PDFBackendService.extractText(this.originalFile);
      console.log('Text extracted:', extractData);
      
      // Clear existing overlays
      this.clearOverlays();
      
      // Get text for current page
      const pageData = extractData.pages.find(p => p.pageNumber === this.currentPage);
      if (!pageData || !pageData.textItems) {
        this.showStatus('No text found on this page', 'info');
        return;
      }
      
      // Create editable overlays
      this.createEditableOverlays(pageData.textItems);
      
      this.showStatus('Edit mode active - click text to edit', 'success');
    } catch (error) {
      console.error('Error entering edit mode:', error);
      this.showStatus(`Error: ${error.message}`, 'error');
    }
  }

  createEditableOverlays(textItems) {
    // Get or create canvas wrapper
    let canvasWrapper = document.getElementById('canvasWrapper');
    if (!canvasWrapper) {
      const canvasContainer = document.getElementById('canvasContainer');
      canvasWrapper = document.createElement('div');
      canvasWrapper.id = 'canvasWrapper';
      canvasWrapper.style.position = 'relative';
      canvasWrapper.style.display = 'inline-block';
      
      const canvas = this.canvas;
      canvas.parentNode.insertBefore(canvasWrapper, canvas);
      canvasWrapper.appendChild(canvas);
    }
    
    // Group text into blocks
    const blocks = this.groupTextIntoBlocks(textItems);
    console.log('Created', blocks.length, 'text blocks');
    console.log('Canvas height:', this.canvas.height, 'Scale:', this.scale);
    
    blocks.forEach((block, index) => {
      console.log(`Block ${index}:`, {
        text: block.text.substring(0, 30),
        x: block.x,
        y: block.y,
        height: block.height,
        fontSize: block.fontSize
      });
      
      const overlay = document.createElement('div');
      overlay.contentEditable = 'true';
      overlay.className = 'text-overlay';
      overlay.dataset.blockId = block.id;
      overlay.dataset.originalText = block.text;
      overlay.textContent = block.text;
      
      // Backend gives Y as the BOTTOM of text in PDF coordinates (origin bottom-left)
      // Canvas uses top-left origin
      // To get top-left position in canvas: canvas_height - (pdf_y + text_height)
      const canvasX = block.x * this.scale;
      const canvasY = this.canvas.height - ((block.y + block.height) * this.scale);
      
      console.log(`  Canvas position: x=${canvasX}, y=${canvasY}`);
      
      overlay.style.position = 'absolute';
      overlay.style.left = (canvasX - 5) + 'px';
      overlay.style.top = (canvasY - 5) + 'px';
      overlay.style.width = Math.max(block.width * this.scale + 50, 250) + 'px';
      overlay.style.minHeight = (block.height * this.scale + 10) + 'px';
      overlay.style.fontSize = (block.fontSize * this.scale) + 'px';
      overlay.style.fontFamily = this.mapFontFamily(block.fontName);
      overlay.style.color = '#000';
      overlay.style.background = 'transparent';
      overlay.style.border = '2px solid transparent';
      overlay.style.padding = '4px';
      overlay.style.lineHeight = '1.4';
      overlay.style.whiteSpace = 'pre-wrap';
      overlay.style.cursor = 'text';
      overlay.style.outline = 'none';
      overlay.style.zIndex = '100';
      overlay.style.transition = 'all 0.2s';
      
      // Focus/blur handlers
      overlay.addEventListener('focus', () => {
        overlay.style.border = '2px dotted #4A90E2';
        overlay.style.background = 'rgba(255, 255, 255, 0.95)';
      });
      
      overlay.addEventListener('blur', () => {
        overlay.style.border = '2px solid transparent';
        overlay.style.background = 'transparent';
        
        // Track edit
        const originalText = overlay.dataset.originalText;
        const newText = overlay.textContent;
        if (originalText !== newText) {
          this.edits.set(block.id, {
            blockId: block.id,
            pageIndex: this.currentPage,
            originalText: originalText,
            newText: newText,
            x: block.x,
            y: block.y,
            width: block.width,
            height: block.height,
            fontSize: block.fontSize,
            fontName: block.fontName
          });
          console.log('Edit tracked:', block.id);
        }
      });
      
      canvasWrapper.appendChild(overlay);
      this.textOverlays.push(overlay);
    });
  }

  groupTextIntoBlocks(textItems) {
    // Sort by Y position (top to bottom in PDF coordinates)
    const sorted = [...textItems].sort((a, b) => b.y - a.y);
    const blocks = [];
    let currentBlock = null;
    let blockId = 0;
    
    sorted.forEach(item => {
      const shouldStartNew = !currentBlock || 
        Math.abs(item.y - currentBlock.y) > 15 ||
        blocks.length >= 20; // Limit total blocks
      
      if (shouldStartNew) {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = {
          id: `block-${this.currentPage}-${blockId++}`,
          text: item.text,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          fontSize: item.fontSize,
          fontName: item.fontName
        };
      } else {
        // Add to current block
        currentBlock.text += '\n' + item.text;
        currentBlock.width = Math.max(currentBlock.width, item.x + item.width - currentBlock.x);
        const newBottom = item.y - item.height;
        const currentBottom = currentBlock.y - currentBlock.height;
        currentBlock.height = currentBlock.y - Math.min(newBottom, currentBottom);
      }
    });
    
    if (currentBlock) blocks.push(currentBlock);
    return blocks;
  }

  mapFontFamily(fontName) {
    if (!fontName) return 'Arial, sans-serif';
    const lower = fontName.toLowerCase();
    if (lower.includes('times') || lower.includes('serif')) {
      return '"Times New Roman", Times, serif';
    } else if (lower.includes('courier') || lower.includes('mono')) {
      return '"Courier New", Courier, monospace';
    }
    return 'Arial, Helvetica, sans-serif';
  }

  clearOverlays() {
    this.textOverlays.forEach(overlay => overlay.remove());
    this.textOverlays = [];
  }

  async savePDF() {
    if (!this.originalFileData) {
      this.showStatus('No PDF loaded', 'error');
      return;
    }

    try {
      this.showStatus('Saving PDF...', 'info');
      
      const editsArray = Array.from(this.edits.values());
      console.log('Saving with', editsArray.length, 'edits');
      
      if (editsArray.length === 0) {
        this.showStatus('No changes to save', 'info');
        return;
      }
      
      // Use reconstruct endpoint
      const response = await fetch('http://localhost:5000/reconstruct-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pdfBase64: btoa(String.fromCharCode(...new Uint8Array(this.originalFileData))),
          edits: editsArray
        })
      });
      
      const result = await response.json();
      
      if (!result.success) {
        throw new Error(result.error || 'Save failed');
      }
      
      // Download
      const pdfBytes = Uint8Array.from(atob(result.pdfBase64), c => c.charCodeAt(0));
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'edited-document.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.showStatus('PDF saved successfully!', 'success');
      this.edits.clear();
    } catch (error) {
      console.error('Save error:', error);
      this.showStatus(`Failed to save: ${error.message}`, 'error');
    }
  }

  showStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = type;
    
    if (type === 'success' || type === 'info') {
      setTimeout(() => {
        status.style.display = 'none';
      }, 5000);
    }
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  new PDFEditorAppV2();
});
