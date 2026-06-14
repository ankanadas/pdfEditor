import { EditorController } from './core/EditorController.js';
import { PDFBackendService } from './services/pdfBackendService.js';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';

// Self-host the PDF.js worker (bundled by webpack) instead of loading it from a CDN.
// No external network request is made, so the app works fully offline and never reaches
// out to a third party while handling your document.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.js',
  import.meta.url
).toString();

// Largest PDF a user may open/edit. Change this single number to adjust the limit.
// Note: very large PDFs are slower to render/save since everything runs in the browser.
const MAX_FILE_MB = 100;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

class PDFEditorApp {
  constructor() {
    this.controller = new EditorController();
    this.pageViews = [];   // one {pageNum, page, viewport, canvas, ctx, wrapper} per page
    this.currentPage = 0;  // page currently in view (for the indicator / page nav)
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
      this.openSignPad();   // opens the Draw / Type / Image dialog
    });

    document.getElementById('eraseModeBtn')?.addEventListener('click', () => {
      this.setMode('erase');
    });

    document.getElementById('stampModeBtn')?.addEventListener('click', () => {
      this.setMode('stamp');
    });
    // Stamp picker chips: choose which stamp to drop on the next page click.
    this.activeStamp = null;
    document.querySelectorAll('.stamp-chip').forEach(chip => {
      chip.addEventListener('click', () =>
        this.selectStampChip(chip, { label: chip.dataset.label, color: chip.dataset.color }));
    });
    // Upload a custom stamp image -> adds a selectable thumbnail chip.
    document.getElementById('customStampInput')?.addEventListener('change', (e) => this.onCustomStampUpload(e));

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

    // Per-page canvas click & erase-drag listeners are attached in buildPages().
    // Global move/up so an erase drag keeps tracking outside the page canvas.
    window.addEventListener('mousemove', (e) => this.onEraseMove(e));
    window.addEventListener('mouseup', (e) => this.onEraseEnd(e));

    // Track which page is in view (for the page indicator) as the stage scrolls.
    document.getElementById('stage')?.addEventListener('scroll', () => this.updateCurrentPageFromScroll());

    // Add-text bold/italic toggles
    document.getElementById('addBold')?.addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));
    document.getElementById('addItalic')?.addEventListener('click', (e) => e.currentTarget.classList.toggle('on'));

    // Signature dialog (Draw / Type / Image)
    document.getElementById('signPadClear')?.addEventListener('click', () => this.signPadClear());
    document.getElementById('signPadCancel')?.addEventListener('click', () => this.closeSignPad());
    document.getElementById('signPadAdd')?.addEventListener('click', () => this.signPadAdd());
    this.initSignatureDialog();

  }

  previousPage() { this.scrollToPage(this.currentPage - 1); }
  nextPage() { this.scrollToPage(this.currentPage + 1); }

  scrollToPage(i) {
    const pv = this.pageViews[i];
    if (!pv) return;
    pv.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.currentPage = i;
    this.updatePageInfo();
  }

  /** Update the current-page indicator from the scroll position. */
  updateCurrentPageFromScroll() {
    const stage = document.getElementById('stage');
    if (!stage || !this.pageViews.length) return;
    const mid = stage.scrollTop + stage.clientHeight / 2;
    let best = 0;
    for (let i = 0; i < this.pageViews.length; i++) {
      if (this.pageViews[i].wrapper.offsetTop <= mid) best = i;
    }
    if (best !== this.currentPage) { this.currentPage = best; this.updatePageInfo(); }
  }

  updatePageInfo() {
    const pageInfo = document.getElementById('pageInfo');
    if (pageInfo && this.pdfJsDoc) {
      pageInfo.textContent = `Page ${this.currentPage + 1} of ${this.pdfJsDoc.numPages}`;
    }
  }

  /** Enable all the tools/controls that require a loaded PDF. */
  enableUiAfterLoad() {
    ['saveBtn', 'textInput', 'prevPageBtn', 'nextPageBtn',
     'editModeBtn', 'textModeBtn', 'signatureModeBtn', 'eraseModeBtn', 'stampModeBtn', 'clearSignatureBtn']
      .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
  }

  setupControllerEvents() {
    this.controller.on('loaded', (data) => {
      console.log('PDF loaded event received:', data);
      this.showStatus(`PDF loaded successfully! ${data.pageCount} page(s)`, 'success');
      this.updatePageInfo();
      this.enableUiAfterLoad();
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
        // Keep whitespace-only fragments too: many PDFs emit spaces as their own items,
        // and dropping them is what made tightly-set text lose its word breaks on edit.
        .filter(item => item.str && item.str.length > 0)
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

    // Opening a new PDF replaces the current one — warn if there are unsaved edits.
    if (this.edits.length > 0) {
      const proceed = await this.confirmDialog(
        'Opening a new PDF will discard your unsaved edits. To revert changes instead, use Undo.'
      );
      if (!proceed) { event.target.value = ''; return; }
    }

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
        
        // Manually enable controls since controller won't emit 'loaded' event
        this.enableUiAfterLoad();
        this.showStatus(`PDF loaded successfully! ${this.pdfJsDoc.numPages} page(s)`, 'success');
      }
      
      // Extract text geometry with PDF.js — the same engine that renders the canvas —
      // so the editable overlays align exactly. The backend is used only when saving.
      await this.extractTextFromPDFjs();

      this.currentPage = 0;
      await this.buildPages();
      document.getElementById('stage')?.scrollTo({ top: 0 });

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

  /**
   * Build the stacked, scrollable view: one canvas + overlay wrapper per page.
   * Called when a document is (re)loaded. Preserves nothing — full DOM rebuild.
   */
  async buildPages() {
    if (!this.pdfJsDoc) return;
    const container = document.getElementById('canvasContainer');
    if (!container) return;
    container.innerHTML = '';
    this.pageViews = [];

    for (let i = 0; i < this.pdfJsDoc.numPages; i++) {
      const page = await this.pdfJsDoc.getPage(i + 1);
      const viewport = page.getViewport({ scale: this.scale });

      const wrapper = document.createElement('div');
      wrapper.className = 'page-wrap';
      wrapper.dataset.page = String(i);

      const canvas = document.createElement('canvas');
      canvas.className = 'page-canvas';
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      wrapper.appendChild(canvas);
      container.appendChild(wrapper);

      const pv = { pageNum: i, page, viewport, canvas, ctx: canvas.getContext('2d'), wrapper };
      canvas.addEventListener('click', (e) => this.handleCanvasClick(e, pv));
      canvas.addEventListener('mousedown', (e) => this.onEraseStart(e, pv));
      this.pageViews.push(pv);
    }

    this.pageWidth = this.pageViews[0] ? this.pageViews[0].page.view[2] : 612;
    this.pageHeight = this.pageViews[0] ? this.pageViews[0].page.view[3] : 792;
    this.currentPage = 0;
    await this.refresh();
    this.updatePageInfo();
  }

  /**
   * Re-paint every page's bitmap and rebuild its overlays in place (keeps the DOM and
   * scroll position). Use for edits / mode changes. Alias: renderCurrentPage().
   */
  async refresh() {
    if (!this.pageViews.length) return;
    if (this._refreshing) { this._refreshPending = true; return; }
    this._refreshing = true;
    try {
      do {
        this._refreshPending = false;
        for (const pv of this.pageViews) {
          this.clearPageOverlays(pv);
          await pv.page.render({ canvasContext: pv.ctx, viewport: pv.viewport }).promise;
          this.drawPendingErases(pv);
          if (this.mode !== 'edit') this.drawPendingLineEdits(pv);  // edit mode shows them in boxes
          this.createInsertOverlays(pv);
          if (this.mode === 'edit') this.createEditableTextBoxes(pv);
        }
      } while (this._refreshPending);
    } catch (error) {
      console.error('Error rendering pages:', error);
    } finally {
      this._refreshing = false;
    }
  }

  // Back-compat: existing call sites use renderCurrentPage() to mean "refresh overlays".
  renderCurrentPage() { return this.refresh(); }

  clearPageOverlays(pv) {
    pv.wrapper.querySelectorAll('.editable-text-box, .insert-overlay').forEach(el => el.remove());
  }

  /**
   * Overlay an editable box on EACH line of text. Every box sits exactly on its original
   * line (same left, baseline and size) and edits that line in place. Only the lines the
   * user actually changes are tracked, so saving leaves all other text untouched.
   */
  createEditableTextBoxes(pv) {
    const pageTextItems = this.extractedTextItems.filter(item => item.pageIndex === pv.pageNum);
    if (pageTextItems.length === 0) return;

    const canvasWrapper = pv.wrapper;
    // The canvas may be displayed smaller than its intrinsic pixels (max-width:100%).
    const displayScale = (pv.canvas.clientWidth || pv.canvas.width) / pv.canvas.width;

    const lines = this.groupTextItemsByLine(pageTextItems);

    // Erase the original text from the canvas (white over each line) while leaving
    // images/graphics intact, so the editable boxes are the only visible text.
    pv.ctx.save();
    pv.ctx.setTransform(1, 0, 0, 1, 0, 0);   // device pixels, regardless of render state
    pv.ctx.fillStyle = '#ffffff';
    lines.forEach((line) => {
      pv.ctx.fillRect(line.left - 2, line.top - 2, (line.right - line.left) + 6, (line.bottom - line.top) + 4);
    });
    pv.ctx.restore();

    lines.forEach((line) => {
      const div = document.createElement('div');
      div.contentEditable = 'true';
      div.className = 'editable-text-box';
      // If this line was already edited, show the edited text (so edits persist on re-render).
      const pending = this.findLineEdit(line);
      const shownText = pending ? pending.newText : line.text;
      div.dataset.originalText = shownText;
      div.textContent = shownText;

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
    });
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
    const startSegment = (item) => {
      currentLine = {
        text: item.text,
        left: item.left, right: item.right, baseline: item.baseline,
        top: item.top, bottom: item.bottom, height: item.height,
        fontSizePx: item.fontSizePx, fontName: item.fontName,
        pageIndex: item.pageIndex, items: [item],
      };
      lines.push(currentLine);
    };

    sorted.forEach(item => {
      const isSpace = !item.text.trim();
      const tol = Math.max(3, item.height * 0.4);
      const sameRow = currentLine && Math.abs(item.baseline - currentLine.baseline) <= tol;
      const gap = sameRow ? item.left - currentLine.right : 0;
      // A gap far wider than the text is a COLUMN separator (e.g. a right-aligned date or
      // "GPA: …"). Keep each column as its own segment/box so editing one doesn't reflow the
      // others and right-aligned items stay in place.
      const columnBreak = sameRow && !isSpace && gap > item.height * 1.8;

      if (!sameRow || columnBreak) {
        if (isSpace) return;            // never start a segment on a stray space
        startSegment(item);
        return;
      }

      // Same segment: keep the PDF's own spaces (whitespace fragments are preserved during
      // extraction) and only synthesise a space across a small positional gap.
      if (isSpace) {
        if (!/\s$/.test(currentLine.text)) currentLine.text += ' ';
        return;
      }
      const endSp = /\s$/.test(currentLine.text);
      const startSp = /^\s/.test(item.text);
      const needSpace = !endSp && !startSp && gap > item.height * 0.18;
      currentLine.text += (needSpace ? ' ' : '') + item.text;
      currentLine.left = Math.min(currentLine.left, item.left);
      currentLine.right = Math.max(currentLine.right, item.right);
      currentLine.top = Math.min(currentLine.top, item.top);
      currentLine.bottom = Math.max(currentLine.bottom, item.bottom);
      currentLine.height = Math.max(currentLine.height, item.height);
      currentLine.items.push(item);
    });

    // Tidy each reconstructed segment and drop any that ended up being only whitespace.
    lines.forEach(line => { line.text = line.text.replace(/\s+/g, ' ').trim(); });
    const realLines = lines.filter(line => line.text.length > 0);
    realLines.forEach(line => this.finalizeLineStyle(line));
    return realLines;
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
      if (!(it.text || '').trim()) continue;   // ignore space-only fragments for font sizing
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
    const container = document.getElementById('canvasContainer');
    if (container) container.querySelectorAll('.editable-text-box').forEach(el => el.remove());
    this.editableTextBoxes = [];
    this.activeEditBox = null;
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
    const stampBtn = document.getElementById('stampModeBtn');

    // Highlight the active tool and expose the mode on <body> so the UI (CSS) can
    // show the relevant inputs / cursor for that tool.
    [textBtn, editBtn, sigBtn, eraseBtn, stampBtn].forEach(btn => btn && btn.classList.remove('active'));
    document.body.dataset.mode = mode || '';

    if (mode === 'text') {
      textBtn.classList.add('active');
      document.getElementById('textInput').focus();
    } else if (mode === 'edit') {
      editBtn.classList.add('active');
    } else if (mode === 'erase') {
      if (eraseBtn) eraseBtn.classList.add('active');
    } else if (mode === 'stamp') {
      if (stampBtn) stampBtn.classList.add('active');
    }

    // Rebuild overlays for the new mode (edit boxes vs. painted edits) on every page.
    if (previousMode !== mode) this.refresh();
    this.updateModeIndicator();
  }

  updateModeIndicator() {
    const indicator = document.getElementById('modeIndicator');
    if (!this.controller.isLoaded) {
      indicator.textContent = 'No PDF loaded';
      indicator.classList.remove('active');
    } else if (this.mode === 'text') {
      indicator.textContent = 'Add Text';
      indicator.classList.add('active');
    } else if (this.mode === 'edit') {
      indicator.textContent = 'Editing Text';
      indicator.classList.add('active');
    } else if (this.mode === 'erase') {
      indicator.textContent = 'Erase';
      indicator.classList.add('active');
    } else if (this.mode === 'stamp') {
      indicator.textContent = 'Stamp';
      indicator.classList.add('active');
    } else {
      indicator.textContent = 'Pick a tool';
      indicator.classList.remove('active');
    }
  }

  handleCanvasClick(event, pv) {
    if (!this.controller.isLoaded) {
      this.showStatus('Open a PDF first.', 'error');
      return;
    }
    if (!this.mode) {
      this.showStatus('Pick a tool on the left first — Edit, Add, or Sign — then click the page.', 'error');
      return;
    }
    if (this.mode === 'edit') return;  // edit mode is handled by the per-line boxes

    // Map the click to that page's intrinsic canvas pixels (handles CSS scaling), then
    // to PDF points (top-left origin) — the coordinate space used when saving.
    const rect = pv.canvas.getBoundingClientRect();
    const toIntrinsic = pv.canvas.width / rect.width;
    const xPt = ((event.clientX - rect.left) * toIntrinsic) / this.scale;
    const clickYPt = ((event.clientY - rect.top) * toIntrinsic) / this.scale;

    if (this.mode === 'text') {
      const text = document.getElementById('textInput').value.trim();
      if (!text) { this.showStatus('Type the text to add first', 'error'); return; }
      const fontSize = parseInt(document.getElementById('fontSize').value, 10) || 14;
      const opts = {
        fontFamily: document.getElementById('addFont')?.value || 'sans',
        bold: document.getElementById('addBold')?.classList.contains('on'),
        italic: document.getElementById('addItalic')?.classList.contains('on'),
      };
      this.placeInsert(xPt, clickYPt, text, fontSize, 'text', opts, pv.pageNum);
      this.showStatus(`Added "${text}" — click Save PDF to keep it`, 'success');
      document.getElementById('textInput').value = '';
    } else if (this.mode === 'stamp') {
      if (!this.activeStamp) { this.showStatus('Pick a stamp (Approved, Reject, …) first', 'error'); return; }
      this.placeStamp(xPt, clickYPt, pv);
    }
    // Signatures are added via the Sign dialog (drawn/typed/image), not by clicking.
  }

  /** Mark a stamp chip (preset or custom) as the selected stamp. */
  selectStampChip(chip, stamp) {
    this.activeStamp = stamp;
    document.querySelectorAll('.stamp-chip').forEach(c => c.classList.toggle('active', c === chip));
    const name = stamp.label || 'Custom';
    this.showStatus(`${name} stamp selected — click on the page to place it`, 'success');
  }

  /** Read an uploaded image, add it as a selectable thumbnail chip, and select it. */
  onCustomStampUpload(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';   // allow re-uploading the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const ratio = await this.imageRatio(dataUrl);
      const chips = document.getElementById('stampChips');
      if (!chips) return;

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'stamp-chip custom';
      const img = document.createElement('img');
      img.src = dataUrl; img.alt = 'Custom stamp'; img.draggable = false;
      chip.appendChild(img);
      const del = document.createElement('span');
      del.className = 'stamp-chip-x'; del.textContent = '×'; del.title = 'Remove this stamp';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.activeStamp && this.activeStamp.dataUrl === dataUrl) this.activeStamp = null;
        chip.remove();
      });
      chip.appendChild(del);

      const stamp = { label: 'Custom', dataUrl, ratio };
      chip.addEventListener('click', () => this.selectStampChip(chip, stamp));
      chips.appendChild(chip);
      this.selectStampChip(chip, stamp);
    };
    reader.readAsDataURL(file);
  }

  /** Drop the currently-selected stamp (preset or uploaded) centred on the clicked point. */
  placeStamp(xPt, topPt, pv) {
    const s = this.activeStamp;
    let dataUrl, ratio;
    if (s.dataUrl) {                       // uploaded custom stamp — use the image as-is
      dataUrl = s.dataUrl;
      ratio = s.ratio || 0.4;
    } else {                               // preset stamp — rasterise it
      const out = this.renderStamp(s.label, s.color);
      dataUrl = out.dataUrl;
      ratio = out.h / out.w;
    }
    const pageWpt = pv.canvas.width / this.scale;
    const wPt = Math.min(150, pageWpt - 40);
    const hPt = wPt * ratio;

    this.edits.push({
      pageIndex: pv.pageNum,
      redact: false,
      kind: 'image',
      dataUrl,
      x: Math.max(0, Math.min(xPt - wPt / 2, pageWpt - wPt)),
      top: Math.max(0, topPt - hPt / 2),
      width: wPt,
      height: hPt,
    });
    this.commitHistory();
    this.refresh();
    this.showStatus(`${s.label || 'Custom'} stamp added — drag to reposition, resize with the corner`, 'success');
  }

  /**
   * Rasterise a preset stamp (double-ruled rounded box + bold uppercase label, slightly
   * tilted like a rubber stamp) to a trimmed transparent PNG, reusing the image-overlay
   * save pipeline used by signatures.
   */
  renderStamp(label, color) {
    const text = (label || '').toUpperCase();
    const fontPx = 56, padX = 26, padY = 14, outerLW = 5, innerLW = 2.5, radius = 12;
    const angle = -7 * Math.PI / 180;

    const meas = document.createElement('canvas').getContext('2d');
    meas.font = `800 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
    const boxW = Math.ceil(meas.measureText(text).width) + padX * 2;
    const boxH = fontPx + padY * 2;

    // Square canvas large enough to hold the tilted box plus stroke/margin.
    const size = Math.ceil(Math.hypot(boxW, boxH)) + 40;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const cx = c.getContext('2d');
    cx.translate(size / 2, size / 2);
    cx.rotate(angle);
    cx.strokeStyle = color;
    cx.fillStyle = color;
    this._roundRectPath(cx, -boxW / 2, -boxH / 2, boxW, boxH, radius);
    cx.lineWidth = outerLW; cx.stroke();
    this._roundRectPath(cx, -boxW / 2 + 6, -boxH / 2 + 6, boxW - 12, boxH - 12, Math.max(4, radius - 5));
    cx.lineWidth = innerLW; cx.stroke();
    cx.font = `800 ${fontPx}px Arial, "Helvetica Neue", sans-serif`;
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(text, 0, 2);

    return this.trimCanvas(c) || { dataUrl: c.toDataURL('image/png'), w: size, h: size };
  }

  /** Trace a rounded-rectangle path (fallback for canvases without ctx.roundRect). */
  _roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * Queue an inserted item (added text or a typed signature) at a click point. The click
   * is treated as the top-left of the text, so the baseline sits ~one ascent below it.
   * It is drawn as a preview now and inserted for real by the backend on Save.
   */
  placeInsert(xPt, topPt, text, fontSize, style, opts = {}, pageNum = this.currentPage) {
    this.edits.push({
      pageIndex: pageNum,
      redact: false,            // nothing to remove — this is an insert, not a replace
      style: style,             // 'text' or 'signature'
      x: xPt,
      baseline: topPt + fontSize * 0.8,
      fontSize: fontSize,
      newText: text,
      fontFamily: opts.fontFamily || 'sans',  // 'sans' | 'serif' | 'mono'
      bold: !!opts.bold,
      italic: !!opts.italic
    });
    this.commitHistory();
    this.renderCurrentPage();
  }

  clearInsertOverlays() {
    const container = document.getElementById('canvasContainer');
    if (container) container.querySelectorAll('.insert-overlay').forEach(el => el.remove());
    this.insertOverlays = [];
  }

  /** Move / proportional-resize / delete for a drawn-signature image overlay. */
  wireImageOverlay(box, del, handle, rotate, edit, unit) {
    const commit = () => {
      edit.x = parseFloat(box.style.left) / unit;
      edit.top = parseFloat(box.style.top) / unit;
      edit.width = parseFloat(box.style.width) / unit;
      edit.height = parseFloat(box.style.height) / unit;
      this.commitHistory();
    };
    // Rotate: drag the top handle around the box centre. Shift snaps to 15°.
    rotate.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const r = box.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;  // centre is invariant under rotation
      const move = (ev) => {
        let deg = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        deg = Math.round(deg);
        edit.rotation = deg;
        box.style.transform = `rotate(${deg}deg)`;
      };
      const up = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        this.commitHistory();
        this.showStatus(`Rotated to ${edit.rotation || 0}°`, 'success');
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    box.addEventListener('mousedown', (e) => {
      if (e.target === del || e.target === handle || e.target === rotate) return;
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX, sy = e.clientY;
      const ox = parseFloat(box.style.left), oy = parseFloat(box.style.top);
      const move = (ev) => {
        box.style.left = (ox + ev.clientX - sx) + 'px';
        box.style.top = (oy + ev.clientY - sy) + 'px';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); commit(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sx = e.clientX;
      const w0 = parseFloat(box.style.width), h0 = parseFloat(box.style.height);
      const ar = h0 / w0;
      const move = (ev) => {
        const w = Math.max(24, w0 + (ev.clientX - sx));
        box.style.width = w + 'px';
        box.style.height = (w * ar) + 'px';
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); commit(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    del.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    del.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.edits = this.edits.filter(x => x !== edit);
      this.commitHistory();
      this.renderCurrentPage();
    });
  }

  // ----- Signature dialog: Draw / Type / Image -----
  // Fonts offered on the Type tab. Each typed signature is rasterised to an image in the
  // chosen font, so the saved result looks EXACTLY like the preview (no font substitution).
  static get SIGN_FONTS() {
    return [
      '"Snell Roundhand","Savoye LET",cursive',
      '"Brush Script MT","Bradley Hand",cursive',
      '"Apple Chancery","Segoe Script",cursive',
      '"Savoye LET","Snell Roundhand",cursive',
    ];
  }

  initSignatureDialog() {
    this.signTab = 'draw';
    this.signColor = '#111318';
    this.signPenWidth = 2.8;
    this.signTypeFont = PDFEditorApp.SIGN_FONTS[0];
    this.signImageData = null;

    // Tabs
    document.querySelectorAll('.sign-tab').forEach(tab => {
      tab.addEventListener('click', () => this.setSignTab(tab.dataset.tab));
    });
    // Colours
    document.querySelectorAll('.sign-color').forEach(btn => {
      btn.addEventListener('click', () => {
        this.signColor = btn.dataset.color;
        document.querySelectorAll('.sign-color').forEach(b => b.classList.toggle('active', b === btn));
        this.renderSignFontList();   // recolour the type previews
      });
    });
    // Pen width (Draw tab)
    document.querySelectorAll('.sign-width').forEach(btn => {
      btn.addEventListener('click', () => {
        this.signPenWidth = parseFloat(btn.dataset.width);
        document.querySelectorAll('.sign-width').forEach(b => b.classList.toggle('active', b === btn));
      });
    });
    // Type input -> refresh font previews
    document.getElementById('signTypeInput')?.addEventListener('input', () => this.renderSignFontList());
    // Image upload
    document.getElementById('signImageInput')?.addEventListener('change', (e) => this.onSignImage(e));

    this.initDrawPad();
    this.renderSignFontList();
  }

  initDrawPad() {
    const c = document.getElementById('signPadCanvas');
    if (!c) return;
    const ctx = c.getContext('2d');
    this._padHasInk = false;
    let drawing = false;
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      return { x: cx * (c.width / r.width), y: cy * (c.height / r.height) };
    };
    const start = (e) => { e.preventDefault(); drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const p = pos(e);
      ctx.strokeStyle = this.signColor || '#111318';
      ctx.lineWidth = this.signPenWidth || 2.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.lineTo(p.x, p.y); ctx.stroke();
      this._padHasInk = true;
    };
    const end = () => { drawing = false; };
    c.addEventListener('mousedown', start);
    c.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    c.addEventListener('touchstart', start, { passive: false });
    c.addEventListener('touchmove', move, { passive: false });
    c.addEventListener('touchend', end);
  }

  setSignTab(tab) {
    this.signTab = tab;
    document.querySelectorAll('.sign-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.sign-panel').forEach(p => { p.hidden = (p.dataset.panel !== tab); });
  }

  /** Render the Type tab's font choices, previewing the entered name in each font/colour. */
  renderSignFontList() {
    const list = document.getElementById('signFontList');
    if (!list) return;
    const name = (document.getElementById('signTypeInput')?.value || '').trim();
    list.innerHTML = '';
    PDFEditorApp.SIGN_FONTS.forEach((font) => {
      const opt = document.createElement('div');
      opt.className = 'sign-font' + (font === this.signTypeFont ? ' active' : '');
      opt.style.fontFamily = font;
      opt.style.color = this.signColor;
      if (name) opt.textContent = name;
      else { const ph = document.createElement('span'); ph.className = 'ph'; ph.textContent = 'Your name'; opt.appendChild(ph); }
      opt.addEventListener('click', () => {
        this.signTypeFont = font;
        list.querySelectorAll('.sign-font').forEach(el => el.classList.toggle('active', el === opt));
      });
      list.appendChild(opt);
    });
  }

  onSignImage(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.signImageData = reader.result;
      const img = document.getElementById('signImagePreview');
      const prompt = document.getElementById('signImagePrompt');
      if (img) { img.src = reader.result; img.hidden = false; }
      if (prompt) prompt.hidden = true;
    };
    reader.readAsDataURL(file);
  }

  openSignPad() {
    if (!this.controller.isLoaded) { this.showStatus('Open a PDF first', 'error'); return; }
    this.signPadClear();
    this.setSignTab('draw');
    document.getElementById('signPad')?.classList.add('open');
  }

  closeSignPad() {
    document.getElementById('signPad')?.classList.remove('open');
  }

  /** Branded yes/no dialog. Resolves true (proceed) or false (cancel). */
  confirmDialog(message) {
    return new Promise((resolve) => {
      const back = document.getElementById('confirmDialog');
      const msg = document.getElementById('confirmMessage');
      const ok = document.getElementById('confirmOk');
      const cancel = document.getElementById('confirmCancel');
      if (!back || !ok || !cancel) { resolve(window.confirm(message)); return; }
      msg.textContent = message;
      back.classList.add('open');
      const finish = (val) => {
        back.classList.remove('open');
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        resolve(val);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
    });
  }

  signPadClear() {
    const c = document.getElementById('signPadCanvas');
    if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    this._padHasInk = false;
    const ti = document.getElementById('signTypeInput'); if (ti) ti.value = '';
    this.signImageData = null;
    const img = document.getElementById('signImagePreview'); if (img) { img.hidden = true; img.src = ''; }
    const prompt = document.getElementById('signImagePrompt'); if (prompt) prompt.hidden = false;
    this.renderSignFontList();
  }

  async signPadAdd() {
    let dataUrl = null, ratio = 0.3;

    if (this.signTab === 'draw') {
      const c = document.getElementById('signPadCanvas');
      const trimmed = c && this._padHasInk ? this.trimCanvas(c) : null;
      if (!trimmed) { this.showStatus('Draw your signature first', 'error'); return; }
      dataUrl = trimmed.dataUrl; ratio = trimmed.h / trimmed.w;
    } else if (this.signTab === 'type') {
      const name = (document.getElementById('signTypeInput')?.value || '').trim();
      if (!name) { this.showStatus('Type your name first', 'error'); return; }
      const out = this.renderTypedSignature(name, this.signTypeFont, this.signColor);
      dataUrl = out.dataUrl; ratio = out.h / out.w;
    } else if (this.signTab === 'image') {
      if (!this.signImageData) { this.showStatus('Choose an image first', 'error'); return; }
      dataUrl = this.signImageData;
      ratio = await this.imageRatio(dataUrl);
    }
    if (!dataUrl) return;

    // Place on the page currently in view, centred-ish, ~180pt wide (keep aspect).
    const pv = this.pageViews[this.currentPage] || this.pageViews[0];
    const pageWpt = pv ? pv.canvas.width / this.scale : 612;
    const pageHpt = pv ? pv.canvas.height / this.scale : 792;
    const wPt = Math.min(180, pageWpt - 40);
    const hPt = wPt * ratio;

    this.edits.push({
      pageIndex: pv ? pv.pageNum : this.currentPage,
      redact: false,
      kind: 'image',
      dataUrl: dataUrl,
      x: Math.max(20, (pageWpt - wPt) / 2),
      top: Math.max(20, pageHpt * 0.45),
      width: wPt,
      height: hPt
    });
    this.commitHistory();
    this.closeSignPad();
    this.refresh();
    this.showStatus('Signature added — drag it into place, resize with the corner', 'success');
  }

  /** Rasterise typed text in a given font/colour to a trimmed transparent PNG. */
  renderTypedSignature(text, fontStack, color) {
    const fontPx = 80, pad = 24;
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = `${fontPx}px ${fontStack}`;
    const w = Math.max(1, Math.ceil(meas.measureText(text).width)) + pad * 2;
    const h = Math.ceil(fontPx * 1.6) + pad;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.font = `${fontPx}px ${fontStack}`;
    cx.fillStyle = color || '#111318';
    cx.textBaseline = 'middle';
    cx.fillText(text, pad, h / 2);
    const trimmed = this.trimCanvas(c) || { dataUrl: c.toDataURL('image/png'), w, h };
    return trimmed;
  }

  /** Natural height/width ratio of an image data-URL. */
  imageRatio(src) {
    return this.loadImage(src).then(im => (im.naturalHeight / im.naturalWidth) || 0.4).catch(() => 0.4);
  }

  /** Crop a canvas to its non-transparent content; returns a trimmed PNG data URL + size. */
  trimCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = 0, maxY = 0, found = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[(y * w + x) * 4 + 3] > 12) {
          found = true;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (!found) return null;
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    const tw = maxX - minX + 1, th = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = tw; out.height = th;
    out.getContext('2d').drawImage(canvas, minX, minY, tw, th, 0, 0, tw, th);
    return { dataUrl: out.toDataURL('image/png'), w: tw, h: th };
  }

  /** Load a data-URL into an HTMLImageElement (used by the flatten fallback). */
  loadImage(src) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });
  }

  /**
   * Render each pending insert (added text / signature) as a draggable, resizable overlay
   * so the user can move it into place and size it. Dragging updates the edit's position;
   * the resize handle changes its font size; the × button deletes it. All changes are
   * undoable and are written into the PDF (at the same spot) on Save.
   */
  createInsertOverlays(pv) {
    const wrap = pv.wrapper;
    if (!wrap) return;
    const ds = (pv.canvas.clientWidth || pv.canvas.width) / pv.canvas.width;
    const unit = this.scale * ds;  // PDF points -> displayed CSS px
    const inserts = this.edits.filter(e =>
      e.redact === false && e.pageIndex === pv.pageNum && (e.newText || e.kind === 'image'));

    inserts.forEach(edit => {
      // Drawn-signature image overlay
      if (edit.kind === 'image' && edit.dataUrl) {
        const box = document.createElement('div');
        box.className = 'insert-overlay insert-image';
        box.style.left = (edit.x * unit) + 'px';
        box.style.top = (edit.top * unit) + 'px';
        box.style.width = (edit.width * unit) + 'px';
        box.style.height = (edit.height * unit) + 'px';
        box.style.transform = `rotate(${edit.rotation || 0}deg)`;
        const img = document.createElement('img');
        img.src = edit.dataUrl;
        img.draggable = false;
        box.appendChild(img);
        const delI = document.createElement('div');
        delI.className = 'insert-del';
        delI.textContent = '×';
        const handleI = document.createElement('div');
        handleI.className = 'insert-handle';
        const rotateI = document.createElement('div');
        rotateI.className = 'insert-rotate';
        rotateI.title = 'Drag to rotate (hold Shift to snap to 15°)';
        box.appendChild(delI);
        box.appendChild(handleI);
        box.appendChild(rotateI);
        this.wireImageOverlay(box, delI, handleI, rotateI, edit, unit);
        wrap.appendChild(box);
        this.insertOverlays.push(box);
        return;
      }

      const fontPx = edit.fontSize * unit;
      const ascent = fontPx * 0.8;

      const div = document.createElement('div');
      div.className = 'insert-overlay';
      div.textContent = edit.newText;
      div.style.left = (edit.x * unit) + 'px';
      div.style.top = (edit.baseline * unit - ascent) + 'px';
      div.style.fontSize = fontPx + 'px';
      div.style.lineHeight = fontPx + 'px';
      if (edit.style === 'signature') {
        div.style.fontStyle = 'italic';
        div.style.fontWeight = 'normal';
        div.style.fontFamily = '"Snell Roundhand","Apple Chancery","Brush Script MT",cursive';
      } else {
        div.style.fontWeight = edit.bold ? 'bold' : 'normal';
        div.style.fontStyle = edit.italic ? 'italic' : 'normal';
        div.style.fontFamily = edit.fontFamily === 'serif' ? '"Times New Roman",Times,serif'
          : edit.fontFamily === 'mono' ? '"Courier New",Courier,monospace'
          : 'Arial,Helvetica,sans-serif';
      }

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
  drawPendingErases(pv) {
    const erases = this.edits.filter(e => e.kind === 'erase' && e.pageIndex === pv.pageNum);
    if (erases.length === 0) return;
    const ctx = pv.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#ffffff';
    erases.forEach(e => {
      ctx.fillRect(e.x * this.scale, e.top * this.scale,
        (e.right - e.x) * this.scale, (e.bottom - e.top) * this.scale);
    });
    ctx.restore();
  }

  /**
   * Draw pending line text-edits onto the canvas (white-cover the original line, then the
   * new text) so an edit stays visible in EVERY mode — not only inside the edit boxes.
   */
  drawPendingLineEdits(pv) {
    const S = this.scale;
    const list = this.edits.filter(e =>
      e.redact !== false && e.kind !== 'erase' && e.pageIndex === pv.pageNum &&
      e.top != null && e.newText != null);
    if (list.length === 0) return;
    const cx = pv.ctx;
    cx.save();
    cx.setTransform(1, 0, 0, 1, 0, 0);
    list.forEach(e => {
      cx.fillStyle = '#ffffff';
      cx.fillRect((e.x - 2) * S, (e.top - 1) * S, ((e.right - e.x) + 4) * S, ((e.bottom - e.top) + 2) * S);
      const text = (e.newText || '').replace(/[\r\n]+/g, ' ');
      if (!text) return;
      cx.fillStyle = '#000000';
      cx.textBaseline = 'alphabetic';
      const fs = (e.fontSize || 12) * S;
      const fam = e.serif ? '"Times New Roman",Times,serif' : 'Arial,Helvetica,sans-serif';
      const weight = e.bold ? 'bold ' : '';
      const slant = e.italic ? 'italic ' : '';
      cx.font = `${slant}${weight}${fs}px ${fam}`;
      cx.fillText(text, e.x * S, e.baseline * S);
    });
    cx.restore();
  }

  /** Find a pending line-edit that matches a given extracted line (by page + position). */
  findLineEdit(line) {
    const s = this.scale;
    const xPt = line.left / s, basePt = line.baseline / s;
    return this.edits.find(e =>
      e.redact !== false && e.kind !== 'erase' && e.pageIndex === line.pageIndex &&
      Math.abs(e.x - xPt) < 1.5 && Math.abs(e.baseline - basePt) < 1.5);
  }

  // ----- Erase tool (drag a rectangle to white-out content) -----
  onEraseStart(event, pv) {
    if (this.mode !== 'erase' || !this.controller.isLoaded) return;
    event.preventDefault();
    const rect = pv.canvas.getBoundingClientRect();
    this.eraseDrag = { startX: event.clientX, startY: event.clientY, rect, pv };
    const wrap = pv.wrapper;
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
    const pv = this.eraseDrag.pv;
    const x0 = this.eraseDrag.startX - r.left, y0 = this.eraseDrag.startY - r.top;
    const x1 = event.clientX - r.left, y1 = event.clientY - r.top;
    if (this.eraseSel) { this.eraseSel.remove(); this.eraseSel = null; }
    this.eraseDrag = null;

    const leftCss = Math.min(x0, x1), topCss = Math.min(y0, y1);
    const wCss = Math.abs(x1 - x0), hCss = Math.abs(y1 - y0);
    if (!pv || wCss < 4 || hCss < 4) return;  // ignore stray clicks

    // Displayed px -> that page's intrinsic canvas px -> PDF points (top-left origin).
    const toIntrinsic = pv.canvas.width / r.width;
    const xPt = (leftCss * toIntrinsic) / this.scale;
    const topPt = (topCss * toIntrinsic) / this.scale;
    const wPt = (wCss * toIntrinsic) / this.scale;
    const hPt = (hCss * toIntrinsic) / this.scale;

    this.edits.push({
      pageIndex: pv.pageNum,
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

      // Save strategy, best fidelity first:
      //  1) PyMuPDF backend — truly REMOVES replaced text (clean for copy/paste & ATS) and
      //     re-inserts in a matching Unicode font. Only used if the backend is reachable.
      //  2) pdf-lib (client-side) — covers the original with a white box + redraws (works
      //     offline / on static hosting, but leaves the old text hidden underneath).
      //  3) Flatten to an image PDF — last resort for encrypted PDFs pdf-lib can't open.
      let editedPdfBytes;
      let flattened = false;
      let viaBackend = false;
      try {
        if (await PDFBackendService.checkHealth()) {
          editedPdfBytes = await PDFBackendService.editPDF(this.originalFileData, this.edits);
          viaBackend = true;
        } else {
          editedPdfBytes = await this.applyEditsWithPdfLib(this.originalFileData, this.edits);
        }
      } catch (primaryErr) {
        console.warn('Primary save failed, falling back:', primaryErr);
        try {
          editedPdfBytes = await this.applyEditsWithPdfLib(this.originalFileData, this.edits);
        } catch (vectorErr) {
          console.warn('Client-side save failed, flattening to image PDF instead:', vectorErr);
          editedPdfBytes = await this.flattenToPdfBytes(this.edits);
          flattened = true;
        }
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
      } else if (viaBackend) {
        // The backend truly REMOVED the replaced text, so the saved file is clean. Reload it as
        // the new baseline so further edits build on the real (de-duplicated) result.
        this.originalFileData = editedPdfBytes;
        const loadingTask = pdfjsLib.getDocument({ data: editedPdfBytes.slice(0) });
        this.pdfJsDoc = await loadingTask.promise;
        await this.extractTextFromPDFjs();
        this.edits = [];
        this.resetHistory();
        await this.buildPages();
        this.showStatus('Saved! Text was cleanly replaced — selectable & ATS-safe.', 'success');
      } else {
        // Client-side white-box path: do NOT reload/re-extract. An edited line is only COVERED
        // by a white box (its original glyphs remain in the content stream), so re-extraction
        // would read both the hidden original and the new text and show garbled boxes. Each
        // save re-applies all edits to the pristine original, so staying put stays correct.
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
      for (const e of edits.filter(e => e.pageIndex === p)) {
        if (e.kind === 'image' && e.dataUrl) {
          const im = await this.loadImage(e.dataUrl);
          cx.drawImage(im, e.x * S, e.top * S, e.width * S, e.height * S);
          continue;
        }
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
          let fam;
          if (e.style === 'signature') fam = '"Snell Roundhand","Apple Chancery","Brush Script MT",cursive';
          else if (e.fontFamily === 'serif' || (e.fontFamily == null && e.serif)) fam = '"Times New Roman",Times,serif';
          else if (e.fontFamily === 'mono') fam = '"Courier New",Courier,monospace';
          else fam = 'Arial,Helvetica,sans-serif';
          const weight = e.bold ? 'bold ' : '';
          const slant = (e.italic || e.style === 'signature') ? 'italic ' : '';
          cx.font = `${slant}${weight}${fs}px ${fam}`;
          cx.fillText(text, e.x * S, e.baseline * S);
        }
      }

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
    const mono = {
      regular: await pdfDoc.embedFont(StandardFonts.Courier),
      bold: await pdfDoc.embedFont(StandardFonts.CourierBold),
      italic: await pdfDoc.embedFont(StandardFonts.CourierOblique),
      boldItalic: await pdfDoc.embedFont(StandardFonts.CourierBoldOblique),
    };
    const pages = pdfDoc.getPages();
    const white = rgb(1, 1, 1);
    const black = rgb(0, 0, 0);

    // Pick family (added text uses fontFamily; line edits use detected serif) + weight/style.
    const pickFont = (e) => {
      if (e.style === 'signature') return sans.italic;
      let fam = sans;
      if (e.fontFamily === 'serif' || (e.fontFamily == null && e.serif)) fam = serif;
      else if (e.fontFamily === 'mono') fam = mono;
      if (e.bold && e.italic) return fam.boldItalic;
      if (e.bold) return fam.bold;
      if (e.italic) return fam.italic;
      return fam.regular;
    };

    for (const edit of edits) {
      const page = pages[edit.pageIndex];
      if (!page) continue;
      const ph = page.getHeight();

      // Drawn-signature / stamp image: embed and place (top-left origin -> bottom-left).
      if (edit.kind === 'image' && edit.dataUrl) {
        const png = await pdfDoc.embedPng(edit.dataUrl);
        const w = edit.width, h = edit.height;
        const rot = edit.rotation || 0;
        if (!rot) {
          page.drawImage(png, { x: edit.x, y: ph - edit.top - h, width: w, height: h });
        } else {
          // pdf-lib rotates about the (x,y) anchor; offset it so the rotation is about the
          // image centre (matching the on-screen overlay). CSS rotates clockwise for +deg,
          // pdf-lib counter-clockwise, so negate the angle.
          const cx = edit.x + w / 2;
          const cy = ph - edit.top - h / 2;
          const rad = -rot * Math.PI / 180;
          const cos = Math.cos(rad), sin = Math.sin(rad);
          const ax = cx - (w / 2 * cos - h / 2 * sin);
          const ay = cy - (w / 2 * sin + h / 2 * cos);
          page.drawImage(png, { x: ax, y: ay, width: w, height: h, rotate: degrees(-rot) });
        }
        continue;
      }

      let size = edit.fontSize || 12;
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
      // The substituted standard font is often wider than the PDF's original font, which can
      // push an edited line off the right edge. Shrink the size just enough to fit the space
      // from the text's left edge to the page margin so edited lines never get cut off.
      const avail = page.getWidth() - edit.x - 4;
      if (avail > 8) {
        let w = 0;
        try { w = font.widthOfTextAtSize(text, size); } catch (e) { /* unencodable: handled below */ }
        if (w > avail) size = Math.max(4, size * (avail / w));
      }
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
   * "Discard": drop ALL unsaved changes (added text, signatures, erases, line edits),
   * reverting to the loaded PDF. Undoable. Items already saved into the file are kept.
   */
  clearSignature() {
    const n = this.edits.length;
    if (n === 0) { this.showStatus('Nothing to discard', 'info'); return; }
    // Discard ALL unsaved changes (added text, signatures, erases, edits). Undoable.
    this.edits = [];
    this.commitHistory();
    this.renderCurrentPage();
    this.showStatus(`Discarded ${n} unsaved change(s) — press Undo to bring them back`, 'info');
  }

  showStatus(message, type) {
    const status = document.getElementById('status');
    if (!status) return;
    const kind = type || 'info';

    // Build safely (message may contain user text): coloured icon + text.
    status.className = kind;
    status.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = kind === 'error' ? '!' : kind === 'success' ? '✓' : 'i';
    const span = document.createElement('span');
    span.textContent = message;
    status.append(icon, span);

    // Animate in; shake for errors so they grab attention.
    status.style.display = 'flex';
    void status.offsetWidth;
    status.classList.add('show');
    if (kind === 'error') { void status.offsetWidth; status.classList.add('shake'); }

    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      status.classList.remove('show', 'shake');
      setTimeout(() => { if (!status.classList.contains('show')) status.style.display = 'none'; }, 200);
    }, kind === 'error' ? 6000 : 4000);
  }
}

// Initialize the app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new PDFEditorApp();
});
