import { EditorController } from './core/EditorController.js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';

// Self-host the PDF.js worker (bundled by webpack) instead of loading it from a CDN.
// No external network request is made, so the app works fully offline and never reaches
// out to a third party while handling your document.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.js',
  import.meta.url
).toString();

// Largest PDF a user may open/edit. Keeps per-save memory and server load in check.
// Change this single number (e.g. to 5) to adjust the limit everywhere in the UI.
const MAX_FILE_MB = 10;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

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
    this.edits = []; // All pending edits (line replaces, inserts, erases)
    this.insertOverlays = []; // Draggable/resizable overlays for added text & signatures
    this.history = [[]]; // Undo/redo snapshots of this.edits
    this.historyIndex = 0;
    this.isRendering = false; // Prevent multiple simultaneous renders
    this.isCreatingTextBoxes = false; // Prevent duplicate text box creation
    this.eventListenersInitialized = false; // Prevent duplicate event listeners
    
    this.initializeEventListeners();
    this.setupControllerEvents();
    
    console.log('PDF Editor App initialized (runs entirely in your browser)');
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

    document.getElementById('eraseModeBtn')?.addEventListener('click', () => {
      this.setMode('erase');
    });

    // Clear signature button
    document.getElementById('clearSignatureBtn').addEventListener('click', () => {
      this.clearSignature();
    });

    // Undo / redo
    document.getElementById('undoBtn')?.addEventListener('click', () => this.undo());
    document.getElementById('redoBtn')?.addEventListener('click', () => this.redo());
    window.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const t = e.target;
      const editable = t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
      if (editable) return;  // let the browser's native undo work while typing in a field/box
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); this.redo(); }
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

    // Erase tool: drag a rectangle over content (e.g. a signature) to white it out.
    this.canvas.addEventListener('mousedown', (e) => this.onEraseStart(e));
    window.addEventListener('mousemove', (e) => this.onEraseMove(e));
    window.addEventListener('mouseup', (e) => this.onEraseEnd(e));
    
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
   * Extract text geometry from PDF.js using the SAME viewport transform that paints
   * the canvas. Every value is stored in canvas (device) pixels at this.scale, so the
   * editable overlays line up exactly with the rendered page on every document.
   *
   * For a text item, tx = viewport.transform ∘ item.transform maps text space to canvas
   * pixels: tx[4] is the left edge, tx[5] is the baseline (top-origin), and hypot(tx[2],
   * tx[3]) is the font height in pixels. item.width is in PDF points, so * scale = px.
   */
  async extractTextFromPDFjs() {
    console.log('Extracting text geometry from all pages using PDF.js...');
    this.extractedTextItems = [];

    for (let pageNum = 0; pageNum < this.pdfJsDoc.numPages; pageNum++) {
      const page = await this.pdfJsDoc.getPage(pageNum + 1);
      const viewport = page.getViewport({ scale: this.scale });
      const textContent = await page.getTextContent();
      const styles = textContent.styles || {};

      textContent.items
        .filter(item => item.str && item.str.trim().length > 0)
        .forEach(item => {
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const left = tx[4];
          const baseline = tx[5];
          const fontHeightPx = Math.hypot(tx[2], tx[3]) || (item.height * this.scale);
          const widthPx = item.width * this.scale;
          const ascent = fontHeightPx * 0.8;
          const descent = fontHeightPx * 0.2;

          // Best-effort weight/style/family detection from the font name + family.
          const fam = (((styles[item.fontName] || {}).fontFamily || '') + ' ' + (item.fontName || '')).toLowerCase();
          const bold = /bold|black|heavy|semibold|cmbx/.test(fam);
          const italic = /italic|oblique|cmti|cmsl/.test(fam);
          const isSans = /sans|helvetica|arial|verdana|calibri|segoe|roboto|tahoma|cmss/.test(fam);
          const serif = !isSans && /serif|times|roman|georgia|garamond|cmr|cmbx|cmti|cmsl|charter|minion/.test(fam);

          this.extractedTextItems.push({
            text: item.str,
            pageIndex: pageNum,
            left: left,
            right: left + widthPx,
            baseline: baseline,
            top: baseline - ascent,
            bottom: baseline + descent,
            width: widthPx,
            height: fontHeightPx,
            fontSizePx: fontHeightPx,
            fontName: item.fontName || 'Helvetica',
            bold: bold,
            italic: italic,
            serif: serif
          });
        });
    }

    console.log('PDF.js extracted', this.extractedTextItems.length, 'text items (canvas px)');
  }

  async handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Enforce the size limit before doing any work.
    if (file.size > MAX_FILE_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      this.showStatus(`That PDF is ${mb} MB — please choose a file under ${MAX_FILE_MB} MB.`, 'error');
      document.body.classList.remove('has-pdf');  // keep the upload screen showing
      event.target.value = '';                     // allow re-selecting after picking a smaller file
      return;
    }
    // Size OK — reveal the editor.
    document.body.classList.add('has-pdf');

    try {
      console.log('File selected:', file.name);
      this.showStatus('Loading PDF...', 'info');

      const fileNameEl = document.getElementById('fileName');
      if (fileNameEl) fileNameEl.textContent = file.name;

      // Store original file; start with a clean edit/undo history for the new document
      this.originalFile = file;
      this.edits = [];
      this.resetHistory();

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
      
      // Extract text geometry with PDF.js — the same engine that renders the canvas —
      // so the editable overlays align exactly. The backend is used only when saving.
      await this.extractTextFromPDFjs();

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
    
    // Clear overlays before rendering
    this.clearEditableTextBoxes();
    this.clearInsertOverlays();

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

      // Draw any pending erase rectangles and added-text / signature inserts on top.
      this.drawPendingErases();
      this.createInsertOverlays();

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
   * Overlay an editable box on EACH line of text. Every box sits exactly on its original
   * line (same left, baseline and size) and edits that line in place. Only the lines the
   * user actually changes are tracked, so saving leaves all other text untouched.
   */
  createEditableTextBoxes() {
    if (this.isCreatingTextBoxes) return;
    this.isCreatingTextBoxes = true;

    const pageTextItems = this.extractedTextItems.filter(item => item.pageIndex === this.currentPage);
    if (pageTextItems.length === 0) {
      this.showStatus('No text found on this page to edit', 'info');
      this.isCreatingTextBoxes = false;
      return;
    }

    const canvasWrapper = document.getElementById('canvasWrapper');
    if (!canvasWrapper) {
      this.isCreatingTextBoxes = false;
      return;
    }

    // The canvas may be displayed smaller than its intrinsic pixels (max-width:100%).
    const displayScale = (this.canvas.clientWidth || this.canvas.width) / this.canvas.width;

    const lines = this.groupTextItemsByLine(pageTextItems);
    console.log('Editing', lines.length, 'lines; displayScale =', displayScale.toFixed(3));

    // Erase the original text from the canvas (white over each line) while leaving
    // images/graphics intact, so the editable boxes are the only visible text.
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);   // device pixels, regardless of render state
    this.ctx.fillStyle = '#ffffff';
    lines.forEach((line) => {
      this.ctx.fillRect(line.left - 2, line.top - 2, (line.right - line.left) + 6, (line.bottom - line.top) + 4);
    });
    this.ctx.restore();

    lines.forEach((line) => {
      const div = document.createElement('div');
      div.contentEditable = 'true';
      div.className = 'editable-text-box';
      div.dataset.originalText = line.text;
      div.textContent = line.text;

      const fontSizePx = line.fontSizePx * displayScale;
      const lineBoxPx = Math.max((line.bottom - line.top) * displayScale, fontSizePx);
      const halfLeading = Math.max(0, (lineBoxPx - fontSizePx) / 2);
      const ascent = fontSizePx * 0.8;

      const leftCss = line.left * displayScale;
      const topCss = line.baseline * displayScale - ascent - halfLeading;  // sit on the baseline
      const widthCss = (line.right - line.left) * displayScale;

      div.style.position = 'absolute';
      div.style.left = (leftCss - 1) + 'px';
      div.style.top = (topCss - 1) + 'px';
      div.style.minWidth = Math.max(widthCss, 20) + 'px';   // width:auto -> grows with text
      div.style.height = (lineBoxPx + 2) + 'px';
      div.style.fontSize = fontSizePx + 'px';
      div.style.lineHeight = lineBoxPx + 'px';
      div.style.fontFamily = line.serif ? '"Times New Roman", Times, serif' : 'Arial, Helvetica, sans-serif';
      div.style.fontWeight = line.bold ? 'bold' : 'normal';
      div.style.fontStyle = line.italic ? 'italic' : 'normal';
      div.style.color = '#000';
      div.style.padding = '0';
      div.style.margin = '0';
      div.style.border = '1px solid transparent';
      div.style.background = 'transparent';
      div.style.zIndex = '100';
      div.style.cursor = 'text';
      div.style.outline = 'none';
      div.style.boxSizing = 'border-box';
      div.style.whiteSpace = 'pre';        // single line; typing extends to the right
      div.style.overflow = 'visible';

      div.addEventListener('focus', () => {
        div.style.border = '1px solid #4A90E2';
        div.style.boxShadow = '0 0 0 2px rgba(74,144,226,0.25)';
        div.style.background = '#ffffff';
        div.style.zIndex = '200';
        this.activeEditBox = div;
      });

      div.addEventListener('blur', () => {
        div.style.border = '1px solid transparent';
        div.style.boxShadow = 'none';
        div.style.background = 'transparent';
        div.style.zIndex = '100';
        const newText = div.textContent;
        if (newText !== div.dataset.originalText) {
          this.trackEdit(this.lineToEdit(line, newText));
          div.dataset.originalText = newText;
        }
      });

      // Keep each box a single line: Enter commits the edit instead of adding a line.
      div.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); div.blur(); }
      });

      canvasWrapper.appendChild(div);
      this.editableTextBoxes.push(div);
    });

    this.isCreatingTextBoxes = false;
  }

  /**
   * Convert a line (canvas-pixel geometry) into the edit descriptor the backend expects:
   * PDF points with a TOP-LEFT origin (x, right, top, bottom, baseline).
   */
  lineToEdit(line, newText) {
    const s = this.scale;
    return {
      pageIndex: line.pageIndex,
      x: line.left / s,
      right: line.right / s,
      top: line.top / s,
      bottom: line.bottom / s,
      baseline: line.baseline / s,
      fontSize: line.fontSizePx / s,
      bold: !!line.bold,
      italic: !!line.italic,
      serif: !!line.serif,
      newText: newText
    };
  }

  /**
   * Group text items that share a baseline into a single line. All geometry is in
   * canvas pixels (top-origin), as produced by extractTextFromPDFjs().
   */
  groupTextItemsByLine(textItems) {
    if (textItems.length === 0) return [];

    const sorted = [...textItems].sort((a, b) => {
      if (Math.abs(a.baseline - b.baseline) < 3) return a.left - b.left;  // same line: left to right
      return a.baseline - b.baseline;                                     // else top to bottom
    });

    const lines = [];
    let currentLine = null;

    sorted.forEach(item => {
      const tol = Math.max(3, item.height * 0.4);
      if (!currentLine || Math.abs(item.baseline - currentLine.baseline) > tol) {
        if (currentLine) lines.push(currentLine);
        currentLine = {
          text: item.text,
          left: item.left,
          right: item.right,
          baseline: item.baseline,
          top: item.top,
          bottom: item.bottom,
          height: item.height,
          fontSizePx: item.fontSizePx,
          fontName: item.fontName,
          pageIndex: item.pageIndex,
          items: [item]
        };
      } else {
        // Same line: append, inserting a space when there is a real horizontal gap.
        const gap = item.left - currentLine.right;
        currentLine.text += (gap > item.height * 0.25 ? ' ' : '') + item.text;
        currentLine.left = Math.min(currentLine.left, item.left);
        currentLine.right = Math.max(currentLine.right, item.right);
        currentLine.top = Math.min(currentLine.top, item.top);
        currentLine.bottom = Math.max(currentLine.bottom, item.bottom);
        currentLine.height = Math.max(currentLine.height, item.height);
        currentLine.items.push(item);
      }
    });

    if (currentLine) lines.push(currentLine);
    lines.forEach(line => this.finalizeLineStyle(line));
    return lines;
  }

  /**
   * Decide a line's font size and weight from its items. The size is the one used by the
   * MOST characters (so a stray small glyph like a "•" bullet can't shrink the whole line),
   * and bold/italic apply when the majority of characters are bold/italic.
   */
  finalizeLineStyle(line) {
    const buckets = new Map();   // rounded height -> { chars, height }
    let boldChars = 0, italicChars = 0, serifChars = 0, totalChars = 0;
    for (const it of line.items) {
      const n = Math.max(1, (it.text || '').trim().length);
      totalChars += n;
      if (it.bold) boldChars += n;
      if (it.italic) italicChars += n;
      if (it.serif) serifChars += n;
      const key = Math.round(it.height * 2) / 2;
      const b = buckets.get(key) || { chars: 0, height: it.height };
      b.chars += n;
      b.height = Math.max(b.height, it.height);
      buckets.set(key, b);
    }
    let best = null;
    for (const b of buckets.values()) if (!best || b.chars > best.chars) best = b;
    if (best) line.fontSizePx = best.height;
    line.bold = totalChars > 0 && boldChars * 2 > totalChars;
    line.italic = totalChars > 0 && italicChars * 2 > totalChars;
    line.serif = totalChars > 0 && serifChars * 2 >= totalChars;
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
   * Track a per-line edit for saving. If the same line is edited again, the previous
   * edit is replaced. `edit` already carries the line geometry and newText.
   */
  trackEdit(edit) {
    const existingIndex = this.edits.findIndex(e =>
      e.pageIndex === edit.pageIndex &&
      Math.abs(e.x - edit.x) < 1 &&
      Math.abs(e.baseline - edit.baseline) < 1
    );

    if (existingIndex >= 0) {
      this.edits[existingIndex] = edit;
    } else {
      this.edits.push(edit);
    }

    this.commitHistory();
    console.log('Tracked edit:', edit);
    this.showStatus(`Updated: "${edit.newText.slice(0, 40)}"`, 'success');
  }

  setMode(mode) {
    console.log('setMode called:', mode, 'current mode:', this.mode);
    
    const previousMode = this.mode;
    this.mode = mode;
    
    const textBtn = document.getElementById('textModeBtn');
    const editBtn = document.getElementById('editModeBtn');
    const sigBtn = document.getElementById('signatureModeBtn');
    const eraseBtn = document.getElementById('eraseModeBtn');

    // Highlight the active tool and expose the mode on <body> so the UI (CSS) can
    // show the relevant inputs / cursor for that tool.
    [textBtn, editBtn, sigBtn, eraseBtn].forEach(btn => btn && btn.classList.remove('active'));
    document.body.dataset.mode = mode || '';

    if (mode === 'text') {
      textBtn.classList.add('active');
      document.getElementById('textInput').focus();
      this.clearEditableTextBoxes();
      this.canvas.style.opacity = '1';
      // Leaving edit mode erased the canvas text; re-render to restore it.
      if (previousMode === 'edit') this.renderCurrentPage();
    } else if (mode === 'edit') {
      editBtn.classList.add('active');
      // Keep the canvas visible; the editable boxes have an opaque white background
      // that covers the original text, so the logo and graphics stay on screen.
      this.canvas.style.opacity = '1';
      if (previousMode !== 'edit') {
        this.renderCurrentPage();
      }
    } else if (mode === 'signature') {
      sigBtn.classList.add('active');
      document.getElementById('signatureInput').focus();
      this.clearEditableTextBoxes();
      this.canvas.style.opacity = '1';
      if (previousMode === 'edit') this.renderCurrentPage();
    } else if (mode === 'erase') {
      if (eraseBtn) eraseBtn.classList.add('active');
      this.clearEditableTextBoxes();
      this.canvas.style.opacity = '1';
      if (previousMode === 'edit') this.renderCurrentPage();
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
    } else if (this.mode === 'erase') {
      indicator.textContent = 'Erase Mode - drag over what you want to remove';
      indicator.classList.add('active');
    } else {
      indicator.textContent = 'Select a mode';
      indicator.classList.remove('active');
    }
  }

  handleCanvasClick(event) {
    if (!this.controller.isLoaded || !this.mode) {
      this.showStatus('Open a PDF and pick a mode first', 'error');
      return;
    }
    if (this.mode === 'edit') return;  // edit mode is handled by the per-line boxes

    // Map the click to intrinsic canvas pixels (handles CSS scaling), then to PDF
    // points with a top-left origin — the same coordinate space used when saving.
    const rect = this.canvas.getBoundingClientRect();
    const toIntrinsic = this.canvas.width / rect.width;
    const xPt = ((event.clientX - rect.left) * toIntrinsic) / this.scale;
    const clickYPt = ((event.clientY - rect.top) * toIntrinsic) / this.scale;

    if (this.mode === 'text') {
      const text = document.getElementById('textInput').value.trim();
      if (!text) { this.showStatus('Type the text to add first', 'error'); return; }
      const fontSize = parseInt(document.getElementById('fontSize').value, 10) || 14;
      this.placeInsert(xPt, clickYPt, text, fontSize, 'text');
      this.showStatus(`Added "${text}" — click Save PDF to keep it`, 'success');
      document.getElementById('textInput').value = '';
    } else if (this.mode === 'signature') {
      const name = document.getElementById('signatureInput').value.trim();
      if (!name) { this.showStatus('Type your name first', 'error'); return; }
      this.placeInsert(xPt, clickYPt, name, 26, 'signature');
      this.showStatus('Signature placed — click Save PDF to keep it', 'success');
    }
  }

  /**
   * Queue an inserted item (added text or a typed signature) at a click point. The click
   * is treated as the top-left of the text, so the baseline sits ~one ascent below it.
   * It is drawn as a preview now and inserted for real by the backend on Save.
   */
  placeInsert(xPt, topPt, text, fontSize, style) {
    this.edits.push({
      pageIndex: this.currentPage,
      redact: false,            // nothing to remove — this is an insert, not a replace
      style: style,             // 'text' or 'signature'
      x: xPt,
      baseline: topPt + fontSize * 0.8,
      fontSize: fontSize,
      newText: text
    });
    this.commitHistory();
    this.renderCurrentPage();
  }

  clearInsertOverlays() {
    const wrap = document.getElementById('canvasWrapper');
    if (wrap) wrap.querySelectorAll('.insert-overlay').forEach(el => el.remove());
    this.insertOverlays = [];
  }

  /**
   * Render each pending insert (added text / signature) as a draggable, resizable overlay
   * so the user can move it into place and size it. Dragging updates the edit's position;
   * the resize handle changes its font size; the × button deletes it. All changes are
   * undoable and are written into the PDF (at the same spot) on Save.
   */
  createInsertOverlays() {
    const wrap = document.getElementById('canvasWrapper');
    if (!wrap) return;
    const ds = (this.canvas.clientWidth || this.canvas.width) / this.canvas.width;
    const unit = this.scale * ds;  // PDF points -> displayed CSS px
    const inserts = this.edits.filter(e =>
      e.redact === false && e.pageIndex === this.currentPage && e.newText);

    inserts.forEach(edit => {
      const fontPx = edit.fontSize * unit;
      const ascent = fontPx * 0.8;

      const div = document.createElement('div');
      div.className = 'insert-overlay';
      div.textContent = edit.newText;
      div.style.left = (edit.x * unit) + 'px';
      div.style.top = (edit.baseline * unit - ascent) + 'px';
      div.style.fontSize = fontPx + 'px';
      div.style.lineHeight = fontPx + 'px';
      div.style.fontStyle = edit.style === 'signature' ? 'italic' : 'normal';
      div.style.fontFamily = edit.style === 'signature'
        ? '"Snell Roundhand","Apple Chancery","Brush Script MT",cursive'
        : 'Arial, Helvetica, sans-serif';

      const del = document.createElement('div');
      del.className = 'insert-del';
      del.textContent = '×';
      const handle = document.createElement('div');
      handle.className = 'insert-handle';
      div.appendChild(del);
      div.appendChild(handle);

      this.wireInsertOverlay(div, del, handle, edit, unit);
      wrap.appendChild(div);
      this.insertOverlays.push(div);
    });
  }

  /** Attach move / resize / delete behaviour to one insert overlay. */
  wireInsertOverlay(div, del, handle, edit, unit) {
    const commitFromDiv = () => {
      const fontPx = parseFloat(div.style.fontSize);
      const ascent = fontPx * 0.8;
      edit.fontSize = fontPx / unit;
      edit.x = parseFloat(div.style.left) / unit;
      edit.baseline = (parseFloat(div.style.top) + ascent) / unit;
      this.commitHistory();
    };

    // Move (drag the body)
    div.addEventListener('mousedown', (e) => {
      if (e.target === del || e.target === handle) return;
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      const ox = parseFloat(div.style.left), oy = parseFloat(div.style.top);
      const move = (ev) => {
        div.style.left = (ox + ev.clientX - sx) + 'px';
        div.style.top = (oy + ev.clientY - sy) + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        commitFromDiv();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // Resize (drag the corner handle = change font size)
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sy = e.clientY;
      const startFont = parseFloat(div.style.fontSize);
      const move = (ev) => {
        const f = Math.max(8, startFont + (ev.clientY - sy));
        div.style.fontSize = f + 'px';
        div.style.lineHeight = f + 'px';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        commitFromDiv();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // Delete
    del.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    del.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.edits = this.edits.filter(x => x !== edit);
      this.commitHistory();
      this.renderCurrentPage();
    });
  }

  // ----- Undo / redo (snapshots of this.edits) -----
  snapshotEdits() { return this.edits.map(e => ({ ...e })); }

  commitHistory() {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(this.snapshotEdits());
    this.historyIndex = this.history.length - 1;
    this.updateHistoryButtons();
  }

  resetHistory() {
    this.history = [this.snapshotEdits()];
    this.historyIndex = 0;
    this.updateHistoryButtons();
  }

  undo() {
    if (this.historyIndex <= 0) return;
    this.historyIndex--;
    this.edits = this.history[this.historyIndex].map(e => ({ ...e }));
    this.updateHistoryButtons();
    this.renderCurrentPage();
    this.showStatus('Undo', 'info');
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    this.edits = this.history[this.historyIndex].map(e => ({ ...e }));
    this.updateHistoryButtons();
    this.renderCurrentPage();
    this.showStatus('Redo', 'info');
  }

  updateHistoryButtons() {
    const u = document.getElementById('undoBtn');
    const r = document.getElementById('redoBtn');
    if (u) u.disabled = this.historyIndex <= 0;
    if (r) r.disabled = this.historyIndex >= this.history.length - 1;
  }

  /**
   * Draw pending erase rectangles (white-out areas, e.g. an old signature) as a preview.
   */
  drawPendingErases() {
    const erases = this.edits.filter(e => e.kind === 'erase' && e.pageIndex === this.currentPage);
    if (erases.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    erases.forEach(e => {
      ctx.fillRect(e.x * this.scale, e.top * this.scale,
        (e.right - e.x) * this.scale, (e.bottom - e.top) * this.scale);
    });
    ctx.restore();
  }

  // ----- Erase tool (drag a rectangle to white-out content) -----
  onEraseStart(event) {
    if (this.mode !== 'erase' || !this.controller.isLoaded) return;
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    this.eraseDrag = { startX: event.clientX, startY: event.clientY, rect };
    const wrap = document.getElementById('canvasWrapper');
    const sel = document.createElement('div');
    sel.style.position = 'absolute';
    sel.style.border = '1.5px dashed #e5484d';
    sel.style.background = 'rgba(229,72,77,0.12)';
    sel.style.zIndex = '300';
    sel.style.pointerEvents = 'none';
    wrap.appendChild(sel);
    this.eraseSel = sel;
  }

  onEraseMove(event) {
    if (!this.eraseDrag) return;
    const r = this.eraseDrag.rect;
    const x0 = this.eraseDrag.startX - r.left, y0 = this.eraseDrag.startY - r.top;
    const x1 = event.clientX - r.left, y1 = event.clientY - r.top;
    this.eraseSel.style.left = Math.min(x0, x1) + 'px';
    this.eraseSel.style.top = Math.min(y0, y1) + 'px';
    this.eraseSel.style.width = Math.abs(x1 - x0) + 'px';
    this.eraseSel.style.height = Math.abs(y1 - y0) + 'px';
  }

  onEraseEnd(event) {
    if (!this.eraseDrag) return;
    const r = this.eraseDrag.rect;
    const x0 = this.eraseDrag.startX - r.left, y0 = this.eraseDrag.startY - r.top;
    const x1 = event.clientX - r.left, y1 = event.clientY - r.top;
    if (this.eraseSel) { this.eraseSel.remove(); this.eraseSel = null; }
    this.eraseDrag = null;

    const leftCss = Math.min(x0, x1), topCss = Math.min(y0, y1);
    const wCss = Math.abs(x1 - x0), hCss = Math.abs(y1 - y0);
    if (wCss < 4 || hCss < 4) return;  // ignore stray clicks

    // Displayed px -> intrinsic canvas px -> PDF points (top-left origin).
    const toIntrinsic = this.canvas.width / r.width;
    const xPt = (leftCss * toIntrinsic) / this.scale;
    const topPt = (topCss * toIntrinsic) / this.scale;
    const wPt = (wCss * toIntrinsic) / this.scale;
    const hPt = (hCss * toIntrinsic) / this.scale;

    this.edits.push({
      pageIndex: this.currentPage,
      kind: 'erase',
      x: xPt,
      right: xPt + wPt,
      top: topPt,
      bottom: topPt + hPt,
      newText: ''
    });
    this.commitHistory();
    this.showStatus('Area erased — click Save to apply (Clear to undo)', 'success');
    this.renderCurrentPage();
  }

  async savePDF() {
    if (!this.controller.isLoaded) {
      this.showStatus('No PDF loaded', 'error');
      return;
    }

    try {
      this.showStatus('Saving PDF…', 'info');

      if (!this.originalFileData) {
        throw new Error('Original PDF data not available');
      }

      // Preferred path: edit the real PDF with pdf-lib (keeps selectable text).
      // Some PDFs are encrypted — pdf-lib can't decrypt them — so on failure we fall
      // back to flattening each rendered page (with edits) to an image-based PDF.
      let editedPdfBytes;
      let flattened = false;
      try {
        editedPdfBytes = await this.applyEditsWithPdfLib(this.originalFileData, this.edits);
      } catch (vectorErr) {
        console.warn('Vector save failed, flattening to image PDF instead:', vectorErr);
        editedPdfBytes = await this.flattenToPdfBytes(this.edits);
        flattened = true;
      }

      // Download it.
      const blob = new Blob([editedPdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'edited-document.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (flattened) {
        // Flattened output is image-based; keep editing the original document.
        this.showStatus('Saved a flattened copy — this PDF is protected, so text-level editing wasn\'t possible. To keep selectable text, remove the PDF\'s protection first.', 'info');
      } else {
        // Keep editing on top of the saved version: reload + re-extract geometry.
        this.originalFileData = editedPdfBytes;
        const loadingTask = pdfjsLib.getDocument({ data: editedPdfBytes.slice(0) });
        this.pdfJsDoc = await loadingTask.promise;
        await this.extractTextFromPDFjs();
        this.edits = [];
        this.resetHistory();   // the saved file is the new baseline
        await this.renderCurrentPage();
        this.showStatus('Saved! Your edited PDF has been downloaded.', 'success');
      }
    } catch (error) {
      console.error('Save error:', error);
      this.showStatus(`Failed to save: ${error.message}`, 'error');
    }
  }

  /**
   * Fallback save for PDFs pdf-lib can't edit (e.g. encrypted ones): render each page
   * with PDF.js, paint the pending edits on top, and rebuild a new PDF from those page
   * images. Always works, but the result is image-based (text is no longer selectable).
   */
  async flattenToPdfBytes(edits) {
    const out = await PDFDocument.create();
    const S = 2; // render scale for crisp output

    for (let p = 0; p < this.pdfJsDoc.numPages; p++) {
      const page = await this.pdfJsDoc.getPage(p + 1);
      const viewport = page.getViewport({ scale: S });
      const cnv = document.createElement('canvas');
      cnv.width = viewport.width;
      cnv.height = viewport.height;
      const cx = cnv.getContext('2d');
      cx.fillStyle = '#ffffff';
      cx.fillRect(0, 0, cnv.width, cnv.height);
      await page.render({ canvasContext: cx, viewport }).promise;

      // Paint this page's edits (coords are PDF points, top-left origin -> * S px).
      edits.filter(e => e.pageIndex === p).forEach(e => {
        if (e.kind === 'erase' || (e.redact !== false && e.top != null && e.bottom != null)) {
          cx.fillStyle = '#ffffff';
          cx.fillRect((e.x - 2) * S, (e.top - 1) * S,
            ((e.right - e.x) + 4) * S, ((e.bottom - e.top) + 2) * S);
        }
        const text = (e.newText || '').replace(/[\r\n]+/g, ' ');
        if (text) {
          cx.fillStyle = '#000000';
          cx.textBaseline = 'alphabetic';
          const fs = (e.fontSize || 12) * S;
          const fam = e.style === 'signature'
            ? '"Snell Roundhand","Apple Chancery","Brush Script MT",cursive'
            : (e.serif ? '"Times New Roman",Times,serif' : 'Arial,Helvetica,sans-serif');
          const weight = e.bold ? 'bold ' : '';
          const slant = (e.italic || e.style === 'signature') ? 'italic ' : '';
          cx.font = `${slant}${weight}${fs}px ${fam}`;
          cx.fillText(text, e.x * S, e.baseline * S);
        }
      });

      const img = await out.embedPng(cnv.toDataURL('image/png'));
      const pv = page.getViewport({ scale: 1 });
      const pg = out.addPage([pv.width, pv.height]);
      pg.drawImage(img, { x: 0, y: 0, width: pv.width, height: pv.height });
    }

    return out.save();
  }

  /**
   * Apply all edits to the PDF in the browser using pdf-lib and return the new bytes.
   * Coordinates in `edits` are PDF points with a TOP-LEFT origin; pdf-lib uses a
   * BOTTOM-LEFT origin, so y is flipped with pageHeight.
   *  - replace edits (redact !== false): cover the original line with a white box, then
   *    draw the new text at the original baseline.
   *  - insert edits (added text / signatures): just draw the text (signatures in italic).
   */
  async applyEditsWithPdfLib(originalBytes, edits) {
    // Many PDFs carry empty-password "permissions" encryption; load them anyway.
    const pdfDoc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
    const sans = {
      regular: await pdfDoc.embedFont(StandardFonts.Helvetica),
      bold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
      italic: await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
    };
    const serif = {
      regular: await pdfDoc.embedFont(StandardFonts.TimesRoman),
      bold: await pdfDoc.embedFont(StandardFonts.TimesRomanBold),
      italic: await pdfDoc.embedFont(StandardFonts.TimesRomanItalic),
      boldItalic: await pdfDoc.embedFont(StandardFonts.TimesRomanBoldItalic),
    };
    const pages = pdfDoc.getPages();
    const white = rgb(1, 1, 1);
    const black = rgb(0, 0, 0);

    // Match the original line's family (serif→Times, sans→Helvetica) and weight/style.
    const pickFont = (e) => {
      if (e.style === 'signature') return sans.italic;
      const fam = e.serif ? serif : sans;
      if (e.bold && e.italic) return fam.boldItalic;
      if (e.bold) return fam.bold;
      if (e.italic) return fam.italic;
      return fam.regular;
    };

    for (const edit of edits) {
      const page = pages[edit.pageIndex];
      if (!page) continue;
      const ph = page.getHeight();
      const size = edit.fontSize || 12;
      const font = pickFont(edit);
      const text = this.sanitizeForStandardFont((edit.newText || '').replace(/[\r\n]+/g, ' '));

      // Replace: cover the original line first.
      if (edit.redact !== false && edit.top != null && edit.bottom != null) {
        page.drawRectangle({
          x: edit.x - 2,
          y: ph - edit.bottom - 1,
          width: (edit.right - edit.x) + 4,
          height: (edit.bottom - edit.top) + 2,
          color: white,
        });
      }

      if (!text) continue;
      try {
        page.drawText(text, { x: edit.x, y: ph - edit.baseline, size, font, color: black });
      } catch (e) {
        // Last-resort: strip anything the standard font still can't encode.
        const safe = text.replace(/[^\x20-\x7E]/g, '?');
        page.drawText(safe, { x: edit.x, y: ph - edit.baseline, size, font, color: black });
      }
    }

    return pdfDoc.save();
  }

  /**
   * Keep only characters the built-in Helvetica (WinAnsi) can render — Latin-1 plus the
   * common typographic extras (• – — ' ' " " … € ™). Anything else becomes '?'.
   */
  sanitizeForStandardFont(s) {
    const extras = new Set(['•', '–', '—', '‘', '’', '“', '”', '…', '€', '™', '©', '®',
      'š', 'ž', 'Š', 'Ž', 'Œ', 'œ', 'Ÿ', 'ƒ', '†', '‡', '‰', '‹', '›']);
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || extras.has(ch)) out += ch;
      else out += '?';
    }
    return out;
  }

  /**
   * Remove pending (unsaved) added text, signatures and erase boxes, then re-render.
   * Text edits made in Edit mode, and items already saved into the PDF, are kept.
   */
  clearSignature() {
    const before = this.edits.length;
    // Drop inserts (redact === false) and erase boxes; keep line text edits.
    this.edits = this.edits.filter(e => e.redact !== false && e.kind !== 'erase');
    const removed = before - this.edits.length;
    if (removed > 0) {
      this.commitHistory();
      this.renderCurrentPage();
      this.showStatus(`Removed ${removed} unsaved item(s)`, 'info');
    } else {
      this.showStatus('Nothing to clear', 'info');
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
