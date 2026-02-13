import { EditorController } from './core/EditorController.js';
import { PDFBackendService } from './services/pdfBackendService.js';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

class PDFEditorApp {
  constructor() {
    this.controller = new EditorController();
    this.canvas = document.getElementById('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.currentPage = 0;
    this.mode = null; // 'text', 'signature', or 'edit'
    this.pageWidth = 612; // Standard US Letter width in points
    this.pageHeight = 792; // Standard US Letter height in points
    this.scale = 1.5; // Increased for better visibility
    this.pdfJsDoc = null; // PDF.js document for rendering
    this.originalFileData = null; // Store original file data
    this.originalFile = null; // Store original File object for backend
    this.extractedTextItems = []; // Store extracted text items with positions (from PyMuPDF backend)
    this.editableTextBoxes = []; // Array of editable text box overlays
    this.activeEditBox = null; // Currently active edit box
    this.edits = []; // Track all edits for backend processing
    this.isRendering = false; // Prevent multiple simultaneous renders
    this.isCreatingTextBoxes = false; // Prevent duplicate text box creation
    this.eventListenersInitialized = false; // Prevent duplicate event listeners
    
    this.initializeEventListeners();
    this.setupControllerEvents();
    
    console.log('PDF Editor App initialized');
    
    // Check backend health
    this.checkBackendHealth();
  }

  async checkBackendHealth() {
    const isHealthy = await PDFBackendService.checkHealth();
    if (isHealthy) {
      console.log('✅ Backend is running');
    } else {
      console.warn('⚠️ Backend is not running. Please start it with: cd backend && ./start.sh');
      this.showStatus('Warning: Backend not running. Text editing may not work properly.', 'error');
    }
  }

  initializeEventListeners() {
    if (this.eventListenersInitialized) {
      console.warn('Event listeners already initialized, skipping');
      return;
    }
    
    console.log('Initializing event listeners');
    this.eventListenersInitialized = true;
    
    // File input
    document.getElementById('fileInput').addEventListener('change', (e) => {
      this.handleFileSelect(e);
    });

    // Mode buttons
    document.getElementById('textModeBtn').addEventListener('click', () => {
      console.log('Edit Text button clicked');
      this.setMode('text');
    });

    document.getElementById('editModeBtn').addEventListener('click', () => {
      console.log('Edit Text button clicked');
      this.setMode('edit');
    });

    document.getElementById('signatureModeBtn').addEventListener('click', () => {
      console.log('Signature button clicked');
      this.setMode('signature');
    });

    // Clear signature button
    document.getElementById('clearSignatureBtn').addEventListener('click', () => {
      this.clearSignature();
    });

    // Save button
    document.getElementById('saveBtn').addEventListener('click', () => {
      this.savePDF();
    });

    // Page navigation
    document.getElementById('prevPageBtn')?.addEventListener('click', () => {
      this.previousPage();
    });

    document.getElementById('nextPageBtn')?.addEventListener('click', () => {
      this.nextPage();
    });

    // Canvas click
    this.canvas.addEventListener('click', (e) => {
      this.handleCanvasClick(e);
    });
    
    // Setup canvas wrapper for text box overlays
    const canvasContainer = document.getElementById('canvasContainer');
    canvasContainer.style.position = 'relative';
    
    const canvasWrapper = document.createElement('div');
    canvasWrapper.id = 'canvasWrapper';
    canvasWrapper.style.position = 'relative';
    canvasWrapper.style.display = 'inline-block';
    
    const canvas = this.canvas;
    canvas.parentNode.insertBefore(canvasWrapper, canvas);
    canvasWrapper.appendChild(canvas);
  }

  previousPage() {
    if (this.currentPage > 0) {
      this.clearEditableTextBoxes();
      this.currentPage--;
      this.renderCurrentPage();
      this.updatePageInfo();
    }
  }

  nextPage() {
    if (this.pdfJsDoc && this.currentPage < this.pdfJsDoc.numPages - 1) {
      this.clearEditableTextBoxes();
      this.currentPage++;
      this.renderCurrentPage();
      this.updatePageInfo();
    }
  }

  updatePageInfo() {
    const pageInfo = document.getElementById('pageInfo');
    if (pageInfo && this.pdfJsDoc) {
      pageInfo.textContent = `Page ${this.currentPage + 1} of ${this.pdfJsDoc.numPages}`;
    }
  }

  setupControllerEvents() {
    this.controller.on('loaded', (data) => {
      console.log('PDF loaded event received:', data);
      this.showStatus(`PDF loaded successfully! ${data.pageCount} page(s)`, 'success');
      this.updatePageInfo();
      document.getElementById('saveBtn').disabled = false;
      document.getElementById('textInput').disabled = false;
      document.getElementById('signatureInput').disabled = false;
      document.getElementById('prevPageBtn').disabled = false;
      document.getElementById('nextPageBtn').disabled = false;
      document.getElementById('editModeBtn').disabled = false;
      this.updateModeIndicator();
      
      // Don't auto-select edit mode - let user choose
      console.log('PDF loaded, waiting for user to select mode');
    });

    this.controller.on('saved', () => {
      this.showStatus('PDF saved successfully!', 'success');
    });

    this.controller.on('error', (data) => {
      // Only show error if we don't have a fallback (PDF.js loaded)
      if (!this.pdfJsDoc) {
        console.error('Controller error:', data);
        this.showStatus(`Error: ${data.message}`, 'error');
      } else {
        // We have PDF.js as fallback, just log the error
        console.warn('Controller error (using fallback):', data);
      }
    });
  }

  /**
   * Extract text using PDF.js as fallback
   */
  async extractTextFromPDFjs() {
    console.log('Extracting text from all pages using PDF.js...');
    this.extractedTextItems = [];
    
    for (let pageNum = 0; pageNum < this.pdfJsDoc.numPages; pageNum++) {
      const page = await this.pdfJsDoc.getPage(pageNum + 1);
      const viewport = page.getViewport({ scale: this.scale });
      const textContent = await page.getTextContent();
      
      textContent.items
        .filter(item => item.str && item.str.trim().length > 0)
        .forEach(item => {
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          
          const x = tx[4] / this.scale;
          const y = (viewport.height - tx[5]) / this.scale;
          const scaleX = tx[0];
          const scaleY = tx[3];
          const width = item.width;
          const height = item.height;
          const fontSize = Math.sqrt(scaleX * scaleX + scaleY * scaleY);
          const fontName = item.fontName || 'Helvetica';
          
          this.extractedTextItems.push({
            text: item.str,
            x: x,
            y: y,
            width: width,
            height: height,
            fontSize: fontSize,
            fontName: fontName,
            pageIndex: pageNum
          });
        });
    }
    
    console.log('PDF.js extracted', this.extractedTextItems.length, 'text items from all pages');
  }

  async handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      console.log('File selected:', file.name);
      this.showStatus('Loading PDF...', 'info');
      
      // Store original file
      this.originalFile = file;
      
      // Read file as ArrayBuffer and clone it to prevent detachment
      const arrayBuffer = await file.arrayBuffer();
      this.originalFileData = arrayBuffer.slice(0); // Clone the ArrayBuffer
      
      // Load into PDF.js for rendering
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }); // Clone for PDF.js
      this.pdfJsDoc = await loadingTask.promise;
      console.log('PDF.js loaded PDF');
      
      // Try to load into controller (pdf-lib) for editing - but don't fail if it doesn't work
      try {
        await this.controller.loadPDF(file);
        console.log('Controller loaded PDF');
      } catch (controllerError) {
        console.warn('pdf-lib failed to load PDF, but we can still view and edit:', controllerError);
        // Mark as loaded anyway so we can use text editing
        this.controller.isLoaded = true;
        // Don't show error - backend editing will work fine
        console.log('Using backend-only mode for this PDF');
        
        // Manually enable buttons since controller won't emit 'loaded' event
        document.getElementById('saveBtn').disabled = false;
        document.getElementById('textInput').disabled = false;
        document.getElementById('signatureInput').disabled = false;
        document.getElementById('prevPageBtn').disabled = false;
        document.getElementById('nextPageBtn').disabled = false;
        document.getElementById('editModeBtn').disabled = false;
        this.showStatus(`PDF loaded successfully! ${this.pdfJsDoc.numPages} page(s)`, 'success');
      }
      
      // Extract text from backend (PyMuPDF) for accurate font information
      try {
        console.log('Extracting text from backend...');
        const extractData = await PDFBackendService.extractText(file);
        console.log('Backend extracted text:', extractData);
        
        // Store all text items from all pages
        this.extractedTextItems = [];
        if (extractData.pages) {
          extractData.pages.forEach(page => {
            page.textItems.forEach(item => {
              this.extractedTextItems.push({
                ...item,
                pageIndex: page.pageNumber
              });
            });
          });
        }
        console.log('Total text items extracted from backend:', this.extractedTextItems.length);
        
        // If no text items, fall back to PDF.js extraction
        if (this.extractedTextItems.length === 0) {
          console.warn('Backend returned no text items, falling back to PDF.js extraction');
          await this.extractTextFromPDFjs();
        }
      } catch (backendError) {
        console.error('Backend text extraction failed:', backendError);
        this.showStatus('Backend unavailable, using fallback text extraction', 'info');
        // Fall back to PDF.js extraction
        await this.extractTextFromPDFjs();
      }
      
      this.currentPage = 0;
      await this.renderCurrentPage();
      
    } catch (error) {
      console.error('Error loading PDF:', error);
      
      // Provide more specific error messages
      let errorMessage = 'Failed to load PDF';
      if (error.message.includes('Invalid') || error.message.includes('corrupted')) {
        errorMessage = 'This PDF file appears to be corrupted or in an unsupported format';
      } else if (error.message.includes('password') || error.message.includes('encrypted')) {
        errorMessage = 'This PDF is password-protected. Please use an unencrypted PDF';
      } else {
        errorMessage = `Failed to load PDF: ${error.message}`;
      }
      
      this.showStatus(errorMessage, 'error');
    }
  }

  async renderCurrentPage() {
    console.log('renderCurrentPage called, isRendering:', this.isRendering);
    
    if (!this.controller.isLoaded || !this.pdfJsDoc) {
      console.log('No PDF loaded yet');
      return;
    }
    
    if (this.isRendering) {
      console.log('Already rendering, skipping...');
      return;
    }
    
    this.isRendering = true;
    console.log('Starting render, set isRendering = true');
    
    // Clear text boxes before rendering
    this.clearEditableTextBoxes();

    try {
      console.log('Rendering page', this.currentPage + 1);
      
      // Get the page from PDF.js
      const page = await this.pdfJsDoc.getPage(this.currentPage + 1); // PDF.js uses 1-based indexing
      const viewport = page.getViewport({ scale: this.scale });
      
      // Set canvas size to match PDF page
      this.canvas.width = viewport.width;
      this.canvas.height = viewport.height;
      this.pageWidth = page.view[2]; // Original page width
      this.pageHeight = page.view[3]; // Original page height

      console.log('Canvas size:', this.canvas.width, 'x', this.canvas.height);

      // Render the PDF page
      // Note: PDF.js renders everything (text, images, graphics) onto the canvas
      // We can't selectively hide text, so in edit mode our editable divs will overlay it
      const renderContext = {
        canvasContext: this.ctx,
        viewport: viewport
      };
      
      await page.render(renderContext).promise;
      console.log('PDF page rendered');
      
      // In edit mode, show editable text boxes overlaid on the PDF
      if (this.mode === 'edit') {
        console.log('Edit mode active, creating editable boxes...');
        // Small delay to ensure canvas is fully rendered
        await new Promise(resolve => setTimeout(resolve, 50));
        this.createEditableTextBoxes();
      }
      
      console.log('Page rendered successfully');
    } catch (error) {
      console.error('Error rendering page:', error);
      this.showStatus('Error rendering PDF page', 'error');
    } finally {
      this.isRendering = false;
      console.log('Render complete, set isRendering = false');
    }
  }

  /**
   * Create editable text boxes overlaid on the PDF (like Smallpdf)
   * Uses smart block detection to group text into logical sections
   */
  createEditableTextBoxes() {
    // Prevent duplicate creation
    if (this.isCreatingTextBoxes) {
      console.log('Already creating text boxes, skipping...');
      return;
    }
    
    this.isCreatingTextBoxes = true;
    
    console.log('createEditableTextBoxes called');
    console.log('Total extractedTextItems:', this.extractedTextItems.length);
    console.log('Current page:', this.currentPage);
    
    // Get text items for current page
    const pageTextItems = this.extractedTextItems.filter(item => item.pageIndex === this.currentPage);
    console.log('Found', pageTextItems.length, 'text items for page', this.currentPage);
    
    if (pageTextItems.length === 0) {
      console.warn('No text items found for current page');
      this.showStatus('No text found on this page to edit', 'info');
      this.isCreatingTextBoxes = false;
      return;
    }
    
    const canvasWrapper = document.getElementById('canvasWrapper');
    if (!canvasWrapper) {
      console.error('canvasWrapper not found!');
      this.isCreatingTextBoxes = false;
      return;
    }
    
    // Use smart block detection to group text into logical sections
    const textBlocks = this.detectTextBlocks(pageTextItems);
    console.log('Detected', textBlocks.length, 'text blocks');
    
    // Create an editable div for each block
    textBlocks.forEach((block, index) => {
      const editableDiv = document.createElement('div');
      editableDiv.contentEditable = 'true';
      editableDiv.className = 'editable-text-box';
      editableDiv.dataset.blockId = block.id;
      editableDiv.dataset.originalText = block.text;
      
      // Set the text content
      editableDiv.textContent = block.text;
      
      // Calculate canvas position
      // block.y is the TOP of the block in PDF coordinates (origin at bottom-left)
      // Canvas has origin at top-left, so we need to convert
      const canvasX = block.x * this.scale;
      const canvasY = this.canvas.height - (block.y * this.scale);
      
      console.log(`Block ${index}: "${block.text.substring(0, 30)}..."`);
      console.log(`  PDF coords: x=${Math.round(block.x)}, y=${Math.round(block.y)}, w=${Math.round(block.width)}, h=${Math.round(block.height)}`);
      console.log(`  Canvas coords: x=${Math.round(canvasX)}, y=${Math.round(canvasY)}`);
      console.log(`  Canvas size: ${this.canvas.width}x${this.canvas.height}, scale: ${this.scale}`);
      
      // Style the editable div to look like inline text (Smallpdf style)
      editableDiv.style.position = 'absolute';
      editableDiv.style.left = (canvasX - 5) + 'px';
      editableDiv.style.top = (canvasY - 5) + 'px';
      
      // Calculate width based on block size
      let boxWidth;
      if (block.lines.length > 5) {
        // Large block: use most of page width
        boxWidth = this.canvas.width - (canvasX - 5) - 100;
      } else {
        // Smaller blocks: fit content
        boxWidth = Math.max(block.width * this.scale + 50, 250);
      }
      
      editableDiv.style.width = boxWidth + 'px';
      editableDiv.style.minHeight = (block.height * this.scale + 10) + 'px';
      editableDiv.style.height = 'auto';
      editableDiv.style.fontSize = (block.fontSize * this.scale) + 'px';
      editableDiv.style.fontFamily = this.getFontFamily(block.fontFamily);
      editableDiv.style.textAlign = 'left';
      
      // Start with NO border - looks like regular text
      editableDiv.style.border = '2px solid transparent';
      editableDiv.style.background = 'transparent';
      editableDiv.style.color = '#000';
      editableDiv.style.padding = '8px';
      editableDiv.style.margin = '0';
      editableDiv.style.lineHeight = '1.5';
      editableDiv.style.zIndex = '100';
      editableDiv.style.cursor = 'text';
      editableDiv.style.outline = 'none';
      editableDiv.style.boxSizing = 'border-box';
      editableDiv.style.borderRadius = '2px';
      editableDiv.style.whiteSpace = 'pre-wrap';
      editableDiv.style.wordWrap = 'break-word';
      editableDiv.style.transition = 'all 0.2s ease';
      
      // Show dotted border ONLY on focus (Smallpdf behavior)
      editableDiv.addEventListener('focus', () => {
        editableDiv.style.border = '2px dotted #4A90E2';
        editableDiv.style.background = 'rgba(255, 255, 255, 0.98)';
        editableDiv.style.boxShadow = '0 0 0 3px rgba(74, 144, 226, 0.1)';
        this.activeEditBox = editableDiv;
      });
      
      editableDiv.addEventListener('blur', () => {
        editableDiv.style.border = '2px solid transparent';
        editableDiv.style.background = 'transparent';
        editableDiv.style.boxShadow = 'none';
        
        // Save changes on blur
        const newText = editableDiv.textContent;
        const originalText = editableDiv.dataset.originalText;
        
        console.log('Blur event - comparing texts:');
        console.log('  Original:', JSON.stringify(originalText));
        console.log('  New:', JSON.stringify(newText));
        console.log('  Are they different?', newText !== originalText);
        
        if (newText !== originalText) {
          console.log('Block text changed, tracking edit');
          // Track ONE edit for the entire block (not per item)
          // Use bottomY for the Y coordinate since that's where text starts
          const editY = block.bottomY || (block.y - block.height);
          this.trackEdit({
            pageIndex: block.items[0].pageIndex,
            x: block.x,
            y: editY,
            width: block.width,
            height: block.height,
            fontSize: block.fontSize,
            fontName: block.fontFamily,
            text: originalText
          }, newText);
          editableDiv.dataset.originalText = newText;
        } else {
          console.log('No change detected, not tracking edit');
        }
      });
      
      canvasWrapper.appendChild(editableDiv);
      this.editableTextBoxes.push(editableDiv);
    });
    
    console.log('Created', this.editableTextBoxes.length, 'editable text blocks');
    this.isCreatingTextBoxes = false;
  }

  /**
   * Detect logical text blocks using smart grouping algorithm
   * Groups lines that are close together (body paragraphs) but keeps
   * standalone lines (date, headers) separate for precise editing
   */
  detectTextBlocks(textItems) {
    if (textItems.length === 0) return [];
    
    // First, group items into lines
    const lines = this.groupTextItemsByLine(textItems);
    console.log('Grouped into', lines.length, 'lines');
    
    // Sort lines by Y position (top to bottom in PDF coordinates)
    lines.sort((a, b) => b.y - a.y);
    
    // Calculate average line height for spacing analysis
    const lineHeights = lines.map(line => line.height);
    const avgLineHeight = lineHeights.reduce((sum, h) => sum + h, 0) / lineHeights.length;
    console.log('Average line height:', avgLineHeight);
    
    // Group lines into blocks based on spacing
    const blocks = [];
    let currentBlock = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prevLine = i > 0 ? lines[i - 1] : null;
      
      // Calculate vertical gap from previous line
      let gap = 0;
      if (prevLine) {
        gap = prevLine.y - prevLine.height - line.y;
      }
      
      // Decide if this line starts a new block
      // Start new block if:
      // - First line
      // - Gap is more than normal line spacing (> 1.2x average)
      let startsNewBlock = false;
      
      if (!currentBlock) {
        startsNewBlock = true;
      } else if (gap > avgLineHeight * 1.2) {
        // Any gap larger than normal line spacing = new block
        startsNewBlock = true;
      }
      
      if (startsNewBlock) {
        // Save previous block
        if (currentBlock) {
          blocks.push(currentBlock);
        }
        
        // Start new block
        currentBlock = {
          id: `block-${blocks.length}`,
          text: line.text,
          x: line.x,
          y: line.y,
          width: line.width,
          height: line.height,
          fontSize: line.fontSize,
          fontFamily: line.fontName,
          alignment: this.detectAlignment(line.x, this.pageWidth),
          items: [...line.items],
          lines: [line],
          bottomY: line.y - line.height
        };
      } else {
        // Add to current block (lines are close together - same paragraph)
        currentBlock.text += '\n' + line.text;
        currentBlock.width = Math.max(currentBlock.width, line.width);
        currentBlock.bottomY = line.y - line.height;
        currentBlock.height = currentBlock.y - currentBlock.bottomY;
        currentBlock.items.push(...line.items);
        currentBlock.lines.push(line);
      }
    }
    
    // Add the last block
    if (currentBlock) {
      blocks.push(currentBlock);
    }
    
    console.log('Created', blocks.length, 'text blocks');
    blocks.forEach((block, i) => {
      console.log(`  Block ${i}: ${block.lines.length} lines, "${block.text.substring(0, 40)}..." at Y=${Math.round(block.y)}, bottomY=${Math.round(block.bottomY || 0)}, height=${Math.round(block.height)}`);
    });
    
    return blocks;
  }

  /**
   * Detect text alignment based on X position
   */
  detectAlignment(x, pageWidth) {
    const leftMargin = 50;
    const rightMargin = pageWidth - 50;
    const centerZone = pageWidth / 2;
    
    if (x < leftMargin + 20) {
      return 'left';
    } else if (x > rightMargin - 20) {
      return 'right';
    } else if (Math.abs(x - centerZone) < 50) {
      return 'center';
    } else {
      return 'left'; // Default
    }
  }

  /**
   * Group text items that are on the same line
   */
  groupTextItemsByLine(textItems) {
    if (textItems.length === 0) return [];
    
    // Sort by Y position first, then X position
    const sorted = [...textItems].sort((a, b) => {
      const yDiff = Math.abs(a.y - b.y);
      if (yDiff < 2) { // Same line (within 2 points tolerance)
        return a.x - b.x; // Sort by X
      }
      return b.y - a.y; // Sort by Y (top to bottom)
    });
    
    const lines = [];
    let currentLine = null;
    
    sorted.forEach(item => {
      if (!currentLine || Math.abs(item.y - currentLine.y) > 2) {
        // Start a new line
        if (currentLine) {
          lines.push(currentLine);
        }
        currentLine = {
          text: item.text,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          fontSize: item.fontSize,
          fontName: item.fontName,
          pageIndex: item.pageIndex,
          items: [item]
        };
      } else {
        // Add to current line
        currentLine.text += ' ' + item.text;
        currentLine.width = (item.x + item.width) - currentLine.x;
        currentLine.height = Math.max(currentLine.height, item.height);
        currentLine.items.push(item);
      }
    });
    
    // Add the last line
    if (currentLine) {
      lines.push(currentLine);
    }
    
    return lines;
  }

  /**
   * Clear all editable text boxes
   */
  clearEditableTextBoxes() {
    console.log('clearEditableTextBoxes called, currently have', this.editableTextBoxes.length, 'boxes');
    
    // Find all text boxes in the DOM (in case array is out of sync)
    const canvasWrapper = document.getElementById('canvasWrapper');
    if (canvasWrapper) {
      const allTextBoxes = canvasWrapper.querySelectorAll('.editable-text-box');
      console.log('Found', allTextBoxes.length, 'text boxes in DOM');
      allTextBoxes.forEach(box => {
        box.remove();
      });
    }
    
    // Also clear from array
    this.editableTextBoxes.forEach(box => {
      if (box && box.parentNode) {
        box.parentNode.removeChild(box);
      }
    });
    
    this.editableTextBoxes = [];
    this.activeEditBox = null;
    console.log('All text boxes cleared');
  }

  /**
   * Get CSS font family from PDF font name
   */
  getFontFamily(fontName) {
    if (!fontName) return 'Arial, sans-serif';
    
    const fontLower = fontName.toLowerCase();
    if (fontLower.includes('times') || fontLower.includes('serif')) {
      return '"Times New Roman", Times, serif';
    } else if (fontLower.includes('courier') || fontLower.includes('mono')) {
      return '"Courier New", Courier, monospace';
    } else {
      return 'Arial, Helvetica, sans-serif';
    }
  }

  /**
   * Track an edit for later processing
   */
  trackEdit(originalItem, newText) {
    // Find if this item was already edited
    const existingEditIndex = this.edits.findIndex(edit => 
      edit.pageIndex === originalItem.pageIndex &&
      Math.abs(edit.x - originalItem.x) < 1 &&
      Math.abs(edit.y - originalItem.y) < 1
    );
    
    const edit = {
      pageIndex: originalItem.pageIndex,
      x: originalItem.x,
      y: originalItem.y,
      width: originalItem.width,
      height: originalItem.height,
      fontSize: originalItem.fontSize,
      fontName: originalItem.fontName,
      originalText: originalItem.text,
      newText: newText
    };
    
    if (existingEditIndex >= 0) {
      // Update existing edit
      this.edits[existingEditIndex] = edit;
    } else {
      // Add new edit
      this.edits.push(edit);
    }
    
    console.log('Tracked edit:', edit);
    this.showStatus(`Text updated: "${originalItem.text}" → "${newText}"`, 'success');
  }

  setMode(mode) {
    console.log('setMode called:', mode, 'current mode:', this.mode);
    
    const previousMode = this.mode;
    this.mode = mode;
    
    // Update button styles
    const textBtn = document.getElementById('textModeBtn');
    const editBtn = document.getElementById('editModeBtn');
    const sigBtn = document.getElementById('signatureModeBtn');
    
    // Reset all buttons
    [textBtn, editBtn, sigBtn].forEach(btn => {
      btn.classList.add('secondary');
      btn.style.background = '';
    });
    
    if (mode === 'text') {
      textBtn.classList.remove('secondary');
      textBtn.style.background = '#28a745';
      document.getElementById('textInput').focus();
      this.clearEditableTextBoxes();
      // Show canvas
      this.canvas.style.opacity = '1';
    } else if (mode === 'edit') {
      editBtn.classList.remove('secondary');
      editBtn.style.background = '#28a745';
      
      // Hide canvas text completely - editable divs will replace it
      this.canvas.style.opacity = '0';
      
      // Only render if switching FROM another mode TO edit mode
      if (previousMode !== 'edit') {
        console.log('Switching to edit mode from', previousMode, '- will render page');
        this.renderCurrentPage();
      } else {
        console.log('Already in edit mode, not re-rendering');
      }
    } else if (mode === 'signature') {
      sigBtn.classList.remove('secondary');
      sigBtn.style.background = '#28a745';
      document.getElementById('signatureInput').focus();
      this.clearEditableTextBoxes();
      // Show canvas
      this.canvas.style.opacity = '1';
    }
    
    this.updateModeIndicator();
  }

  updateModeIndicator() {
    const indicator = document.getElementById('modeIndicator');
    if (!this.controller.isLoaded) {
      indicator.textContent = 'No PDF loaded';
      indicator.classList.remove('active');
    } else if (this.mode === 'text') {
      indicator.textContent = 'Text Mode Active';
      indicator.classList.add('active');
    } else if (this.mode === 'edit') {
      indicator.textContent = 'Edit Mode Active - Type directly in text boxes';
      indicator.classList.add('active');
    } else if (this.mode === 'signature') {
      indicator.textContent = 'Signature Mode Active';
      indicator.classList.add('active');
    } else {
      indicator.textContent = 'Select a mode';
      indicator.classList.remove('active');
    }
  }

  async handleCanvasClick(event) {
    if (!this.controller.isLoaded || !this.mode) {
      this.showStatus('Please load a PDF and select a mode first', 'error');
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;
    const x = canvasX / this.scale;
    const y = this.pageHeight - (canvasY / this.scale); // Convert to PDF coordinates (origin at bottom-left)

    console.log('Canvas click at:', x, y);

    try {
      if (this.mode === 'edit') {
        // In edit mode, text boxes handle editing - canvas clicks are ignored
        return;
        
      } else if (this.mode === 'text') {
        const text = document.getElementById('textInput').value.trim();
        if (!text) {
          this.showStatus('Please enter text first', 'error');
          return;
        }

        const textEditor = this.controller.getTextEditor();
        await textEditor.addText(this.currentPage, text, x, y, {
          size: 16,
          color: { r: 0, g: 0, b: 0 }
        });

        this.showStatus(`Text "${text}" added at position (${Math.round(x)}, ${Math.round(y)})`, 'success');
        
        // Re-render to show the new text
        this.renderCurrentPage();
        
        // Clear input
        document.getElementById('textInput').value = '';
        
      } else if (this.mode === 'signature') {
        const signatureText = document.getElementById('signatureInput').value.trim();
        if (!signatureText) {
          this.showStatus('Please enter your name first', 'error');
          return;
        }

        const signatureEditor = this.controller.getSignatureEditor();
        await signatureEditor.addTypedSignature(this.currentPage, signatureText, x, y, {
          fontSize: 24,
          color: { r: 0, g: 0, b: 0.5 }
        });

        this.showStatus(`Signature "${signatureText}" added`, 'success');
        
        // Re-render to show the new signature
        this.renderCurrentPage();
        
        // Clear input
        document.getElementById('signatureInput').value = '';
      }
    } catch (error) {
      console.error('Error handling canvas click:', error);
      this.showStatus(`Error: ${error.message}`, 'error');
    }
  }

  async savePDF() {
    if (!this.controller.isLoaded) {
      this.showStatus('No PDF loaded', 'error');
      return;
    }

    try {
      this.showStatus('Saving PDF...', 'info');
      
      // If there are edits, use backend to process them
      if (this.edits.length > 0) {
        console.log('Processing', this.edits.length, 'edits through backend');
        
        if (!this.originalFileData) {
          throw new Error('Original PDF data not available');
        }
        
        // Use backend to edit PDF
        const editedPdfBytes = await PDFBackendService.editPDF(this.originalFileData, this.edits);
        const blob = new Blob([editedPdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'edited-document.pdf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.showStatus('PDF saved successfully! Reloading edited version...', 'success');
        
        // Update the original file data with the edited version
        // This ensures subsequent edits build on top of previous changes
        this.originalFileData = editedPdfBytes;
        
        // Reload the PDF to show the edited version
        const loadingTask = pdfjsLib.getDocument({ data: editedPdfBytes.slice(0) });
        this.pdfJsDoc = await loadingTask.promise;
        
        // Re-extract text from the edited PDF
        const editedBlob = new Blob([editedPdfBytes], { type: 'application/pdf' });
        const editedFile = new File([editedBlob], 'edited-document.pdf', { type: 'application/pdf' });
        
        try {
          const extractData = await PDFBackendService.extractText(editedFile);
          this.extractedTextItems = [];
          if (extractData.pages) {
            extractData.pages.forEach(page => {
              page.textItems.forEach(item => {
                this.extractedTextItems.push({
                  ...item,
                  pageIndex: page.pageNumber
                });
              });
            });
          }
        } catch (backendError) {
          console.error('Backend text extraction failed after save:', backendError);
        }
        
        // Clear edits and re-render
        this.edits = [];
        await this.renderCurrentPage();
        
        this.showStatus('PDF saved and reloaded successfully!', 'success');
      } else {
        // No edits, use regular save
        await this.controller.saveAs('edited-document.pdf');
      }
    } catch (error) {
      console.error('Save error:', error);
      this.showStatus(`Failed to save: ${error.message}`, 'error');
    }
  }

  async clearSignature() {
    if (!this.controller.isLoaded) {
      this.showStatus('No PDF loaded', 'error');
      return;
    }

    try {
      this.showStatus('Clearing signature...', 'info');
      
      if (!this.originalFileData) {
        throw new Error('Original PDF data not available');
      }
      
      // Use backend to clear signature
      const clearedPdfBytes = await PDFBackendService.clearSignature(this.originalFileData);
      
      // Download the cleared PDF immediately
      const blob = new Blob([clearedPdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'cleared-signature.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      this.showStatus('Signature cleared and PDF saved! Reloading...', 'success');
      
      // Update the original file data so future edits use the cleared version
      this.originalFileData = clearedPdfBytes;
      
      // Reload the PDF
      const loadingTask = pdfjsLib.getDocument({ data: clearedPdfBytes.slice(0) });
      this.pdfJsDoc = await loadingTask.promise;
      
      // Re-extract text
      const clearedBlob = new Blob([clearedPdfBytes], { type: 'application/pdf' });
      const clearedFile = new File([clearedBlob], 'cleared-document.pdf', { type: 'application/pdf' });
      
      try {
        const extractData = await PDFBackendService.extractText(clearedFile);
        this.extractedTextItems = [];
        if (extractData.pages) {
          extractData.pages.forEach(page => {
            page.textItems.forEach(item => {
              this.extractedTextItems.push({
                ...item,
                pageIndex: page.pageNumber
              });
            });
          });
        }
      } catch (backendError) {
        console.error('Backend text extraction failed after clear:', backendError);
      }
      
      // Re-render
      await this.renderCurrentPage();
      
      this.showStatus('Signature cleared and saved successfully!', 'success');
    } catch (error) {
      console.error('Clear signature error:', error);
      this.showStatus(`Failed to clear signature: ${error.message}`, 'error');
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

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new PDFEditorApp();
});
